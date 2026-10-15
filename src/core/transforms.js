// Display / gating scales.
//
// Every transform maps a data value to a "scale" value where the visible axis
// spans [0, 1]. The definitions follow Gating-ML 2.0 so that gates can be
// exchanged with other software:
//   linear  -> flin(T = max, A = -min)
//   log     -> flog(T = max, M = decades)
//   logicle -> logicle(T, W, M, A)
//   hyperlog -> hyperlog(T, W, M, A)
//   arcsinh -> fasinh(T = max, M, A) parameterised by cofactor, max and min

import { Logicle, FastLogicle } from './logicle.js';
import { Hyperlog, FastHyperlog } from './hyperlog.js';

export const TRANSFORM_TYPES = ['linear', 'log', 'logicle', 'hyperlog', 'arcsinh'];
export const TRANSFORM_LABELS = { linear: 'Linear', log: 'Log', logicle: 'Logicle', hyperlog: 'Hyperlog', arcsinh: 'Arcsinh' };

const LN10 = Math.LN10;

export function normalizeSpec(spec) {
  const s = spec || { type: 'linear' };
  switch (s.type) {
    case 'log': {
      const max = pos(s.max, 262144);
      const decades = clamp(num(s.decades, 4.5), 0.5, 12);
      return { type: 'log', max, decades };
    }
    case 'logicle': {
      const T = pos(s.T, 262144);
      const M = clamp(num(s.M, 4.5), 1, 12);
      let W = clamp(num(s.W, 0.5), 0, M / 2);
      let A = num(s.A, 0);
      if (A < -W) A = -W;
      if (A + 2 * W > M) A = M - 2 * W;
      return { type: 'logicle', T, W: round(W, 4), M: round(M, 4), A: round(A, 4) };
    }
    case 'hyperlog': {
      const T = pos(s.T, 262144);
      const M = clamp(num(s.M, 4.5), 1, 12);
      let W = clamp(num(s.W, 1), 0.01, M / 2);
      let A = num(s.A, 0);
      if (A < -W) A = -W;
      if (A + 2 * W > M) A = M - 2 * W;
      return { type: 'hyperlog', T, W: round(W, 4), M: round(M, 4), A: round(A, 4) };
    }
    case 'arcsinh': {
      const cofactor = pos(s.cofactor, 150);
      const max = pos(s.max, 262144);
      let min = num(s.min, -cofactor * 2);
      if (min >= max) min = max - Math.abs(max) * 0.5 - 1;
      return { type: 'arcsinh', cofactor, max, min };
    }
    case 'linear':
    default: {
      let min = num(s.min, 0);
      let max = num(s.max, 262144);
      if (!(max > min)) max = min + 1;
      return { type: 'linear', min, max };
    }
  }
}

export function transformKey(spec) {
  const s = normalizeSpec(spec);
  switch (s.type) {
    case 'log': return `log:${s.max}:${s.decades}`;
    case 'logicle': return `logicle:${s.T}:${s.W}:${s.M}:${s.A}`;
    case 'hyperlog': return `hyperlog:${s.T}:${s.W}:${s.M}:${s.A}`;
    case 'arcsinh': return `arcsinh:${s.cofactor}:${s.max}:${s.min}`;
    default: return `linear:${s.min}:${s.max}`;
  }
}

class LinearTransform {
  constructor(s) {
    this.spec = s;
    this.min = s.min;
    this.max = s.max;
    this.span = s.max - s.min;
  }
  scale(x) { return (x - this.min) / this.span; }
  inverse(s) { return this.min + s * this.span; }
  scaleArray(src, dst = new Float32Array(src.length)) {
    const m = this.min;
    const k = 1 / this.span;
    for (let i = 0, n = src.length; i < n; i++) dst[i] = (src[i] - m) * k;
    return dst;
  }
  ticks() { return linearTicks(this.min, this.max, (v) => this.scale(v)); }
}

class LogTransform {
  constructor(s) {
    this.spec = s;
    this.T = s.max;
    this.M = s.decades;
    this.lo = s.max / Math.pow(10, s.decades);
  }
  scale(x) {
    if (!(x > 0)) return x === x ? -Infinity : NaN;
    return Math.log10(x / this.T) / this.M + 1;
  }
  inverse(s) { return this.T * Math.pow(10, (s - 1) * this.M); }
  scaleArray(src, dst = new Float32Array(src.length)) {
    const kT = 1 / this.T;
    const kM = 1 / (this.M * LN10);
    for (let i = 0, n = src.length; i < n; i++) {
      const x = src[i];
      dst[i] = x > 0 ? Math.log(x * kT) * kM + 1 : -Infinity;
    }
    return dst;
  }
  ticks() {
    const out = [];
    const e0 = Math.floor(Math.log10(this.lo));
    const e1 = Math.ceil(Math.log10(this.T));
    for (let e = e0; e <= e1; e++) {
      const base = Math.pow(10, e);
      for (let m = 1; m <= 9; m++) {
        const v = m * base;
        const s = this.scale(v);
        if (s < -1e-9 || s > 1 + 1e-9) continue;
        out.push({ v, s, major: m === 1, label: m === 1 ? decadeLabel(1, e) : null, priority: m === 1 ? 10 + e : 0 });
      }
    }
    return out;
  }
}

class LogicleTransform {
  constructor(s) {
    this.spec = s;
    this.l = new Logicle(s.T, s.W, s.M, s.A);
    this._fast = null;
  }
  get fast() {
    if (!this._fast) this._fast = new FastLogicle(this.l);
    return this._fast;
  }
  scale(x) { return this.l.scale(x); }
  inverse(s) { return this.l.inverse(s); }
  scaleArray(src, dst) { return this.fast.scaleArray(src, dst); }
  ticks() { return decadeTicks(this); }
}

class HyperlogTransform {
  constructor(s) {
    this.spec = s;
    this.h = new Hyperlog(s.T, s.W, s.M, s.A);
    this._fast = null;
  }
  scale(x) { return this.h.scale(x); }
  inverse(s) { return this.h.inverse(s); }
  scaleArray(src, dst) {
    if (!this._fast) this._fast = new FastHyperlog(this.h);
    return this._fast.scaleArray(src, dst);
  }
  ticks() { return decadeTicks(this); }
}

class ArcsinhTransform {
  constructor(s) {
    this.spec = s;
    this.c = s.cofactor;
    this.a0 = Math.asinh(s.min / s.cofactor);
    this.a1 = Math.asinh(s.max / s.cofactor);
    this.span = this.a1 - this.a0;
  }
  scale(x) { return (Math.asinh(x / this.c) - this.a0) / this.span; }
  inverse(s) { return this.c * Math.sinh(this.a0 + s * this.span); }
  scaleArray(src, dst = new Float32Array(src.length)) {
    const ic = 1 / this.c;
    const a0 = this.a0;
    const k = 1 / this.span;
    for (let i = 0, n = src.length; i < n; i++) dst[i] = (Math.asinh(src[i] * ic) - a0) * k;
    return dst;
  }
  ticks() { return decadeTicks(this); }
  /** Gating-ML 2.0 fasinh parameters equivalent to this transform. */
  gatingML() {
    const T = this.spec.max;
    const M = Math.asinh(T / this.c) / LN10;
    const A = Math.asinh(-this.spec.min / this.c) / LN10;
    return { T, M, A };
  }
}

const cache = new Map();

/** Create (or reuse) a transform object for a spec. */
export function makeTransform(spec) {
  const s = normalizeSpec(spec);
  const key = transformKey(s);
  let t = cache.get(key);
  if (t) return t;
  switch (s.type) {
    case 'log': t = new LogTransform(s); break;
    case 'logicle': t = new LogicleTransform(s); break;
    case 'hyperlog': t = new HyperlogTransform(s); break;
    case 'arcsinh': t = new ArcsinhTransform(s); break;
    default: t = new LinearTransform(s);
  }
  t.key = key;
  t.type = s.type;
  if (cache.size > 500) cache.clear();
  cache.set(key, t);
  return t;
}

/** Convert a Gating-ML fasinh(T, M, A) definition to our arcsinh spec. */
export function arcsinhFromGatingML(T, M, A) {
  const cofactor = T / Math.sinh(M * LN10);
  const min = -cofactor * Math.sinh(A * LN10);
  return normalizeSpec({ type: 'arcsinh', cofactor, max: T, min });
}

/** Human readable summary such as "Logicle · W 0.6". */
export function describeSpec(spec) {
  const s = normalizeSpec(spec);
  switch (s.type) {
    case 'log': return `Log · ${fmtNum(s.decades)} decades`;
    case 'logicle': return `Logicle · W ${fmtNum(s.W)}`;
    case 'hyperlog': return `Hyperlog · W ${fmtNum(s.W)}`;
    case 'arcsinh': return `Arcsinh · cofactor ${fmtNum(s.cofactor)}`;
    default: return `Linear · ${formatValue(s.min)} to ${formatValue(s.max)}`;
  }
}

// ---------------------------------------------------------------- ticks

const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };

export function decadeLabel(sign, e) {
  const sup = String(e).split('').map((c) => SUP[c] || c).join('');
  return `${sign < 0 ? '−' : ''}10${sup}`;
}

function decadeTicks(t) {
  const out = [];
  const lo = t.inverse(0);
  const hi = t.inverse(1);
  out.push({ v: 0, s: t.scale(0), major: true, label: '0', priority: 100 });
  const maxPos = Math.floor(Math.log10(Math.max(hi, 1)));
  for (let e = 0; e <= maxPos + 1; e++) {
    const base = Math.pow(10, e);
    for (let m = 1; m <= 9; m++) {
      const v = m * base;
      if (v > hi * 1.0000001) break;
      const s = t.scale(v);
      if (s < 0 || s > 1.0000001) continue;
      out.push({ v, s, major: m === 1, label: m === 1 ? decadeLabel(1, e) : null, priority: m === 1 ? 10 + e : 0 });
    }
  }
  if (lo < 0) {
    const maxNeg = Math.floor(Math.log10(-lo));
    for (let e = 0; e <= maxNeg; e++) {
      const base = Math.pow(10, e);
      for (let m = 1; m <= 9; m++) {
        const v = -m * base;
        if (v < lo * 1.0000001) break;
        const s = t.scale(v);
        if (s < 0 || s > 1) continue;
        out.push({ v, s, major: m === 1, label: m === 1 ? decadeLabel(-1, e) : null, priority: m === 1 ? 5 + e : 0 });
      }
    }
  }
  return out;
}

function linearTicks(min, max, scale) {
  const span = max - min;
  const raw = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if (norm < 1.5) step = 1 * mag;
  else if (norm < 2.25) step = 2 * mag;
  else if (norm < 3.5) step = 2.5 * mag;
  else if (norm < 7.5) step = 5 * mag;
  else step = 10 * mag;
  const out = [];
  const first = Math.ceil(min / step - 1e-9) * step;
  for (let v = first, i = 0; v <= max + step * 1e-9 && i < 100; v += step, i++) {
    const vv = Math.abs(v) < step * 1e-9 ? 0 : v;
    out.push({ v: vv, s: scale(vv), major: true, label: formatValue(vv, step), priority: 10 });
    const half = vv + step / 2;
    if (half <= max) out.push({ v: half, s: scale(half), major: false, label: null, priority: 0 });
  }
  if (first - step / 2 >= min) out.push({ v: first - step / 2, s: scale(first - step / 2), major: false, label: null, priority: 0 });
  return out;
}

/** Compact number for axis labels and summaries: 0, 50K, 1.5M, 0.25. */
export function formatValue(v, step) {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : '–';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a === 0) return '0';
  if (a >= 1e6 && (step === undefined || step >= 1e5)) return sign + trim(a / 1e6, step ? step / 1e6 : null) + 'M';
  if (a >= 1e3 && (step === undefined || step >= 100)) return sign + trim(a / 1e3, step ? step / 1e3 : null) + 'K';
  return sign + trim(a, step || null);
}

function trim(x, step) {
  let digits = 2;
  if (step) digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9) + 1));
  else if (x >= 100) digits = 0;
  else if (x >= 10) digits = 1;
  let s = x.toFixed(digits);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function fmtNum(x, digits = 3) {
  if (!Number.isFinite(x)) return String(x);
  const s = Number(x.toPrecision(digits));
  return String(s);
}

// ---------------------------------------------------------------- utils

function num(v, d) {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(x) ? x : d;
}
function pos(v, d) {
  const x = num(v, d);
  return x > 0 ? x : d;
}
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function round(x, d) { const k = Math.pow(10, d); return Math.round(x * k) / k; }
