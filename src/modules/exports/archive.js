// archiver v8 is ESM-only and exports format classes, not the old factory function.
import { ZipArchive } from 'archiver';
import { csvHeader, csvRows } from './csv.js';
import { EXPORT_COLLECTIONS, EXPORT_SCHEMA_VERSION } from './manifest.js';
import Business from '../../models/Business.js';
import { ApiError } from '../../utils/ApiError.js';

const CURSOR_BATCH_SIZE = 500;

const README = (business, generatedAt) => `BillJi data export
==================

Business    ${business.businessName}
Generated   ${generatedAt.toISOString()}
Schema      v${EXPORT_SCHEMA_VERSION}

What is in here
---------------
csv/    One spreadsheet per record type. Open these in Excel, Google Sheets or
        LibreOffice. Line items live in their own sheet (invoice_items.csv,
        order_items.csv) and link back to the parent via invoiceId / orderId.
json/   The same records in their original shape, with nested fields intact.
        Use these if you are moving the data into another system.

manifest.json lists every file with its row count.

Notes
-----
- Amounts are plain numbers in the currency stored on each record (INR unless set
  otherwise). No thousands separators, no currency symbols.
- Dates are ISO 8601 UTC (2024-03-19T10:30:00.000Z).
- IDs are the internal record IDs. They are stable, so you can join the sheets on
  them (e.g. payments.customerId -> customers.customerId).
- Invoice PDFs are not included. Re-download any invoice from the app.
- Passwords, two-factor secrets, session tokens and invoice share links are
  deliberately excluded.

This archive contains your full business record. Treat it like your books.
`;

const filterFor = (entry, businessId) =>
  entry.scope === 'self' ? { _id: businessId } : { business: businessId };

const cursorFor = (entry, businessId) => {
  let query = entry.model
    .find(filterFor(entry, businessId))
    .select(entry.select)
    .sort(entry.sort || { _id: 1 })
    .lean();

  (entry.populate || []).forEach((populate) => {
    query = query.populate(populate);
  });

  return query.cursor({ batchSize: CURSOR_BATCH_SIZE });
};

// Serialises one manifest entry into its CSV and/or JSON text. Streams the cursor so
// only one batch of documents is materialised at a time.
const renderEntry = async (entry, businessId) => {
  const wantsCsv = Boolean(entry.csv);
  const wantsJson = entry.json !== false;
  const rowsFor = entry.rowsFor || ((doc) => [doc]);

  let csv = wantsCsv ? csvHeader(entry.csv) : '';
  const jsonParts = [];
  let rowCount = 0;
  let docCount = 0;

  for await (const doc of cursorFor(entry, businessId)) {
    docCount += 1;
    if (wantsJson) jsonParts.push(JSON.stringify(doc));
    if (wantsCsv) {
      const rows = rowsFor(doc);
      rowCount += rows.length;
      csv += csvRows(rows, entry.csv);
    }
  }

  return {
    csv: wantsCsv ? csv : null,
    json: wantsJson ? `[\n${jsonParts.join(',\n')}\n]\n` : null,
    // For line-item sheets the meaningful count is rows, not parent documents.
    count: wantsCsv ? rowCount : docCount
  };
};

/**
 * Builds every file that goes into the archive, as plain text.
 *
 * Pure: no storage, no DataExport row, no zipping — this is where all the behaviour
 * that matters lives (tenant scoping, field redaction, CSV shape), so the tests drive
 * this rather than unzipping a compressed buffer.
 *
 * ponytail: every file is held in memory at once. Fine at SMB scale (single-digit MB
 * for thousands of invoices). If archives approach ~100MB, append each entry into
 * archiver as it is rendered and switch the upload to @aws-sdk/lib-storage multipart.
 *
 * @param {string|import('mongoose').Types.ObjectId} businessId
 * @returns {Promise<{files: {name: string, content: string}[], counts: Record<string, number>, generatedAt: Date, business: object}>}
 */
export const buildExportFiles = async (businessId) => {
  const business = await Business.findById(businessId).lean();
  if (!business) throw new ApiError(404, 'Business not found');

  const generatedAt = new Date();
  const files = [];
  const counts = {};

  for (const entry of EXPORT_COLLECTIONS) {
    const rendered = await renderEntry(entry, businessId);
    counts[entry.name] = rendered.count;

    if (rendered.csv !== null) {
      files.push({ name: `csv/${entry.name}.csv`, content: rendered.csv, rows: rendered.count });
    }
    if (rendered.json !== null) {
      files.push({ name: `json/${entry.name}.json`, content: rendered.json, rows: rendered.count });
    }
  }

  const manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    business: {
      id: String(business._id),
      name: business.businessName,
      gstNumber: business.gstNumber || ''
    },
    counts,
    files: files.map((file) => ({ name: file.name, rows: file.rows }))
  };

  files.push({ name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  files.push({ name: 'README.txt', content: README(business, generatedAt) });

  return { files, counts, generatedAt, business };
};

/**
 * Zips the export files for one business.
 *
 * @param {string|import('mongoose').Types.ObjectId} businessId
 * @returns {Promise<{buffer: Buffer, counts: Record<string, number>, generatedAt: Date, business: object}>}
 */
export const buildExportArchive = async (businessId) => {
  const { files, counts, generatedAt, business } = await buildExportFiles(businessId);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks = [];
  archive.on('data', (chunk) => chunks.push(chunk));

  const zipped = new Promise((resolve, reject) => {
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    // A warning means an entry was dropped, which would silently ship a partial
    // archive. Fail the job instead.
    archive.on('warning', reject);
  });

  files.forEach((file) => archive.append(file.content, { name: file.name, date: generatedAt }));
  await archive.finalize();

  return { buffer: await zipped, counts, generatedAt, business };
};
