// Bringing sample information in from elsewhere: a CSV/TSV sheet (one row per
// sample) or a block of cells pasted from a spreadsheet. Pure functions; the
// Samples tab applies the results with addMetaField / setSampleMeta.

const KEY_HEADERS = ['sample', 'sample name', 'samplename', 'name', 'file', 'file name', 'filename', 'fcs file', 'fcs', 'tube', 'tube name', '$fil'];

const stripExt = (s) => String(s || '').replace(/\.(fcs|lmd|csv|tsv|txt)$/i, '');
const norm = (s) => stripExt(String(s || '').trim()).toLowerCase();

/** Find the sample a sheet's key cell names: by sample name or file name, with or without the extension, ignoring case. */
export function findSample(doc, key) {
  const k = norm(key);
  if (!k) return null;
  return doc.samples.find((s) => norm(s.name) === k) || doc.samples.find((s) => norm(s.fileName) === k) || null;
}

/**
 * Work out what a sheet (rows of cells, first row headers) says about the
 * workspace's samples. The key column is the one headed like "Sample",
 * "Name" or "File", or else the first column that names any sample.
 * @returns {{ keyHeader, fields: string[], entries: [sampleId, field, value][], matched: number, unmatched: string[] }}
 */
export function matchSheet(doc, rows) {
  const clean = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (clean.length < 2) return { keyHeader: null, fields: [], entries: [], matched: 0, unmatched: [] };
  const head = clean[0].map((h) => String(h).trim());
  const body = clean.slice(1);
  let key = head.findIndex((h) => KEY_HEADERS.includes(h.toLowerCase()));
  if (key < 0) key = head.findIndex((_, j) => body.some((r) => findSample(doc, r[j])));
  if (key < 0) return { keyHeader: null, fields: [], entries: [], matched: 0, unmatched: body.map((r) => r[0]).filter(Boolean) };
  const fields = head.map((h, j) => (j === key || !h ? null : h));
  const entries = [];
  const unmatched = [];
  const seen = new Set();
  for (const r of body) {
    const smp = findSample(doc, r[key]);
    if (!smp) {
      if (String(r[key] || '').trim()) unmatched.push(String(r[key]).trim());
      continue;
    }
    seen.add(smp.id);
    fields.forEach((f, j) => {
      if (f) entries.push([smp.id, f, String(r[j] ?? '').trim()]);
    });
  }
  return { keyHeader: head[key], fields: fields.filter(Boolean), entries, matched: seen.size, unmatched };
}

/**
 * Fill a block of pasted cells into the table, starting at (row, col) of the
 * visible order. `fields` are the editable columns, left to right; pasted
 * columns beyond the last one become new columns (named in `newFields`).
 * @returns {{ entries: [sampleId, field, value][], newFields: string[] }}
 */
export function pasteBlock(rows, sampleIds, fields, startRow, startCol, nameFor = (k) => `Column ${k}`) {
  const block = rows.filter((r, i) => i < rows.length - 1 || r.some((c) => c !== ''));
  const width = Math.max(0, ...block.map((r) => r.length));
  const cols = fields.slice();
  const newFields = [];
  for (let j = startCol + width - cols.length, k = cols.length + 1; j > 0; j--, k++) {
    let n = nameFor(k);
    while (cols.includes(n)) n = nameFor(++k);
    cols.push(n);
    newFields.push(n);
  }
  const entries = [];
  block.forEach((r, i) => {
    const id = sampleIds[startRow + i];
    if (!id) return;
    r.forEach((v, j) => entries.push([id, cols[startCol + j], String(v).trim()]));
  });
  return { entries, newFields };
}
