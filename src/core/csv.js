// CSV helpers: writing tables and reading numeric event tables.

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return String(v);
  }
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function toTSV(rows) {
  return rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\n\r]/g, ' '))).join('\t')).join('\n') + '\n';
}

/**
 * Parse a numeric event table (first row = channel names). Accepts comma,
 * semicolon or tab separators.
 * @returns {{channels:string[], columns:Float32Array[], nEvents:number}}
 */
export function parseEventTable(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('The table needs a header row and at least one row of values.');
  const head = lines[0];
  const sep = head.indexOf('\t') >= 0 ? '\t' : head.split(';').length > head.split(',').length ? ';' : ',';
  const split = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const channels = split(head).map((s) => s.trim());
  const P = channels.length;
  const n = lines.length - 1;
  const columns = channels.map(() => new Float32Array(n));
  let m = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = split(lines[r]);
    if (cells.length < P) continue;
    let ok = true;
    for (let p = 0; p < P; p++) {
      const v = parseFloat(cells[p]);
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      columns[p][m] = v;
    }
    if (ok) m++;
  }
  if (m === 0) throw new Error('No numeric rows were found in the table.');
  return { channels, columns: m === n ? columns : columns.map((c) => c.slice(0, m)), nEvents: m };
}

/**
 * Parse delimited text (a CSV/TSV file, or cells copied from a spreadsheet)
 * into rows of strings. The delimiter is tab if the first line has one, else
 * semicolon if it has more of those than commas, else comma. Quoted cells may
 * contain the delimiter, newlines and doubled quotes. A trailing empty line is
 * dropped.
 */
export function parseTable(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = first.includes('\t') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
