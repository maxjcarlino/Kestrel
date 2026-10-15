// Logicle (biexponential) scale.
//
// A faithful port of the reference implementation described in
//   Moore WA, Parks DR. "Update for the logicle data scale including
//   operational code implementations." Cytometry A 2012;81A:273-277.
// and Parks DR, Roederer M, Moore WA. "A new 'Logicle' display method avoids
//   deceptive effects of logarithmic scaling for low signals and compensated
//   data." Cytometry A 2006;69A:541-551.
//
// Parameters (same meaning as Gating-ML 2.0 `logicle`):
//   T  top of scale data value (e.g. 262144)
//   W  width of the linearization zone in decades
//   M  total width of the display in decades (typically 4.5)
//   A  additional decades of negative data
//
// scale(T) === 1, scale(0) === (W + A) / (M + A). Values outside [0, 1] are
// valid and represent data above T or below the bottom of the display.

const TAYLOR_LENGTH = 16;
const LN10 = Math.LN10;
const EPS = Number.EPSILON;

export class LogicleError extends Error {}

export class Logicle {
  constructor(T, W, M = 4.5, A = 0) {
    if (!(T > 0)) throw new LogicleError('Logicle T must be greater than zero');
    if (!(W >= 0)) throw new LogicleError('Logicle W must not be negative');
    if (!(M > 0)) throw new LogicleError('Logicle M must be greater than zero');
    if (2 * W > M) throw new LogicleError('Logicle W is too large (2W must not exceed M)');
    if (-A > W || A + W > M - W) throw new LogicleError('Logicle A is out of range');

    this.T = T;
    this.W = W;
    this.M = M;
    this.A = A;

    // Formulas from the biexponential paper
    const w = W / (M + A);
    const x2 = A / (M + A);
    const x1 = x2 + w;
    const x0 = x2 + 2 * w;
    const b = (M + A) * LN10;
    const d = solve(b, w);
    const cA = Math.exp(x0 * (b + d));
    const mfA = Math.exp(b * x1) - cA / Math.exp(d * x1);
    const a = T / ((Math.exp(b) - mfA) - cA / Math.exp(d));
    const c = cA * a;
    const f = -mfA * a;

    this.w = w; this.x0 = x0; this.x1 = x1; this.x2 = x2;
    this.a = a; this.b = b; this.c = c; this.d = d; this.f = f;

    // Taylor series around x1 avoids round-off problems near data zero
    this.xTaylor = x1 + w / 4;
    let posCoef = a * Math.exp(b * x1);
    let negCoef = -c / Math.exp(d * x1);
    const taylor = new Float64Array(TAYLOR_LENGTH);
    for (let i = 0; i < TAYLOR_LENGTH; ++i) {
      posCoef *= b / (i + 1);
      negCoef *= -d / (i + 1);
      taylor[i] = posCoef + negCoef;
    }
    taylor[1] = 0; // exact result of the Logicle condition
    this.taylor = taylor;
  }

  seriesBiexponential(scale) {
    const x = scale - this.x1;
    const t = this.taylor;
    let sum = t[TAYLOR_LENGTH - 1] * x;
    for (let i = TAYLOR_LENGTH - 2; i >= 2; --i) sum = (sum + t[i]) * x;
    return (sum * x + t[0]) * x;
  }

  /** Data value -> scale value (exact, Halley's method). */
  scale(value) {
    if (value === 0) return this.x1;
    if (Number.isNaN(value)) return NaN;
    if (value === Infinity) return Infinity;
    if (value === -Infinity) return -Infinity;
    const negative = value < 0;
    if (negative) value = -value;

    let x;
    if (value < this.f) x = this.x1 + value / this.taylor[0];
    else x = Math.log(value / this.a) / this.b;

    let tolerance = 3 * EPS;
    if (x > 1) tolerance = 3 * x * EPS;

    for (let i = 0; i < 40; ++i) {
      const ae2bx = this.a * Math.exp(this.b * x);
      const ce2mdx = this.c / Math.exp(this.d * x);
      let y;
      if (x < this.xTaylor) y = this.seriesBiexponential(x) - value;
      else y = (ae2bx + this.f) - (ce2mdx + value);
      const abe2bx = this.b * ae2bx;
      const cde2mdx = this.d * ce2mdx;
      const dy = abe2bx + cde2mdx;
      const ddy = this.b * abe2bx - this.d * cde2mdx;
      const delta = y / (dy * (1 - (y * ddy) / (2 * dy * dy)));
      x -= delta;
      if (Math.abs(delta) < tolerance) break;
    }
    return negative ? 2 * this.x1 - x : x;
  }

  /** Scale value -> data value. */
  inverse(scale) {
    if (Number.isNaN(scale)) return NaN;
    const negative = scale < this.x1;
    if (negative) scale = 2 * this.x1 - scale;
    let inv;
    if (scale < this.xTaylor) inv = this.seriesBiexponential(scale);
    else inv = (this.a * Math.exp(this.b * scale) + this.f) - this.c / Math.exp(this.d * scale);
    return negative ? -inv : inv;
  }

  /** Derivative of the inverse (data units per scale unit). */
  slope(scale) {
    if (scale < this.x1) scale = 2 * this.x1 - scale;
    return this.a * this.b * Math.exp(this.b * scale) + (this.c * this.d) / Math.exp(this.d * scale);
  }

  /** Data value at the bottom of the display (scale 0). */
  get bottom() {
    return this.inverse(0);
  }
}

// Root of f(d) = 2 (ln d - ln b) + w (b + d); based on RTSAFE.
function solve(b, w) {
  if (w === 0) return b; // pure arcsinh
  const tolerance = 2 * b * EPS;
  let dLo = 0;
  let dHi = b;
  let d = (dLo + dHi) / 2;
  let lastDelta = dHi - dLo;
  let delta;
  const fB = -2 * Math.log(b) + w * b;
  let f = 2 * Math.log(d) + w * d + fB;
  let lastF = NaN;
  for (let i = 1; i < 100; ++i) {
    const df = 2 / d + w;
    if (((d - dHi) * df - f) * ((d - dLo) * df - f) >= 0 || Math.abs(1.9 * f) > Math.abs(lastDelta * df)) {
      delta = (dHi - dLo) / 2;
      d = dLo + delta;
      if (d === dLo) return d;
    } else {
      delta = f / df;
      const t = d;
      d -= delta;
      if (d === t) return d;
    }
    if (Math.abs(delta) < tolerance) return d;
    lastDelta = delta;
    f = 2 * Math.log(d) + w * d + fB;
    if (f === 0 || f === lastF) return d;
    lastF = f;
    if (f < 0) dLo = d;
    else dHi = d;
  }
  return d;
}

/**
 * Fast vectorised scaling. Builds a monotone lookup table of the inverse
 * function over an extended scale range and interpolates; values outside the
 * table fall back to the exact solver. Interpolation error is far below
 * display and gating resolution (< 1e-6 scale units).
 */
export class FastLogicle {
  constructor(logicle, { lo = -0.25, hi = 1.25, bins = 16384 } = {}) {
    this.l = logicle;
    this.lo = lo;
    this.hi = hi;
    this.bins = bins;
    const table = new Float64Array(bins + 1);
    const step = (hi - lo) / bins;
    for (let i = 0; i <= bins; i++) table[i] = logicle.inverse(lo + i * step);
    this.table = table;
    this.step = step;
    this.vmin = table[0];
    this.vmax = table[bins];
  }

  scale(v) {
    if (!(v > this.vmin && v < this.vmax)) {
      return this.l.scale(v);
    }
    const t = this.table;
    let lo = 0;
    let hi = this.bins;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= v) lo = mid;
      else hi = mid;
    }
    const t0 = t[lo];
    const frac = (v - t0) / (t[hi] - t0);
    return this.lo + (lo + frac) * this.step;
  }

  scaleArray(src, dst = new Float32Array(src.length)) {
    const t = this.table;
    const bins = this.bins;
    const vmin = this.vmin;
    const vmax = this.vmax;
    const lo0 = this.lo;
    const step = this.step;
    const l = this.l;
    const n = src.length;
    for (let k = 0; k < n; k++) {
      const v = src[k];
      if (!(v > vmin && v < vmax)) {
        dst[k] = l.scale(v);
        continue;
      }
      let lo = 0;
      let hi = bins;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (t[mid] <= v) lo = mid;
        else hi = mid;
      }
      const t0 = t[lo];
      dst[k] = lo0 + (lo + (v - t0) / (t[hi] - t0)) * step;
    }
    return dst;
  }
}

/**
 * Estimate the Logicle width W from data, following the approach used by
 * flowCore's estimateLogicle (Parks et al. 2006): use the 5th percentile of
 * the negative values to size the linear zone.
 */
export function estimateLogicleW(values, T, M = 4.5, A = 0, q = 0.05) {
  const neg = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < 0) neg.push(v);
  }
  if (neg.length < 10) return 0;
  neg.sort((x, y) => x - y);
  const idx = Math.min(neg.length - 1, Math.max(0, Math.floor(q * (neg.length - 1))));
  const r = Math.abs(neg[idx]) + EPS;
  let w = (M - Math.log10(T / r)) / 2;
  if (!Number.isFinite(w) || w < 0) w = 0;
  const wMax = (M - Math.max(0, -A)) / 2;
  if (w > wMax) w = wMax;
  if (w > M / 2) w = M / 2;
  if (-A > w) w = -A;
  return Math.round(w * 100) / 100;
}
