// Values derived from state: channel lists, compensation in effect,
// population signatures (to know when engine results are stale), frequencies.

import { ROOT, ancestors, needsScale, evalSpecs, gateDeps, hashString } from '../../core/gates.js';
import { geometrySignature } from '../../engine/engine.js';
import { matrixKey } from '../../core/compensation.js';
import { transformKey } from '../../core/transforms.js';
import { populationFrequency } from '../../core/stats.js';
import { effectiveGate } from './doc.js';

const EMPTY = Object.freeze({});

/** Union of channels across samples, in first-seen order. */
const chanMemo = new WeakMap();
const EMPTY_LIST = [];
export function allChannels(doc) {
  const derived = doc.derived || EMPTY_LIST;
  let m = chanMemo.get(doc.samples);
  if (!m || m.derived !== derived) {
    const seen = new Map();
    for (const s of doc.samples) {
      for (const c of s.channels || []) {
        if (!seen.has(c.name)) seen.set(c.name, { name: c.name, label: c.label || '', kind: c.kind || 'fluor', range: c.range });
        else if (!seen.get(c.name).label && c.label) seen.get(c.name).label = c.label;
      }
    }
    for (const d of derived) {
      if (!seen.has(d.name)) seen.set(d.name, { name: d.name, label: '', kind: 'derived', derived: d, expr: ratioExpr(d) });
    }
    m = { derived, out: [...seen.values()] };
    chanMemo.set(doc.samples, m);
  }
  // A user-set label (doc.channelLabels) overrides whatever the file itself carries.
  const overrides = doc.channelLabels;
  if (overrides && Object.keys(overrides).length) {
    return m.out.map((c) => (overrides[c.name] ? { ...c, label: overrides[c.name], fileLabel: c.label } : c));
  }
  const out = m.out;
  return out;
}

export function ratioExpr(d) {
  const num = d.B ? `(${d.x} − ${d.B})` : d.x;
  const den = d.C ? `(${d.y} − ${d.C})` : d.y;
  return `${d.A && d.A !== 1 ? `${d.A}·` : ''}${num} / ${den}`;
}

/** Channels a sample can show: its own plus ratios of channels it has. */
export function sampleHasChannel(doc, channelNames, name) {
  if (channelNames.includes(name)) return true;
  const d = (doc.derived || []).find((x) => x.name === name);
  return !!(d && channelNames.includes(d.x) && channelNames.includes(d.y));
}

export function channelInfo(doc, name) {
  return allChannels(doc).find((c) => c.name === name) || { name, label: '', kind: 'fluor' };
}

/** "CD3 · FITC-A" style label. */
export function channelTitle(doc, name) {
  if (!name) return 'Count';
  const c = channelInfo(doc, name);
  return c.label ? `${c.label} · ${c.name}` : c.name;
}

export function channelShort(doc, name) {
  if (!name) return 'Count';
  const c = channelInfo(doc, name);
  return c.label || c.name;
}

/** The compensation choice for a sample: 'none' | 'file' | matrixId. */
export function compChoice(doc, sampleId) {
  const v = doc.comp.perSample[sampleId];
  return v !== undefined ? v : doc.comp.default;
}

/** Spillover matrix applied to a sample, or null. */
export function effectiveComp(state, sampleId) {
  const doc = state.doc;
  const choice = compChoice(doc, sampleId);
  if (choice === 'none') return null;
  if (choice === 'file') {
    const m = state.meta[sampleId];
    return m && m.spillover ? { names: m.spillover.names, matrix: m.spillover.matrix, id: 'file', name: 'Acquisition matrix' } : null;
  }
  const mat = doc.comp.matrices.find((x) => x.id === choice);
  return mat ? { names: mat.names, matrix: mat.matrix, id: mat.id, name: mat.name } : null;
}

const keyMemo = new WeakMap();
export function compKey(state, sampleId) {
  const c = effectiveComp(state, sampleId);
  if (!c) return 'none';
  const mat = c.matrix;
  let k = keyMemo.get(mat);
  if (!k) {
    k = matrixKey(c);
    keyMemo.set(mat, k);
  }
  return k;
}

export function compLabel(state, sampleId) {
  const doc = state.doc;
  const choice = compChoice(doc, sampleId);
  if (choice === 'none') return 'Uncompensated';
  if (choice === 'file') {
    const m = state.meta[sampleId];
    return m && m.spillover ? 'Acquisition matrix' : 'Uncompensated (no matrix in file)';
  }
  const mat = doc.comp.matrices.find((x) => x.id === choice);
  return mat ? mat.name : 'Uncompensated';
}

export function isCompensated(state, sampleId, channel) {
  const c = effectiveComp(state, sampleId);
  return !!(c && c.names.includes(channel));
}

/** Signature of everything that decides which events are in a population. */
const sigMemo = new WeakMap();
export function popSig(state, sampleId, popId) {
  const ck = compKey(state, sampleId);
  if (!popId || popId === ROOT) return 'root|' + ck;
  const doc = state.doc;
  const ov = doc.overrides[sampleId] || EMPTY;
  let m1 = sigMemo.get(doc.gates);
  if (!m1) sigMemo.set(doc.gates, (m1 = new WeakMap()));
  let m2 = m1.get(ov);
  if (!m2) m1.set(ov, (m2 = new WeakMap()));
  let m3 = m2.get(doc.transforms);
  if (!m3) m2.set(doc.transforms, (m3 = new Map()));
  const rec = (id, depth) => {
    if (!id || id === ROOT) return 'root';
    const key = sampleId + '|' + id + '|' + ck;
    if (m3.has(key)) return m3.get(key);
    const g = effectiveGate(doc, sampleId, id);
    if (!g || depth > 64) return 'missing';
    let s = geometrySignature(g);
    if (needsScale(g)) {
      const [ex, ey] = evalSpecs(g, doc.transforms);
      s += '|' + transformKey(ex) + '|' + transformKey(ey);
    }
    for (const d of gateDeps(g)) s += '|' + rec(d, depth + 1);
    s += '|' + rec(g.parent || ROOT, depth + 1);
    const h = hashString(s + '|' + ck);
    m3.set(key, h);
    return h;
  };
  return rec(popId, 0);
}

/** Version string for a sample's population counts. */
export function countsVersion(state, sampleId) {
  const doc = state.doc;
  const ids = Object.keys(doc.gates);
  let s = compKey(state, sampleId) + '|' + ids.length;
  for (const id of ids) s += '|' + popSig(state, sampleId, id);
  return hashString(s);
}

export function parentOf(doc, id) {
  const g = doc.gates[id];
  return g ? g.parent || ROOT : null;
}

export function popName(doc, id) {
  if (!id || id === ROOT) return 'All events';
  const g = doc.gates[id];
  return g ? g.name : '(deleted)';
}

export function popPath(doc, id, sep = ' / ') {
  if (!id || id === ROOT) return 'All events';
  const chain = [...ancestors(doc.gates, id), doc.gates[id]].filter(Boolean);
  return chain.map((g) => g.name).join(sep);
}

/** Frequencies from a counts table. */
export function frequency(doc, counts, id, stat) {
  return populationFrequency(doc.gates, counts, id, stat);
}

/**
 * Flatten the gate tree under `rootId` (ROOT for the whole hierarchy, or any
 * gate id to show just that gate and its descendants) into rows ordered the
 * way the Populations panel shows them, each `{ gate, depth, last }` with
 * `depth` relative to `rootId` (the root itself is depth 0 and included
 * unless `rootId` is ROOT, matching how "All events" is drawn separately).
 */
export function hierarchyRows(doc, rootId) {
  const root = rootId && rootId !== ROOT ? rootId : ROOT;
  const kids = new Map();
  for (const g of Object.values(doc.gates)) {
    const p = g.parent || ROOT;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(g);
  }
  const order = new Map((doc.gateOrder || []).map((id, i) => [id, i]));
  const out = [];
  const walk = (id, depth) => {
    const list = (kids.get(id) || []).slice().sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    list.forEach((g, i) => {
      out.push({ gate: g, depth, last: i === list.length - 1 });
      walk(g.id, depth + 1);
    });
  };
  if (root === ROOT) {
    walk(ROOT, 0);
  } else {
    const g = doc.gates[root];
    if (!g) return [];
    out.push({ gate: g, depth: 0, last: true });
    walk(root, 1);
  }
  return out;
}

function isA(n) {
  return /-A$/i.test(n) || /\bA$/.test(n);
}

/** Axes for a new plot of a population (used when drilling down). */
export function suggestAxes(doc, gateId) {
  const chans = allChannels(doc);
  const names = new Set(chans.map((c) => c.name));
  let g = doc.gates[gateId];
  const chain = [...ancestors(doc.gates, gateId), g].filter(Boolean);
  const used = new Set();
  for (const a of chain) {
    if (a.x) used.add(a.x);
    if (a.y) used.add(a.y);
  }
  let ref = g;
  for (let i = chain.length - 1; i >= 0 && ref && !ref.x; i--) ref = chain[i];
  const x = ref && ref.x;
  const y = ref && ref.y;
  const kind = (n) => (chans.find((c) => c.name === n) || {}).kind;
  if (x && y && kind(x) === 'scatter' && kind(y) === 'scatter') {
    const base = (n) => n.replace(/-[AHW]$/i, '');
    if (isA(x) && isA(y) && base(x) !== base(y)) {
      const fsc = [x, y].find((n) => /^fs/i.test(n)) || x;
      const h = base(fsc) + '-H';
      if (names.has(h)) return [fsc, h];
    }
    if (base(x) === base(y)) {
      const other = chans.find((c) => c.kind === 'scatter' && base(c.name) !== base(x) && /-A$/i.test(c.name));
      if (other) {
        const h = base(other.name) + '-H';
        if (names.has(h) && !used.has(h)) return [other.name, h];
      }
    }
  }
  const fluor = chans.filter((c) => (c.kind === 'fluor' || c.kind === 'mass') && !used.has(c.name));
  if (fluor.length >= 2) return [fluor[0].name, fluor[1].name];
  if (fluor.length === 1) return [fluor[0].name, null];
  return [x || (chans[0] && chans[0].name), y || null];
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return nice * e;
}

/** Default display scale for a newly seen channel. */
export function defaultSpec(ch) {
  const sug = ch.suggest || {};
  switch (ch.kind) {
    case 'scatter':
      return { type: 'linear', min: 0, max: ch.range > 1 ? ch.range : niceMax(ch.max) };
    case 'time':
      return { type: 'linear', min: Math.min(0, ch.min || 0), max: niceMax(ch.max || 1) };
    case 'other':
      return { type: 'linear', min: Math.min(0, sug.p001 ?? ch.min ?? 0), max: niceMax(sug.p999 ?? ch.max ?? 1) };
    case 'mass':
      return { type: 'arcsinh', cofactor: 5, max: niceMax(Math.max(100, (sug.p999 ?? ch.max ?? 1000) * 1.5)), min: -10 };
    default: {
      const T = ch.range > 1 ? ch.range : niceMax(ch.max || 262144);
      const W = Math.min(2, Math.max(0.3, Number.isFinite(sug.W) ? sug.W : 0.5));
      return { type: 'logicle', T, W, M: 4.5, A: 0 };
    }
  }
}

/** Gates drawn on a plot: children of the plotted population on matching axes. */
export function gatesForPlot(doc, plot) {
  const out = [];
  for (const g of Object.values(doc.gates)) {
    if ((g.parent || ROOT) !== plot.pop) continue;
    if (plot.y) {
      if ((g.type === 'rect' || g.type === 'polygon' || g.type === 'ellipse') && g.x === plot.x && g.y === plot.y) out.push(g);
    } else if (g.type === 'range' && g.x === plot.x) out.push(g);
  }
  return out;
}

/** Child gates that exist under a population but are on other axes. */
export function hiddenChildren(doc, plot) {
  const shown = new Set(gatesForPlot(doc, plot).map((g) => g.id));
  return Object.values(doc.gates).filter((g) => (g.parent || ROOT) === plot.pop && !shown.has(g.id) && g.type !== 'boolean');
}
