/**
 * Splits a SQL script into individual statements. Needed only for `-- ecloud:no-transaction`
 * migrations: a multi-statement simple-query message runs in an implicit transaction, which is
 * exactly what `CREATE INDEX CONCURRENTLY` forbids, so such files are executed one statement at
 * a time. Understands line and block comments, single-quoted and E'' strings, double-quoted
 * identifiers and dollar-quoted bodies (`$$ ... $$`, `$tag$ ... $tag$`).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  const flush = (): void => {
    const trimmed = stripLeadingComments(current).trim();
    if (trimmed !== '') out.push(trimmed);
    current = '';
  };

  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    // line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // block comment (no nesting needed for our files)
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // dollar quoting
    if (ch === '$') {
      const tag = readDollarTag(sql, i);
      if (tag !== undefined) {
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? n : close + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    // E'...' or '...' strings
    if (ch === "'" || ((ch === 'E' || ch === 'e') && next === "'" && !isIdentChar(sql[i - 1]))) {
      const escaped = ch !== "'";
      const start = i;
      i += escaped ? 2 : 1;
      while (i < n) {
        const c = sql[i];
        if (escaped && c === '\\') {
          i += 2;
          continue;
        }
        if (c === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      current += sql.slice(start, i);
      continue;
    }
    // double-quoted identifier
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      current += sql.slice(start, i);
      continue;
    }
    if (ch === ';') {
      flush();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  return out;
}

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

/** Returns the dollar-quote tag starting at `pos` (e.g. `$$`, `$body$`) or undefined. */
function readDollarTag(sql: string, pos: number): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(pos, pos + 64));
  return match === null ? undefined : match[0];
}

/** Drops comment-only lines at the start so a trailing comment is not an "empty statement". */
function stripLeadingComments(text: string): string {
  const lines = text.split('\n');
  let idx = 0;
  while (idx < lines.length) {
    const line = (lines[idx] ?? '').trim();
    if (line === '' || line.startsWith('--')) {
      idx += 1;
      continue;
    }
    break;
  }
  return lines.slice(idx).join('\n');
}
