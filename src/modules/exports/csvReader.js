// Minimal RFC 4180 CSV reader, sitting next to the writer in csv.js for the same reason:
// the whole job is a quote-aware split, and every csv lib we'd add does it in 200x the code.
//
// Handles: quoted fields, escaped quotes (""), commas and newlines inside quotes, CRLF or
// LF line endings, and a leading UTF-8 BOM (Excel writes one; our own writer does too).
// Deliberately not handled: alternative delimiters (semicolon/tab) and multi-byte
// encodings. ponytail: single delimiter, add a delimiter sniff if users show up with
// semicolon files from a European Excel locale.

import { CSV_BOM } from './csv.js';

/**
 * Splits CSV text into an array of string-cell rows. Fully-empty lines are dropped.
 * @param {string} text
 * @returns {string[][]}
 */
export const parseCsv = (text) => {
  const input = typeof text !== 'string' ? '' : text.startsWith(CSV_BOM) ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    // A trailing newline would otherwise produce a phantom [''] row.
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      endCell();
    } else if (char === '\r') {
      // Swallow CR; the LF that follows ends the row. A lone CR ends it too.
      if (input[index + 1] === '\n') index += 1;
      endRow();
    } else if (char === '\n') {
      endRow();
    } else {
      cell += char;
    }
  }

  if (cell !== '' || row.length) endRow();
  return rows;
};

/**
 * First non-empty row is the header. Returns `{ headers, rows }` where each row is an
 * object keyed by header, plus `line` (1-based file line) so errors can point at it.
 */
export const parseCsvTable = (text) => {
  const [headerRow, ...bodyRows] = parseCsv(text);
  if (!headerRow) return { headers: [], rows: [] };

  const headers = headerRow.map((header) => header.trim());
  const rows = bodyRows.map((cells, index) => {
    const record = { line: index + 2 };
    headers.forEach((header, position) => {
      if (header) record[header] = (cells[position] ?? '').trim();
    });
    return record;
  });

  return { headers, rows };
};
