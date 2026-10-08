/**
 * Minimal RFC 4180 CSV for imports and exports (no dependency): quoted fields, doubled quotes,
 * CRLF or LF line ends. Exports neutralise spreadsheet formula injection (OWASP "CSV
 * injection"): a cell starting with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'`.
 */

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

/** Parses CSV text into rows of fields. Empty trailing lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let i = 0;
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < input.length) {
    const c = input[i] as string;
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        const next = input[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw new CsvParseError('unexpected character after closing quote', line);
        }
        continue;
      }
      if (c === '\n') line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (field !== '') throw new CsvParseError('quote inside an unquoted field', line);
      quoted = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\r') {
      if (input[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
    } else if (c === '\n') {
      endRow();
      line += 1;
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new CsvParseError('unterminated quoted field', line);
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = value.toString();
  } else text = '';
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Serialises a header and rows to CSV (CRLF, RFC 4180). */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
