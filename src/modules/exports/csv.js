// Minimal RFC 4180 CSV writer for data exports. No dependency: the whole job is
// escaping and joining, and every csv lib we'd add does the same in 200x the code.

// Excel reads a UTF-8 file as the local codepage unless it sees a byte-order mark,
// which mangles customer names in every non-ASCII script. Prepend it once per file.
// Built from its code point so this source file stays plain ASCII — a literal BOM here
// is invisible in editors and does not survive every toolchain.
export const CSV_BOM = String.fromCharCode(0xfeff);

const NEEDS_QUOTING = /["\r\n,]/;

export const csvValue = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    // ObjectId, Decimal128, embedded docs. String() on a plain object is useless,
    // so fall back to JSON for anything that doesn't stringify meaningfully.
    const asString = String(value);
    return asString === '[object Object]' ? JSON.stringify(value) : asString;
  }
  return String(value);
};

const escapeCell = (value) => {
  const text = csvValue(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Dotted path getter — 'customerSnapshot.name', 'tax.amount'.
export const pluck = (row, path) =>
  path.split('.').reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), row);

const cellFor = (row, column) => (column.value ? column.value(row) : pluck(row, column.path ?? column.header));

/** @typedef {{header: string, path?: string, value?: (row: object) => unknown}} CsvColumn */

/** Header line, BOM included. Written once per file. @param {CsvColumn[]} columns */
export const csvHeader = (columns) => `${CSV_BOM}${columns.map((column) => escapeCell(column.header)).join(',')}\r\n`;

/** Body lines for a batch of rows — call repeatedly while streaming a cursor. */
export const csvRows = (rows, columns) =>
  rows.map((row) => `${columns.map((column) => escapeCell(cellFor(row, column))).join(',')}\r\n`).join('');

/** Whole-file convenience. Only for small sets and tests — streams use the two above. */
export const toCsv = (rows, columns) => csvHeader(columns) + csvRows(rows, columns);
