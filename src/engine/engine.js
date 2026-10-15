// Compute engine. Owns sample data and does all per-event work: parsing,
// compensation, scaling, gating, binning for plots, statistics and export.
// The same class runs inside Web Workers (one engine per worker, each owning
// a subset of samples) or on the main thread as a fallback.

import { parseFCS, summaryKeywords, classifyChannel } from '../core/fcs-parse.js';
import { writeFCS } from '../core/fcs-write.js';
import { makeTransform, transformKey, normalizeSpec } from '../core/transforms.js';
import { invertMatrix, matchChannels, matrixKey, compensateColumns } from '../core/compensation.js';
import { orderGates, evaluateGate, applyOverride, needsScale, evalSpecs, hashString, gateDeps, ROOT } from '../core/gates.js';
import { channelStats, percentileSorted, subset } from '../core/stats.js';
import { estimateLogicleW } from '../core/logicle.js';
import { parseEventTable, toCSV } from '../core/csv.js';
import { generateSample } from '../core/demo-data.js';

const DEFAULT_SPEC = { type: 'linear', min: 0, max: 262144 };

class Sample {
  constructor(id, name, parsed) {
    this.id = id;
    this.name = name;
    this.N = parsed.nEvents;
    this.channels = parsed.channels;
    this.raw = parsed.columns;
    this.keywords = parsed.keywords;
    this.spillover = parsed.spillover;
    this.index = new Map();
    parsed.channels.forEach((c, i) => this.index.set(c.name, i));
    this.comp = null; // { key, cols: Map<index, Float32Array>, missing: [] }
    this.scaled = new Map(); // index -> { key, arr }
    this.pops = new Map(); // gateId -> { sig, idx, error }
    this.sigMemo = new Map();
    this.derivedCols = new Map(); // name -> { key, arr }
    this._root = null;
  }
  root() {
    if (!this._root) {
      const r = new Uint32Array(this.N);
      for (let i = 0; i < this.N; i++) r[i] = i;
      this._root = r;
    }
    return this._root;
  }
  values(ch) {
    const i = this.index.get(ch);
    if (i === undefined) return null;
    if (this.comp) {
      const c = this.comp.cols.get(i);
      if (c) return c;
    }
    return this.raw[i];
  }
  rawValues(ch) {
    const i = this.index.get(ch);
    return i === undefined ? null : this.raw[i];
  }
  compKey() {
    return this.comp ? this.comp.key : 'none';
  }
  invalidate() {
    this.scaled.clear();
    this.pops.clear();
    this.sigMemo.clear();
    this.derivedCols.clear();
  }
}

function quickSample(arr, max) {
  if (arr.length <= max) return arr;
  const out = new Float32Array(max);
  const step = arr.length / max;
  for (let i = 0; i < max; i++) out[i] = arr[Math.floor(i * step)];
  return out;
}

export class Engine {
  constructor() {
    this.samples = new Map();
    this.transforms = {};
    this.gates = [];
    this.gateById = new Map();
    this.ordered = [];
    this.invalid = new Set();
    this.overrides = {};
    this.derived = new Map();
  }

  /** Dispatch a message. Returns { result, transfer }. */
  handle(type, p) {
    const fn = this['cmd_' + type];
    if (!fn) throw new Error(`Unknown engine command "${type}"`);
    return fn.call(this, p || {});
  }

  sample(id) {
    const s = this.samples.get(id);
    if (!s) throw new Error('That sample is not loaded.');
    return s;
  }

  // ------------------------------------------------------------ loading

  cmd_load({ id, name, buffer, format = 'fcs', options = {} }) {
    let parsed;
    if (format === 'csv') {
      const text = new TextDecoder().decode(buffer);
      const t = parseEventTable(text);
      parsed = {
        version: 'CSV',
        keywords: { $FIL: name },
        channels: t.channels.map((nm, i) => {
          const col = t.columns[i];
          let mn = Infinity;
          let mx = -Infinity;
          for (let k = 0; k < col.length; k++) {
            if (col[k] < mn) mn = col[k];
            if (col[k] > mx) mx = col[k];
          }
          return { index: i, name: nm, label: '', bits: 32, range: mx > 0 ? mx : 1, amp: [0, 0], gain: 1, kind: classifyChannel(nm, ''), min: mn, max: mx };
        }),
        nEvents: t.nEvents,
        columns: t.columns,
        spillover: null,
        datasetCount: 1,
        warnings: [],
      };
    } else {
      parsed = parseFCS(buffer, options);
    }
    const s = new Sample(id, name, parsed);
    this.samples.set(id, s);
    return { result: this.meta(s, parsed) };
  }

  cmd_loadDemo({ id, name, spec }) {
    const bytes = generateSample(spec);
    const parsed = parseFCS(bytes);
    const s = new Sample(id, name, parsed);
    this.samples.set(id, s);
    return { result: { ...this.meta(s, parsed), size: bytes.length } };
  }

  cmd_generateDemo({ spec }) {
    const bytes = generateSample(spec);
    return { result: { buffer: bytes.buffer }, transfer: [bytes.buffer] };
  }

  meta(s, parsed) {
    // Suggested display scales from a subsample (compensated when possible)
    let sampleCols = null;
    const sub = Math.min(s.N, 40000);
    if (s.spillover) {
      try {
        const idx = matchChannels(s.spillover.names, s.channels);
        if (idx.every((k) => k >= 0)) {
          const inv = invertMatrix(s.spillover.matrix);
          const small = s.raw.map((c) => quickSample(c, sub));
          const comp = compensateColumns(small, idx, inv, small[0].length);
          sampleCols = small.slice();
          idx.forEach((k, j) => (sampleCols[k] = comp[j]));
        }
      } catch (e) {
        sampleCols = null;
      }
    }
    const suggestions = s.channels.map((ch, i) => {
      const col = sampleCols ? sampleCols[i] : quickSample(s.raw[i], sub);
      const sorted = Float32Array.from(col).sort();
      const p001 = percentileSorted(sorted, 0.1);
      const p999 = percentileSorted(sorted, 99.9);
      const T = ch.range > 0 ? ch.range : Math.max(p999, 1);
      let W = 0.5;
      try {
        W = estimateLogicleW(col, T, 4.5, 0);
      } catch (e) {
        W = 0.5;
      }
      return { W, p001, p999 };
    });
    return {
      id: s.id,
      name: s.name,
      nEvents: s.N,
      version: parsed.version,
      channels: s.channels.map((c, i) => ({
        name: c.name,
        label: c.label,
        range: c.range,
        kind: c.kind,
        min: c.min,
        max: c.max,
        voltage: c.voltage,
        gain: c.gain,
        logAmplified: !!c.logAmplified,
        suggest: suggestions[i],
      })),
      keywords: s.keywords,
      summary: summaryKeywords(s.keywords),
      spillover: s.spillover ? { names: s.spillover.names, matrix: s.spillover.matrix, keyword: s.spillover.keyword } : null,
      warnings: parsed.warnings || [],
      datasetCount: parsed.datasetCount || 1,
    };
  }

  cmd_unload({ id }) {
    this.samples.delete(id);
    return { result: true };
  }

  cmd_ping() {
    return { result: { samples: this.samples.size } };
  }

  // ------------------------------------------------------------ state sync

  cmd_setTransforms({ transforms }) {
    const prev = this.transforms;
    this.transforms = transforms || {};
    const changed = new Set();
    const keys = new Set([...Object.keys(prev), ...Object.keys(this.transforms)]);
    for (const k of keys) if (transformKey(prev[k] || DEFAULT_SPEC) !== transformKey(this.transforms[k] || DEFAULT_SPEC)) changed.add(k);
    if (changed.size) for (const s of this.samples.values()) s.sigMemo.clear();
    return { result: { changed: [...changed] } };
  }

  cmd_setComp({ id, comp }) {
    const s = this.sample(id);
    const key = comp ? matrixKey(comp) : 'none';
    if (s.compKey() === key) return { result: { key, missing: s.comp ? s.comp.missing : [] } };
    if (!comp) {
      s.comp = null;
    } else {
      const idxAll = matchChannels(comp.names, s.channels);
      const keep = idxAll.map((k, j) => (k >= 0 ? j : -1)).filter((j) => j >= 0);
      const missing = comp.names.filter((_, j) => idxAll[j] < 0);
      const sub = keep.map((r) => keep.map((c) => comp.matrix[r][c]));
      const idx = keep.map((j) => idxAll[j]);
      const inv = invertMatrix(sub);
      const cols = compensateColumns(s.raw, idx, inv, s.N);
      const map = new Map();
      idx.forEach((k, j) => map.set(k, cols[j]));
      s.comp = { key, cols: map, missing };
    }
    s.invalidate();
    return { result: { key, missing: s.comp ? s.comp.missing : [] } };
  }

  cmd_setGates({ gates, overrides }) {
    this.gates = gates || [];
    this.gateById = new Map(this.gates.map((g) => [g.id, g]));
    const { ordered, invalid } = orderGates(this.gates);
    this.ordered = ordered;
    this.invalid = invalid;
    if (overrides) this.overrides = overrides;
    for (const s of this.samples.values()) s.sigMemo.clear();
    return { result: { invalid: [...invalid] } };
  }

  cmd_setOverrides({ overrides }) {
    this.overrides = overrides || {};
    for (const s of this.samples.values()) s.sigMemo.clear();
    return { result: true };
  }

  // ------------------------------------------------------------ evaluation

  spec(ch) {
    return this.transforms[ch] || DEFAULT_SPEC;
  }

  /** Channel values (compensated when applicable), including derived ratio parameters. */
  values(s, ch) {
    const v = s.values(ch);
    if (v) return v;
    const def = this.derived.get(ch);
    if (!def) return null;
    const key = derivedKey(def) + '|' + s.compKey();
    const c = s.derivedCols.get(ch);
    if (c && c.key === key) return c.arr;
    const x = s.values(def.x);
    const y = s.values(def.y);
    if (!x || !y) return null;
    const A = Number.isFinite(def.A) ? def.A : 1;
    const B = Number.isFinite(def.B) ? def.B : 0;
    const C = Number.isFinite(def.C) ? def.C : 0;
    const arr = new Float32Array(s.N);
    for (let i = 0; i < s.N; i++) arr[i] = (A * (x[i] - B)) / (y[i] - C);
    s.derivedCols.set(ch, { key, arr });
    return arr;
  }

  hasChannel(s, ch) {
    if (s.index.has(ch)) return true;
    const def = this.derived.get(ch);
    return !!(def && s.index.has(def.x) && s.index.has(def.y));
  }

  cmd_setDerived({ derived }) {
    const next = new Map((derived || []).map((d) => [d.name, d]));
    const changed = [];
    for (const [k, d] of next) if (!this.derived.has(k) || derivedKey(this.derived.get(k)) !== derivedKey(d)) changed.push(k);
    for (const k of this.derived.keys()) if (!next.has(k)) changed.push(k);
    this.derived = next;
    if (changed.length) {
      for (const s of this.samples.values()) {
        for (const k of changed) s.derivedCols.delete(k);
        s.scaled.clear();
        s.pops.clear();
        s.sigMemo.clear();
      }
    }
    return { result: { changed } };
  }

  scaled(s, ch) {
    const vals = this.values(s, ch);
    if (!vals) return null;
    const i = s.index.has(ch) ? s.index.get(ch) : `d:${ch}`;
    const spec = this.spec(ch);
    const def = this.derived.get(ch);
    const key = transformKey(spec) + '|' + s.compKey() + (def && !s.index.has(ch) ? '|' + derivedKey(def) : '');
    const c = s.scaled.get(i);
    if (c && c.key === key) return c.arr;
    const t = makeTransform(spec);
    const arr = t.scaleArray(vals, c && c.arr.length === s.N ? c.arr : new Float32Array(s.N));
    s.scaled.set(i, { key, arr });
    return arr;
  }

  /** Values on an arbitrary scale (for gates that carry their own scales). */
  scaledWith(s, ch, spec) {
    const tk = transformKey(spec);
    if (tk === transformKey(this.spec(ch))) return this.scaled(s, ch);
    const vals = this.values(s, ch);
    if (!vals) return null;
    const slot = `w:${ch}:${tk}`;
    const key = tk + '|' + s.compKey();
    const c = s.scaled.get(slot);
    if (c && c.key === key) return c.arr;
    const arr = makeTransform(spec).scaleArray(vals, new Float32Array(s.N));
    s.scaled.set(slot, { key, arr });
    return arr;
  }

  ctx(s) {
    return {
      N: s.N,
      values: (ch) => this.values(s, ch),
      scaled: (ch) => this.scaled(s, ch),
      transform: (ch) => makeTransform(this.spec(ch)),
      transformFor: (spec) => makeTransform(spec),
      scaledWith: (ch, spec) => this.scaledWith(s, ch, spec),
      pop: (id) => this.pop(s, id),
    };
  }

  effective(s, g) {
    const ov = this.overrides[s.id];
    return ov && ov[g.id] ? applyOverride(g, ov[g.id]) : g;
  }

  sig(s, id) {
    if (id === ROOT || !id) return 'root:' + s.N;
    const memo = s.sigMemo.get(id);
    if (memo) return memo;
    const g = this.gateById.get(id);
    if (!g || this.invalid.has(id)) return 'invalid';
    const eff = this.effective(s, g);
    let str = geometrySignature(eff) + '|' + s.compKey();
    for (const ch of [eff.x, eff.y]) if (ch && !s.index.has(ch) && this.derived.has(ch)) str += '|' + derivedKey(this.derived.get(ch));
    if (needsScale(eff)) {
      const [sx, sy] = evalSpecs(eff, this.transforms);
      str += '|' + transformKey(sx || DEFAULT_SPEC) + '|' + transformKey(sy || DEFAULT_SPEC);
    }
    for (const d of gateDeps(eff)) str += '|' + this.sig(s, d);
    str += '|' + this.sig(s, eff.parent || ROOT);
    const h = hashString(str);
    s.sigMemo.set(id, h);
    return h;
  }

  /** Event indices of a population (cached). */
  pop(s, id) {
    if (!id || id === ROOT) return s.root();
    const g = this.gateById.get(id);
    if (!g || this.invalid.has(id)) return new Uint32Array(0);
    const sig = this.sig(s, id);
    const cached = s.pops.get(id);
    if (cached && cached.sig === sig) return cached.idx;
    const parent = this.pop(s, g.parent || ROOT);
    let idx;
    let error = null;
    try {
      idx = evaluateGate(this.effective(s, g), parent, this.ctx(s));
    } catch (e) {
      idx = new Uint32Array(0);
      error = e.message || String(e);
    }
    s.pops.set(id, { sig, idx, error });
    return idx;
  }

  cmd_counts({ id }) {
    const s = this.sample(id);
    const counts = { root: s.N };
    const errors = {};
    for (const g of this.ordered) {
      const idx = this.pop(s, g.id);
      counts[g.id] = idx.length;
      const c = s.pops.get(g.id);
      if (c && c.error) errors[g.id] = c.error;
    }
    for (const gid of this.invalid) {
      counts[gid] = 0;
      errors[gid] = 'This gate depends on a missing or circular population.';
    }
    return { result: { counts, errors } };
  }

  // ------------------------------------------------------------ plotting

  cmd_plot({ id, req }) {
    const s = this.sample(id);
    const idx = this.pop(s, req.pop);
    const missing = [];
    if (req.x && !this.hasChannel(s, req.x)) missing.push(req.x);
    if (req.y && !this.hasChannel(s, req.y)) missing.push(req.y);
    if (missing.length) return { result: { missing, n: idx.length, total: s.N } };
    const transfer = [];
    if (req.y) {
      const w = Math.max(1, Math.min(2048, req.w | 0));
      const h = Math.max(1, Math.min(2048, req.h | 0));
      const sx = this.scaled(s, req.x);
      const sy = this.scaled(s, req.y);
      const counts = bin2d(idx, sx, sy, w, h);
      transfer.push(counts.buffer);
      const overlays = (req.overlays || []).map((oid) => {
        const oidx = this.pop(s, oid);
        const c = bin2d(oidx, sx, sy, w, h);
        transfer.push(c.buffer);
        return { id: oid, counts: c, n: oidx.length };
      });
      return { result: { kind: '2d', w, h, counts, overlays, n: idx.length, total: s.N }, transfer };
    }
    const bins = Math.max(8, Math.min(4096, req.bins | 0 || 256));
    const sx = this.scaled(s, req.x);
    const counts = bin1d(idx, sx, bins);
    transfer.push(counts.buffer);
    const overlays = (req.overlays || []).map((oid) => {
      const oidx = this.pop(s, oid);
      const c = bin1d(oidx, sx, bins);
      transfer.push(c.buffer);
      return { id: oid, counts: c, n: oidx.length };
    });
    return { result: { kind: '1d', bins, counts, overlays, n: idx.length, total: s.N }, transfer };
  }

  /** Several small plots in one call (compensation matrix preview, batch layouts). */
  cmd_plots({ id, reqs }) {
    const out = [];
    const transfer = [];
    for (const req of reqs) {
      const r = this.cmd_plot({ id, req });
      out.push(r.result);
      if (r.transfer) transfer.push(...r.transfer);
    }
    return { result: out, transfer };
  }

  // ------------------------------------------------------------ statistics

  cmd_stats({ id, reqs }) {
    const s = this.sample(id);
    const groups = new Map();
    reqs.forEach((r, i) => {
      const key = r.pop + '\u0001' + r.channel;
      if (!groups.has(key)) groups.set(key, { pop: r.pop, channel: r.channel, items: [] });
      groups.get(key).items.push({ i, stat: r.stat, arg: r.arg });
    });
    const values = new Array(reqs.length).fill(null);
    for (const gr of groups.values()) {
      const vals = this.values(s, gr.channel);
      if (!vals) continue;
      const idx = this.pop(s, gr.pop);
      const needMode = gr.items.some((it) => it.stat === 'mode');
      const res = channelStats(vals, idx, gr.items, needMode ? this.scaled(s, gr.channel) : null, needMode ? makeTransform(this.spec(gr.channel)) : null);
      for (const it of gr.items) {
        const key = it.stat === 'percentile' ? `percentile:${it.arg ?? 50}` : it.stat;
        values[it.i] = res[key];
      }
    }
    return { result: values };
  }

  /** Suggest a Logicle width for a channel from current (compensated) data. */
  cmd_estimateW({ id, channel, T, M = 4.5, A = 0, pop }) {
    const s = this.sample(id);
    const v = this.values(s, channel);
    if (!v) return { result: null };
    const idx = this.pop(s, pop || ROOT);
    const vals = quickSample(subset(v, idx), 60000);
    return { result: estimateLogicleW(vals, T, M, A) };
  }

  cmd_quantiles({ id, channel, pop, ps, raw = false }) {
    const s = this.sample(id);
    const v = raw ? s.rawValues(channel) : this.values(s, channel);
    if (!v) return { result: null };
    const idx = this.pop(s, pop || ROOT);
    const vals = subset(v, idx).sort();
    return { result: ps.map((p) => percentileSorted(vals, p)) };
  }

  /**
   * Medians of uncompensated detector values for one single-stain control.
   * Positive events are above `threshold` in the primary detector (or the
   * top `posFrac` when no threshold is given); the negative reference is the
   * bottom `negFrac` unless `internalNeg` is false.
   */
  cmd_controlMedians({ id, pop, primary, channels, threshold = null, posFrac = 0.25, negFrac = 0.3, internalNeg = true, satFrac = 0.98 }) {
    const s = this.sample(id);
    const pv = s.rawValues(primary);
    if (!pv) return { result: { error: `${primary} is not in ${s.name}` } };
    const idx = this.pop(s, pop || ROOT);
    const ch = s.channels[s.index.get(primary)];
    const sat = (ch.range > 0 ? ch.range : Infinity) * satFrac;
    const vals = subset(pv, idx).sort();
    let thr = threshold;
    if (thr === null || thr === undefined) thr = percentileSorted(vals, 100 * (1 - posFrac));
    const negThr = percentileSorted(vals, 100 * negFrac);
    const pos = [];
    const neg = [];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const v = pv[i];
      if (v > thr && v < sat) pos.push(i);
      else if (internalNeg && v <= negThr) neg.push(i);
    }
    const med = (list) => {
      const out = {};
      for (const c of channels) {
        const cv = s.rawValues(c);
        if (!cv) {
          out[c] = NaN;
          continue;
        }
        const arr = new Float32Array(list.length);
        for (let k = 0; k < list.length; k++) arr[k] = cv[list[k]];
        arr.sort();
        out[c] = percentileSorted(arr, 50);
      }
      return out;
    };
    return { result: { pos: med(pos), neg: internalNeg ? med(neg) : null, nPos: pos.length, nNeg: neg.length, threshold: thr } };
  }

  /** Medians of uncompensated values for several channels in a population. */
  cmd_medians({ id, pop, channels }) {
    const s = this.sample(id);
    const idx = this.pop(s, pop || ROOT);
    const out = {};
    for (const c of channels) {
      const v = s.rawValues(c);
      out[c] = v ? percentileSorted(subset(v, idx).sort(), 50) : NaN;
    }
    return { result: { medians: out, n: idx.length } };
  }

  // ------------------------------------------------------------ export

  cmd_exportFCS({ id, pop, compensated = false, extra = {}, spillover, channels = null }) {
    const s = this.sample(id);
    const idx = this.pop(s, pop || ROOT);
    const chans = channels ? s.channels.filter((c) => channels.includes(c.name)) : s.channels;
    const cols = chans.map((c) => (compensated ? s.values(c.name) : s.raw[s.index.get(c.name)]));
    const bytes = writeFCS({
      channels: chans,
      columns: cols,
      nEvents: s.N,
      indices: pop && pop !== ROOT ? idx : null,
      keywords: s.keywords,
      spillover: compensated ? null : spillover === undefined ? s.spillover : spillover,
      extra,
    });
    return { result: { buffer: bytes.buffer, n: idx.length }, transfer: [bytes.buffer] };
  }

  cmd_exportCSV({ id, pop, channels = null, values = 'comp', header = 'name' }) {
    const s = this.sample(id);
    const idx = this.pop(s, pop || ROOT);
    const chans = channels ? s.channels.filter((c) => channels.includes(c.name)) : s.channels;
    const cols = chans.map((c) => (values === 'raw' ? s.raw[s.index.get(c.name)] : values === 'scaled' ? this.scaled(s, c.name) : s.values(c.name)));
    const head = chans.map((c) => (header === 'both' && c.label ? `${c.name} :: ${c.label}` : c.name));
    // Build in chunks to keep memory reasonable
    const parts = [toCSV([head])];
    const chunk = 20000;
    for (let start = 0; start < idx.length; start += chunk) {
      const end = Math.min(idx.length, start + chunk);
      const rows = [];
      for (let k = start; k < end; k++) {
        const i = idx[k];
        const row = new Array(cols.length);
        for (let p = 0; p < cols.length; p++) {
          const v = cols[p][i];
          row[p] = Number.isFinite(v) ? Math.round(v * 1000) / 1000 : '';
        }
        rows.push(row);
      }
      parts.push(toCSV(rows));
    }
    const bytes = new TextEncoder().encode(parts.join(''));
    return { result: { buffer: bytes.buffer, n: idx.length }, transfer: [bytes.buffer] };
  }

  /** Event values (scaled) for a population; used for small dot overlays. */
  cmd_events({ id, pop, channels, max = 5000 }) {
    const s = this.sample(id);
    const idx = this.pop(s, pop || ROOT);
    const n = Math.min(idx.length, max);
    const step = idx.length / Math.max(1, n);
    const out = channels.map((c) => {
      const sc = this.scaled(s, c);
      const arr = new Float32Array(n);
      if (sc) for (let k = 0; k < n; k++) arr[k] = sc[idx[Math.floor(k * step)]];
      return arr;
    });
    return { result: { n, columns: out }, transfer: out.map((a) => a.buffer) };
  }
}

export function derivedKey(d) {
  return `${d.kind || 'ratio'}:${d.x}:${d.y}:${d.A ?? 1}:${d.B ?? 0}:${d.C ?? 0}`;
}

/** Only the fields that change which events a gate selects. */
export function geometrySignature(g) {
  return JSON.stringify([g.type, g.x || null, g.y || null, g.parent || null, g.rect || null, g.polygon || null, g.ellipse || null, g.range || null, g.boolean || null, g.scale || null]);
}

function bin2d(idx, sx, sy, w, h) {
  const counts = new Uint32Array(w * h);
  for (let k = 0, n = idx.length; k < n; k++) {
    const i = idx[k];
    let a = sx[i];
    let b = sy[i];
    a = a > 0 ? (a < 1 ? a : 1) : 0;
    b = b > 0 ? (b < 1 ? b : 1) : 0;
    let bx = (a * w) | 0;
    let by = (b * h) | 0;
    if (bx >= w) bx = w - 1;
    if (by >= h) by = h - 1;
    counts[by * w + bx]++;
  }
  return counts;
}

function bin1d(idx, sx, bins) {
  const counts = new Float64Array(bins);
  for (let k = 0, n = idx.length; k < n; k++) {
    let a = sx[idx[k]];
    a = a > 0 ? (a < 1 ? a : 1) : 0;
    let b = (a * bins) | 0;
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  return counts;
}

export { normalizeSpec };
