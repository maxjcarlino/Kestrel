// Hyperlog scale (Bagwell 2005) as defined in Gating-ML 2.0:
//   hyperlog(x, T, W, M, A) = root(EH(y) - x)
//   EH(y) = a·e^(b·y) + c·y − f            for y >= x1
//   EH(y) = −EH(2·x1 − y)                  for y <  x1
// with w = W/(M+A), x2 = A/(M+A), x1 = x2 + w, x0 = x2 + 2w, b = (M+A)·ln10,
//      e0 = e^(b·x0), ca = e0/w, fa = e^(b·x1) + ca·x1,
//      a = T/(e^b + ca − fa), c = ca·a, f = fa·a.
// scale(T) = 1 and scale(0) = x1, like Logicle. Constants match the reference
// implementation used by flowutils/FlowKit (verified against the Gating-ML 2.0
// compliance results).

const LN10 = Math.LN10;

export class Hyperlog {
  constructor(T, W, M = 4.5, A = 0) {
    if (!(T > 0)) throw new Error('Hyperlog T must be greater than zero');
    if (!(W > 0)) throw new Error('Hyperlog W must be greater than zero');
    if (!(M > 0)) throw new Error('Hyperlog M must be greater than zero');
    if (2 * W > M) throw new Error('Hyperlog W is too large (2W must not exceed M)');
    if (-A > W || A + 2 * W > M) throw new Error('Hyperlog A is out of range');
    this.T = T;
    this.W = W;
    this.M = M;
    this.A = A;
    const w = W / (M + A);
    const x2 = A / (M + A);
    const x1 = x2 + w;
    const x0 = x2 + 2 * w;
    const b = (M + A) * LN10;
    const e0 = Math.exp(b * x0);
    const ca = e0 / w;
    const fa = Math.exp(b * x1) + ca * x1;
    const a = T / (Math.exp(b) + ca - fa);
    this.x1 = x1;
    this.b = b;
    this.a = a;
    this.c = ca * a;
    this.f = fa * a;
  }

  eh(y) {
    if (y >= this.x1) return this.a * Math.exp(this.b * y) + this.c * y - this.f;
    const r = 2 * this.x1 - y;
    return -(this.a * Math.exp(this.b * r) + this.c * r - this.f);
  }

  /** derivative of EH (always positive) */
  deh(y) {
    const r = y >= this.x1 ? y : 2 * this.x1 - y;
    return this.a * this.b * Math.exp(this.b * r) + this.c;
  }

  inverse(s) {
    return Number.isNaN(s) ? NaN : this.eh(s);
  }

  scale(x) {
    if (Number.isNaN(x)) return NaN;
    if (x === Infinity) return Infinity;
    if (x === -Infinity) return -Infinity;
    if (x === 0) return this.x1;
    const neg = x < 0;
    const v = neg ? -x : x;
    // initial guess: logarithmic far from zero, linear near zero
    let y = v > this.f ? Math.log((v + this.f) / this.a) / this.b : this.x1 + v / this.deh(this.x1);
    let lo = this.x1;
    let hi = Math.max(this.x1 + 1e-9, y);
    while (this.eh(hi) < v) hi = this.x1 + (hi - this.x1) * 2 + 0.1;
    if (y < lo || y > hi) y = (lo + hi) / 2;
    for (let i = 0; i < 60; i++) {
      const fy = this.eh(y) - v;
      if (fy > 0) hi = y;
      else lo = y;
      let next = y - fy / this.deh(y);
      if (!(next > lo && next < hi)) next = (lo + hi) / 2;
      if (Math.abs(next - y) < 1e-15 * Math.max(1, Math.abs(y))) {
        y = next;
        break;
      }
      y = next;
    }
    return neg ? 2 * this.x1 - y : y;
  }
}

/** Vectorised scaling through a monotone lookup table (as FastLogicle). */
export class FastHyperlog {
  constructor(h, { lo = -0.25, hi = 1.25, bins = 16384 } = {}) {
    this.h = h;
    this.lo = lo;
    this.bins = bins;
    this.step = (hi - lo) / bins;
    const t = new Float64Array(bins + 1);
    for (let i = 0; i <= bins; i++) t[i] = h.eh(lo + i * this.step);
    this.table = t;
    this.vmin = t[0];
    this.vmax = t[bins];
  }

  scaleArray(src, dst = new Float32Array(src.length)) {
    const t = this.table;
    const bins = this.bins;
    for (let k = 0, n = src.length; k < n; k++) {
      const v = src[k];
      if (!(v > this.vmin && v < this.vmax)) {
        dst[k] = this.h.scale(v);
        continue;
      }
      let a = 0;
      let b = bins;
      while (b - a > 1) {
        const m = (a + b) >> 1;
        if (t[m] <= v) a = m;
        else b = m;
      }
      dst[k] = this.lo + (a + (v - t[a]) / (t[b] - t[a])) * this.step;
    }
    return dst;
  }
}
