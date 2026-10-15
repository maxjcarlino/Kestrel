// Headless batch analysis: apply a saved workflow template to data files and
// produce the template's statistics table, without the user interface.
//
// Works in Node and in browsers. The same engine code computes the numbers as
// the app, so a table produced here matches the Statistics view.

import { Engine } from './engine.js';
import { ROOT, ancestors, orderGates } from '../core/gates.js';
import { STATS, populationFrequency } from '../core/stats.js';
import { normalizeSpec } from '../core/transforms.js';

/** Columns of a template's table; when it has none, counts and % of parent for every gate. */
export function templateColumns(template) {
  const cols = (template.table && template.table.columns) || [];
  if (cols.length) return cols;
  const out = [];
  for (const g of orderGates(template.gates || []).ordered) {
    out.push({ id: `${g.id}:count`, kind: 'stat', pop: g.id, stat: 'count' });
    out.push({ id: `${g.id}:freqParent`, kind: 'stat', pop: g.id, stat: 'freqParent' });
  }
  return out;
}

function findKeyword(keywords, name) {
  if (keywords[name] !== undefined) return keywords[name];
  const up = String(name).toUpperCase();
  for (const k of Object.keys(keywords)) if (k.toUpperCase() === up) return keywords[k];
  return undefined;
}

/** Column header in the same form as the app's CSV export. */
export function columnHeader(gatesById, c, channelLabel = (n) => n) {
  if (c.kind === 'keyword') return c.keyword;
  const path = c.pop === ROOT || !gatesById[c.pop] ? 'All events' : [...ancestors(gatesById, c.pop), gatesById[c.pop]].filter(Boolean).map((g) => g.name).join(' / ');
  const st = STATS[c.stat];
  const main = c.stat === 'percentile' ? `P${c.arg ?? 50}` : st ? st.short : c.stat;
  const sub = c.channel ? channelLabel(c.channel) : '';
  return `${path} | ${main}${sub ? ` ${sub}` : ''}`;
}

/** Accept a template file or a saved workspace file. */
export function asTemplate(obj) {
  if (obj && typeof obj.format === 'string') obj = { ...obj, format: obj.format.replace(/^laminar-/, 'kestrel-') };
  if (!obj || typeof obj !== 'object') throw new Error('Expected a Kestrel template or workspace (JSON).');
  if (obj.format === 'kestrel-workspace' || (obj.gates && !Array.isArray(obj.gates))) {
    const map = obj.gates || {};
    const order = (obj.gateOrder || []).filter((id) => map[id]);
    const rest = Object.keys(map).filter((id) => !order.includes(id));
    return {
      format: 'kestrel-template',
      name: obj.name,
      transforms: obj.transforms || {},
      comp: { matrices: (obj.comp && obj.comp.matrices) || [], default: (obj.comp && obj.comp.default) || 'file' },
      derived: obj.derived || [],
      gates: [...order, ...rest].map((id) => map[id]),
      table: { columns: (obj.table && obj.table.columns) || [] },
    };
  }
  if (!Array.isArray(obj.gates)) throw new Error('This is not a Kestrel template: it has no gates.');
  return obj;
}

function compFor(template, meta) {
  const comp = template.comp || {};
  const choice = comp.default || 'file';
  if (choice === 'none') return null;
  if (choice === 'file') return meta.spillover ? { names: meta.spillover.names, matrix: meta.spillover.matrix } : null;
  const m = (comp.matrices || []).find((x) => x.id === choice);
  return m ? { names: m.names, matrix: m.matrix } : null;
}

/**
 * Apply a template to files.
 * @param {object} template a Kestrel template (format "kestrel-template") or workspace file
 * @param {{name:string, buffer:ArrayBuffer, format?:'fcs'|'csv'}[]} files
 * @param {{onFile?:(name:string, i:number, n:number)=>void}} [opts]
 * @returns {{header:string[], rows:(string|number)[][], warnings:string[], counts:object[]}}
 */
export function runTemplate(input, files, opts = {}) {
  const template = asTemplate(input);
  const gates = template.gates;
  const gatesById = Object.fromEntries(gates.map((g) => [g.id, g]));
  const transforms = {};
  for (const [ch, spec] of Object.entries(template.transforms || {})) transforms[ch] = normalizeSpec(spec);
  const columns = templateColumns(template);
  const warnings = [];
  const rows = [];
  const allCounts = [];
  let labels = null;
  files.forEach((f, i) => {
    if (opts.onFile) opts.onFile(f.name, i, files.length);
    const engine = new Engine();
    let meta;
    try {
      meta = engine.handle('load', { id: 's', name: f.name, buffer: f.buffer, format: f.format || (/\.(csv|tsv|txt)$/i.test(f.name) ? 'csv' : 'fcs') }).result;
    } catch (e) {
      warnings.push(`${f.name}: ${e.message}`);
      return;
    }
    if (!labels) labels = new Map(meta.channels.map((c) => [c.name, c.label || c.name]));
    for (const w of meta.warnings || []) warnings.push(`${f.name}: ${w}`);
    engine.handle('setTransforms', { transforms });
    engine.handle('setDerived', { derived: template.derived || [] });
    const comp = compFor(template, meta);
    if (comp) {
      const r = engine.handle('setComp', { id: 's', comp }).result;
      if (r.missing && r.missing.length) warnings.push(`${f.name}: compensation channels not found: ${r.missing.join(', ')}`);
    } else if ((template.comp || {}).default !== 'none' && (template.comp || {}).default !== undefined) {
      warnings.push(`${f.name}: no compensation matrix available; data left uncompensated.`);
    }
    engine.handle('setGates', { gates, overrides: {} });
    const { counts, errors } = engine.handle('counts', { id: 's' }).result;
    for (const [gid, msg] of Object.entries(errors)) warnings.push(`${f.name}: ${gatesById[gid] ? gatesById[gid].name : gid}: ${msg}`);
    const statCols = columns.filter((c) => c.kind !== 'keyword' && STATS[c.stat] && STATS[c.stat].channel);
    const vals = statCols.length ? engine.handle('stats', { id: 's', reqs: statCols.map((c) => ({ pop: c.pop, channel: c.channel, stat: c.stat, arg: c.arg })) }).result : [];
    const byCol = new Map(statCols.map((c, k) => [c, vals[k]]));
    const row = [f.name.replace(/\.(fcs|lmd|csv|tsv|txt)$/i, '')];
    for (const c of columns) {
      let v;
      if (c.kind === 'keyword') v = findKeyword(meta.keywords || {}, c.keyword) ?? '';
      else if (byCol.has(c)) v = byCol.get(c);
      else v = populationFrequency(gatesById, counts, c.pop, c.stat);
      if (typeof v === 'number') v = Number.isFinite(v) ? Number(v.toPrecision(8)) : '';
      row.push(v ?? '');
    }
    rows.push(row);
    allCounts.push({ file: f.name, counts });
  });
  const header = ['Sample', ...columns.map((c) => columnHeader(gatesById, c, (n) => (labels && labels.get(n)) || n))];
  return { header, rows, warnings, counts: allCounts };
}
