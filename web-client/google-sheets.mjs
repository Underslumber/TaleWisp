export const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
export const GOOGLE_SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const MAX_SHEET_CELLS = 2000;

const ERROR = (message, code = 'GOOGLE_SHEET_RANGE_INVALID', status = 400) => Object.assign(new Error(message), { code, status });

function columnNumber(letters) {
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

/** Accept only a finite, rectangular A1 range. Open rows/columns and whole-grid reads are rejected. */
export function parseBoundedA1Range(range) {
  if (typeof range !== 'string' || range.length > 512) throw ERROR('A bounded A1 range is required.');
  const match = range.match(/^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_ ]*))!\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)$/i);
  if (!match) throw ERROR('Use one exact, finite A1 range such as `Index!A1:F20`; whole columns and open ranges are not allowed.');
  const startColumn = columnNumber(match[3]);
  const startRow = Number(match[4]);
  const endColumn = columnNumber(match[5]);
  const endRow = Number(match[6]);
  if (![startRow, endRow, startColumn, endColumn].every(Number.isSafeInteger)) throw ERROR('A1 row and column coordinates must be safe integers.');
  if (endColumn < startColumn || endRow < startRow) throw ERROR('The A1 range end must follow its start.');
  const cells = (endColumn - startColumn + 1) * (endRow - startRow + 1);
  if (cells > MAX_SHEET_CELLS) throw ERROR(`A Sheets operation is limited to ${MAX_SHEET_CELLS} cells.`);
  return { range, cells, rows: endRow - startRow + 1, columns: endColumn - startColumn + 1 };
}

export function sheetValuesUrl(spreadsheetId, range, query = {}) {
  if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(spreadsheetId)) throw ERROR('A valid Google spreadsheet ID is required.', 'GOOGLE_SPREADSHEET_ID_INVALID');
  parseBoundedA1Range(range);
  const url = new URL(`${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

export function normalizeGrid(values) {
  if (!Array.isArray(values)) return [];
  return values.map(row => Array.isArray(row) ? row.map(value => value ?? '') : []);
}

/** Sheets omits trailing empty rows and cells from Values API responses. Restore the exact requested rectangle. */
export function padGrid(values, bounds) {
  const grid = normalizeGrid(values);
  if (grid.length > bounds.rows || grid.some(row => row.length > bounds.columns)) {
    throw ERROR('Google returned more cells than the requested bounded range.', 'GOOGLE_SHEET_RESPONSE_INVALID', 502);
  }
  while (grid.length < bounds.rows) grid.push([]);
  return grid.map(row => [...row, ...Array(Math.max(0, bounds.columns - row.length)).fill('')]);
}

export function containsFormula(values) {
  return normalizeGrid(values).some(row => row.some(value => typeof value === 'string' && value.startsWith('=')));
}

export function stableGridHash(values) {
  return createHash('sha256').update(JSON.stringify(normalizeGrid(values)), 'utf8').digest('hex');
}

export function validateWriteGrid(range, values) {
  const bounds = parseBoundedA1Range(range);
  if (!Array.isArray(values) || values.length !== bounds.rows || values.some(row => !Array.isArray(row) || row.length !== bounds.columns)) {
    throw ERROR('Proposed values must exactly fill the bounded A1 range.');
  }
  if (values.flat().some(value => !['string', 'number', 'boolean'].includes(typeof value) && value !== null)) throw ERROR('Sheet cells must be strings, numbers, booleans, or null.');
  return values.map(row => row.map(value => value ?? ''));
}
import { createHash } from 'node:crypto';

