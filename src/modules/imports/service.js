import Customer from '../../models/Customer.js';
import Product from '../../models/Product.js';
import StockMovement from '../../models/StockMovement.js';
import { parseCsvTable } from '../exports/csvReader.js';
import { ApiError } from '../../utils/ApiError.js';
import { DOC_BUILDERS, IMPORT_ENTITIES, guessColumnMap, readRow } from './fields.js';

// A whole import arrives in one JSON body, and express.json() caps that at 2mb (app.js).
// This is the row equivalent — enough for a shop's whole catalogue, small enough that the
// insert stays a single round trip. ponytail: one batch, chunk it if someone imports 50k.
export const MAX_IMPORT_ROWS = 2000;
const PREVIEW_ROWS = 20;

const entityFor = (type) => {
  const entity = IMPORT_ENTITIES[type];
  if (!entity) throw new ApiError(400, 'Unknown import type', { code: 'IMPORT_TYPE_UNKNOWN' });
  return entity;
};

const modelFor = (type) => (type === 'customers' ? Customer : Product);

/** Duplicate-detection value for a row: the primary key field, or the fallback if empty. */
const keyOf = (entity, values) => {
  const primary = (values[entity.duplicateKey] || '').trim();
  if (primary) return primary.toLowerCase();
  const fallback = entity.duplicateFallbackKey ? (values[entity.duplicateFallbackKey] || '').trim() : '';
  return fallback ? fallback.toLowerCase() : '';
};

/** Existing rows in this business keyed the same way, so a preview can say "will update". */
const existingKeys = async (businessId, entity, type) => {
  const keys = [entity.duplicateKey, entity.duplicateFallbackKey].filter(Boolean);
  const rows = await modelFor(type).find({ business: businessId }).select(keys.join(' ')).lean();
  const map = new Map();

  for (const row of rows) {
    for (const key of keys) {
      const value = (row[key] || '').trim().toLowerCase();
      // First key wins so a row is reported under the same key the importer matched on.
      if (value && !map.has(value)) map.set(value, row._id);
    }
  }

  return map;
};

/**
 * Parses the file and validates every row without writing anything.
 *
 * Returns each row's status — `create`, `update` (key already exists), `duplicate` (the key
 * repeats inside the file itself) or `error` — plus counts and the resolved column map. The
 * mobile screen renders this directly; commit runs the identical pass so the two can never
 * disagree about what a row means.
 */
export const analyzeImport = async ({ businessId, type, csv, columnMap: requestedMap }) => {
  const entity = entityFor(type);
  const { headers, rows } = parseCsvTable(csv || '');

  if (!headers.length) throw new ApiError(422, 'That file has no header row', { code: 'IMPORT_NO_HEADERS' });
  if (!rows.length) throw new ApiError(422, 'That file has headers but no data rows', { code: 'IMPORT_NO_ROWS' });
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ApiError(422, `Import up to ${MAX_IMPORT_ROWS} rows at a time — split the file and run it twice`, {
      code: 'IMPORT_TOO_MANY_ROWS'
    });
  }

  const columnMap = requestedMap && Object.keys(requestedMap).length ? requestedMap : guessColumnMap(entity, headers);
  const missing = entity.fields.filter((field) => field.required && !columnMap[field.name]).map((field) => field.label);
  if (missing.length) {
    throw new ApiError(422, `Tell us which column holds: ${missing.join(', ')}`, { code: 'IMPORT_MAP_INCOMPLETE', missing });
  }

  const existing = await existingKeys(businessId, entity, type);
  const seen = new Map();
  const analyzed = [];

  for (const row of rows) {
    const { values, errors } = readRow(entity, row, columnMap);
    const key = errors.length ? '' : keyOf(entity, values);

    let status = 'create';
    if (errors.length) status = 'error';
    else if (key && seen.has(key)) status = 'duplicate';
    else if (key && existing.has(key)) status = 'update';

    if (key && status !== 'duplicate') seen.set(key, row.line);

    analyzed.push({
      line: row.line,
      status,
      key,
      label: values.name || '',
      errors,
      // Only the rows that will actually be written carry a body — a 2000-row preview of
      // full documents is pointless payload.
      values: status === 'create' || status === 'update' ? values : undefined,
      existingId: status === 'update' ? String(existing.get(key)) : undefined,
      duplicateOfLine: status === 'duplicate' ? seen.get(key) : undefined
    });
  }

  const counts = analyzed.reduce(
    (totals, row) => ({ ...totals, [row.status]: totals[row.status] + 1 }),
    { create: 0, update: 0, duplicate: 0, error: 0 }
  );

  return {
    type,
    headers,
    columnMap,
    fields: entity.fields.map(({ name, label, required }) => ({ name, label, required: Boolean(required) })),
    duplicateLabel: entity.duplicateLabel,
    total: analyzed.length,
    counts,
    rows: analyzed,
    preview: analyzed.slice(0, PREVIEW_ROWS)
  };
};

// insertMany(ordered: false) keeps going past a bad doc but still throws at the end. The
// good docs are already in, and the thrown error carries them — hand those back so a single
// unique-index collision does not fail the whole import.
const insertAllowingPartial = async (model, docs) => {
  try {
    return await model.insertMany(docs, { ordered: false });
  } catch (error) {
    if (!error?.insertedDocs) throw error;
    return error.insertedDocs;
  }
};

const insertCustomers = async ({ businessId, actorId, rows }) => {
  const docs = rows.map((row) => ({ ...DOC_BUILDERS.customers(row.values), business: businessId, createdBy: actorId, updatedBy: actorId }));
  const created = await insertAllowingPartial(Customer, docs);
  return created.length;
};

const insertProducts = async ({ businessId, actorId, rows }) => {
  const docs = rows.map((row) => ({ ...DOC_BUILDERS.products(row.values), business: businessId, createdBy: actorId, updatedBy: actorId }));
  const created = await insertAllowingPartial(Product, docs);

  // Same opening-stock row the manual create path writes, so an imported catalogue's stock
  // history is not a hole. No domain event per product: a 2000-row import would otherwise
  // fan out 2000 outbox rows and notifications for what is one user action.
  const movements = created
    .filter((product) => product.trackStock !== false && product.stockQuantity !== 0)
    .map((product) => ({
      business: businessId,
      createdBy: actorId,
      product: product._id,
      type: 'opening_stock',
      quantityChange: product.stockQuantity,
      stockBefore: 0,
      stockAfter: product.stockQuantity,
      note: 'Imported'
    }));

  if (movements.length) await StockMovement.insertMany(movements, { ordered: false });
  return created.length;
};

const updateRows = async ({ businessId, actorId, type, rows }) => {
  if (!rows.length) return 0;

  const build = DOC_BUILDERS[type];
  const result = await modelFor(type).bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { _id: row.existingId, business: businessId },
        // Existing stock is left alone on update: the file's stock column is an opening
        // balance, and overwriting a live count with it would silently lose sales.
        update: { $set: { ...omitStock(type, build(row.values)), updatedBy: actorId } }
      }
    })),
    { ordered: false }
  );

  return result.modifiedCount || 0;
};

const omitStock = (type, doc) => {
  if (type !== 'products') return doc;
  const { stockQuantity, ...rest } = doc;
  return rest;
};

/**
 * Writes the import. `mode` decides what happens to rows whose key already exists:
 * 'skip' leaves them untouched, 'update' overwrites the mapped fields.
 *
 * Rows with errors and in-file duplicates are always skipped — a bad row never blocks the
 * good ones. Not wrapped in a transaction: partial success is the honest outcome for a
 * spreadsheet (the summary says exactly what landed), and a 2000-doc transaction would need
 * a replica set the free tier does not guarantee.
 */
export const commitImport = async ({ businessId, actorId, type, csv, columnMap, mode = 'skip' }) => {
  const analysis = await analyzeImport({ businessId, type, csv, columnMap });

  const creates = analysis.rows.filter((row) => row.status === 'create');
  const updates = mode === 'update' ? analysis.rows.filter((row) => row.status === 'update') : [];

  const created = creates.length
    ? await (type === 'customers' ? insertCustomers : insertProducts)({ businessId, actorId, rows: creates })
    : 0;
  const updated = await updateRows({ businessId, actorId, type, rows: updates });

  return {
    type,
    mode,
    created,
    updated,
    skipped: analysis.counts.duplicate + (mode === 'update' ? 0 : analysis.counts.update),
    failed: analysis.counts.error,
    errors: analysis.rows.filter((row) => row.status === 'error').slice(0, PREVIEW_ROWS)
  };
};
