// Ordering the sample list: by file order (as added), name, group, event
// count, or any FCS keyword (date, tube name, $SRC, ...). The choice is saved
// with the workspace (doc.settings.sampleSort) but isn't an undo step.

import { store } from './store.js';
import { updateDoc, findKeyword } from './doc.js';

export const DEFAULT_SORT = { by: 'file', key: null, desc: false };

// Natural order: "Donor 2" before "Donor 10", case ignored, accents compared.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A keyword value as something sortable: dates and numbers by value, else text. */
function keyValue(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return { n: parseFloat(s), s };
  // FCS $DATE is dd-mmm-yyyy; other dates usually parse as-is
  const d = /^\d{1,2}-[a-z]{3}-\d{2,4}$/i.test(s) ? Date.parse(s.replace(/-/g, ' ')) : /\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s) : NaN;
  if (Number.isFinite(d)) return { n: d, s };
  return { s };
}

function cmpValues(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // missing values always go last
  if (b === null) return -1;
  if (a.n !== undefined && b.n !== undefined && a.n !== b.n) return a.n - b.n;
  if (a.n !== undefined && b.n === undefined) return -1;
  if (a.n === undefined && b.n !== undefined) return 1;
  return collator.compare(a.s, b.s);
}

/** The value a sample is sorted on, for display next to its name (or null). */
export function sortValue(doc, meta, smp, sort = currentSort(doc)) {
  if (sort.by === 'kw' && sort.key) {
    const v = findKeyword(((meta[smp.id] || {}).keywords) || {}, sort.key);
    return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
  }
  return null;
}

/**
 * Sorted copy of `samples`. Ties (and missing values, which always sort
 * last whichever the direction) keep file order, so the result is stable.
 * Sorting by group follows the order the groups were made in; a sample in
 * several groups sorts under its first, ungrouped samples last.
 */
export function sortSamples(doc, meta, samples, sort = currentSort(doc)) {
  const by = sort.by || 'file';
  const order = new Map(doc.samples.map((s, i) => [s.id, i]));
  const groupRank = new Map(doc.groups.map((g, i) => [g.id, i]));
  const firstGroup = (s) => {
    const ranks = (s.groupIds || []).map((g) => groupRank.get(g)).filter((r) => r !== undefined);
    return ranks.length ? Math.min(...ranks) : null;
  };
  const value = (s) => {
    if (by === 'name') return { s: s.name || '' };
    if (by === 'events') return Number.isFinite(s.nEvents) && s.nEvents > 0 ? { n: s.nEvents, s: '' } : null;
    if (by === 'group') {
      const r = firstGroup(s);
      return r === null ? null : { n: r, s: '' };
    }
    if (by === 'kw') return keyValue(sortValue(doc, meta, s, sort));
    return { n: order.get(s.id) ?? 0, s: '' };
  };
  const dir = sort.desc ? -1 : 1;
  return samples
    .map((s) => ({ s, v: value(s) }))
    .sort((a, b) => {
      let c;
      if (a.v === null || b.v === null) c = cmpValues(a.v, b.v); // missing last, either direction
      else c = dir * cmpValues(a.v, b.v);
      // within a group, keep a natural name order
      if (!c && by === 'group') c = collator.compare(a.s.name || '', b.s.name || '');
      return c || (order.get(a.s.id) ?? 0) - (order.get(b.s.id) ?? 0);
    })
    .map((x) => x.s);
}

/** The first group a sample sorts under (for group headings), or null. */
export function sortGroupOf(doc, smp) {
  for (const g of doc.groups) if ((smp.groupIds || []).includes(g.id)) return g;
  return null;
}

/**
 * Keywords worth sorting by, across the loaded samples: per-parameter
 * keywords ($P1N, $P3V, ...) and the TEXT segment's bookkeeping are left
 * out; familiar ones come first.
 */
const SKIP = /^\$?(P\d+[A-Z]+|BEGIN|END|NEXTDATA|BYTEORD|DATATYPE|MODE|PAR|SPILL|SPILLOVER|COMP|BEGINANALYSIS|ENDANALYSIS|BEGINDATA|ENDDATA|BEGINSTEXT|ENDSTEXT|R\d+[A-Z]|G\d+[A-Z]+|CYTSN|CSVBITS|CSTOT|CSMODE|CSV\d+FLAG|FLOWRATE|VOL|SYS|TIMESTEP|PLATEID|PLATENAME|UNICODE|LOST|ABRT|LAST_MODIFIED|LAST_MODIFIER|ORIGINALITY|WELLID)$/i;
const FIRST = ['$DATE', '$BTIM', '$ETIM', 'TUBE NAME', '$SRC', '$FIL', 'EXPERIMENT NAME', 'SAMPLE ID', '$SMNO', 'WELL ID', '$TOT', '$OP', '$INST', '$CYT', '$PROJ', '$COM'];
export function sortableKeywords(doc, meta) {
  const seen = new Map();
  for (const smp of doc.samples) {
    for (const k of Object.keys(((meta[smp.id] || {}).keywords) || {})) {
      const up = k.toUpperCase();
      if (SKIP.test(up) && !FIRST.includes(up)) continue;
      if (!seen.has(up)) seen.set(up, k);
    }
  }
  const rank = (k) => {
    const i = FIRST.indexOf(k.toUpperCase());
    return i < 0 ? 1e3 : i;
  };
  return [...seen.values()].sort((a, b) => rank(a) - rank(b) || collator.compare(a.replace(/^\$/, ''), b.replace(/^\$/, '')));
}

export function currentSort(doc = store.get().doc) {
  return { ...DEFAULT_SORT, ...((doc.settings && doc.settings.sampleSort) || {}) };
}

export function setSampleSort(patch) {
  updateDoc((d) => ({ ...d, settings: { ...d.settings, sampleSort: { ...currentSort(d), ...patch } } }), { history: false });
}

/** Label for the current order, e.g. "Name", "Group", "$DATE". */
export function sortLabel(sort) {
  if (sort.by === 'kw') return sort.key || 'Keyword';
  return { file: 'File order', name: 'Name', group: 'Group', events: 'Events' }[sort.by] || 'File order';
}
