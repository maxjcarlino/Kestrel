// Automatic pre-gating: the standard front end of almost every panel,
//   Cells     FSC-A × SSC-A       debris (low FSC) and saturated events out
//   Singlets  FSC-A × FSC-H       doublets (too little height for their area) out
//   Live      viability × SSC-A   dye-bright (dead) cells out
// found from the data rather than drawn by hand.
//
// Everything here works on a sample of events already on the display scale
// (0..1, the same space plots are drawn in), with the channels' transforms to
// turn the result back into data units for the gate definitions. Pure
// functions with no DOM or engine access, so they run (and are tested) in
// Node as well as the browser.

import { pointInPolygon } from './gate-geometry.js';
import { EDGE_LO } from './gates.js';

const SAT = 0.995; // at or beyond this a scatter value is saturated (piled at the top)

// ------------------------------------------------------------------ helpers

function hist1d(vals, keep, bins, lo = 0, hi = 1) {
  const h = new Float64Array(bins);
  const k = bins / (hi - lo);
  for (let i = 0; i < vals.length; i++) {
    if (keep && !keep[i]) continue;
    const v = vals[i];
    if (!(v >= lo && v < hi)) continue;
    h[Math.min(bins - 1, ((v - lo) * k) | 0)]++;
  }
  return h;
}

export function smooth1d(h, sigma) {
  if (sigma <= 0) return Float64Array.from(h);
  const r = Math.ceil(sigma * 3);
  const w = [];
  let ws = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp((-i * i) / (2 * sigma * sigma));
    w.push(v);
    ws += v;
  }
  const out = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) {
      const k = Math.min(h.length - 1, Math.max(0, i + j));
      s += h[k] * w[j + r];
    }
    out[i] = s / ws;
  }
  return out;
}

function argmax(a, from = 0, to = a.length - 1) {
  let best = from;
  for (let i = from; i <= to; i++) if (a[i] > a[best]) best = i;
  return best;
}

function argmin(a, from = 0, to = a.length - 1) {
  let best = from;
  for (let i = from; i <= to; i++) if (a[i] < a[best]) best = i;
  return best;
}

function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const pos = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Drop the vertices that matter least (smallest triangle) until at most `max` remain. */
export function simplifyPolygon(poly, max) {
  const p = poly.slice();
  const area = (i) => {
    const a = p[(i - 1 + p.length) % p.length];
    const b = p[i];
    const c = p[(i + 1) % p.length];
    return Math.abs(cross(a, b, c)) / 2;
  };
  while (p.length > max) {
    let best = 0;
    let bestA = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = area(i);
      if (a < bestA) {
        bestA = a;
        best = i;
      }
    }
    p.splice(best, 1);
  }
  return p;
}

/** Grow a convex polygon outward from its centroid by a fraction and a fixed margin. */
function expand(poly, frac, margin) {
  const cx = poly.reduce((s, q) => s + q[0], 0) / poly.length;
  const cy = poly.reduce((s, q) => s + q[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return [x + dx * frac + (dx / d) * margin, y + dy * frac + (dy / d) * margin];
  });
}

/** Clip a polygon to the half-plane where `inside(point)` holds (Sutherland–Hodgman, one edge). */
function clip(poly, inside, cut) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ia = inside(a);
    const ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) out.push(cut(a, b));
  }
  return out;
}

const clipX = (poly, x, keepAbove) =>
  clip(
    poly,
    (q) => (keepAbove ? q[0] >= x : q[0] <= x),
    (a, b) => [x, a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0])],
  );
const clipY = (poly, y, keepAbove) =>
  clip(
    poly,
    (q) => (keepAbove ? q[1] >= y : q[1] <= y),
    (a, b) => [a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y],
  );

// ------------------------------------------------------------------ Cells

/**
 * Cells on FSC-A × SSC-A (scale values). The FSC-A threshold is the valley
 * between the debris pile at low FSC and the main cell peak; the polygon is
 * the convex outline of the densest region holding `coverage` of the events
 * to the right of it, a little enlarged, kept clear of the saturated edge.
 * Returns { threshold, polygon: [[sx, sy], ...] } in scale space.
 */
export function findCells(fa, sa, { keep = null, coverage = 0.985 } = {}) {
  const n = fa.length;
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) ok[i] = (!keep || keep[i]) && fa[i] < SAT && sa[i] < SAT && fa[i] > -0.05 ? 1 : 0;

  const B = 128;
  const hs = smooth1d(hist1d(fa, ok, B), 1.5);
  const peak = argmax(hs, Math.round(0.06 * B), B - 2);
  const valley = argmin(hs, Math.round(0.02 * B), peak);
  // a valley only counts if it's a real dip below the cells' peak
  const thrBin = hs[valley] < 0.6 * hs[peak] ? valley : Math.round(0.02 * B);
  const threshold = (thrBin + 0.5) / B;

  const G = 64;
  const h2 = new Float64Array(G * G);
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (!ok[i] || fa[i] < threshold) continue;
    const bx = Math.min(G - 1, Math.max(0, (fa[i] * G) | 0));
    const by = Math.min(G - 1, Math.max(0, (sa[i] * G) | 0));
    h2[by * G + bx]++;
    total++;
  }
  // light 2-D smoothing so isolated bins don't pull the outline around
  const sm = new Float64Array(G * G);
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      let s = 0;
      let w = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= G || yy >= G) continue;
          const k = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          s += h2[yy * G + xx] * k;
          w += k;
        }
      }
      sm[y * G + x] = s / w;
    }
  }
  // densest bins first, until they hold `coverage` of the (raw) events
  const order = Array.from(sm.keys()).filter((i) => h2[i] > 0).sort((a, b) => sm[b] - sm[a]);
  const pts = [];
  let acc = 0;
  for (const i of order) {
    if (acc >= coverage * total) break;
    acc += h2[i];
    const x = (i % G) / G;
    const y = Math.floor(i / G) / G;
    pts.push([x, y], [x + 1 / G, y], [x, y + 1 / G], [x + 1 / G, y + 1 / G]);
  }
  if (pts.length < 3) return { threshold, polygon: null };
  let poly = simplifyPolygon(convexHull(pts), 10);
  poly = expand(poly, 0.04, 0.01);
  poly = clipX(poly, threshold, true);
  poly = clipX(poly, SAT, false);
  poly = clipY(poly, SAT, false);
  return { threshold, polygon: poly.map(([x, y]) => [x, Math.max(y, EDGE_LO)]) };
}

// ------------------------------------------------------------------ Singlets

/**
 * Singlets on area × height (data values). Single cells sit on a ridge of
 * constant height/area; doublets have about the same height but more area,
 * so a lower ratio. The ridge is the mode of log(H/A); its width comes from
 * the side away from the doublets. Returns { lo, hi, mode } ratios.
 */
export function findSingletRatio(A, H, { keep = null } = {}) {
  const lr = [];
  for (let i = 0; i < A.length; i++) {
    if (keep && !keep[i]) continue;
    if (A[i] > 0 && H[i] > 0) lr.push(Math.log10(H[i] / A[i]));
  }
  if (lr.length < 50) return null;
  const LO = -1.5;
  const HI = 1;
  const B = 500;
  const hs = smooth1d(hist1d(lr, null, B, LO, HI), 2);
  const mode = LO + ((argmax(hs) + 0.5) * (HI - LO)) / B;
  const above = lr.filter((v) => v > mode).map((v) => v - mode).sort((a, b) => a - b);
  const sigma = Math.max(0.006, quantile(above, 0.5) / 0.6745);
  return { mode: 10 ** mode, lo: 10 ** (mode - 4 * sigma), hi: 10 ** (mode + 6 * sigma) };
}

// ------------------------------------------------------------------ Live

/**
 * Live cells on a viability dye (scale values). Live cells can make more than
 * one dim peak (cell types differ in autofluorescence); dead cells are a
 * separate peak well above them. The threshold is where the dim cells' tail
 * meets the floor of the gap before the dead peak — or, with no dead peak,
 * where the brightest dim peak has faded to almost nothing. Returns the
 * threshold in scale space.
 */
export function findLiveThreshold(v, { keep = null } = {}) {
  const B = 200;
  const GAP = 30; // a dead peak sits at least this many bins (0.15 of the axis) above the main one
  const hs = smooth1d(hist1d(v, keep, B, 0, 1), 2);
  const P = argmax(hs);
  const top = hs[P];
  if (!(top > 0)) return null;
  const peaks = [];
  for (let i = 1; i < B - 1; i++) if (hs[i] >= 0.015 * top && hs[i] >= hs[i - 1] && hs[i] > hs[i + 1]) peaks.push(i);
  let dead = -1;
  for (const j of peaks) {
    if (j - P < GAP) continue;
    const floor = hs[argmin(hs, P, j)];
    if (floor < 0.5 * hs[j]) dead = j; // keep the brightest one that qualifies
  }
  let thr;
  if (dead >= 0) {
    // the last dim peak before the gap, then the first bin down at the gap's floor
    const dim = peaks.filter((i) => i < dead && hs[argmin(hs, i, dead)] < 0.5 * hs[dead]);
    const lastDim = dim.length ? dim[dim.length - 1] : P;
    const floor = hs[argmin(hs, lastDim, dead)];
    thr = lastDim;
    while (thr < dead && hs[thr] > 2 * floor + 0.002 * top) thr++;
  } else {
    const lastDim = peaks.length ? peaks[peaks.length - 1] : P;
    thr = lastDim;
    while (thr < B - 1 && hs[thr] > 0.01 * top) thr++;
    thr = Math.min(B - 1, thr + 2);
  }
  return Math.min(0.98, (thr + 0.5) / B);
}

// ------------------------------------------------------------------ the whole front end

const VIABILITY = /viab|live|dead|zombie|7-?aad|dapi|\bpi\b|propidium|fvs|\bl\/?d\b|aqua|sytox|fixable|ghost|near[- ]?ir/i;

/** Guess the channels to use: FSC-A, SSC-A, FSC-H and a viability dye, by name and label. */
export function guessPregateChannels(channels) {
  const by = (re) => channels.find((c) => re.test(c.name));
  const fscA = by(/^fsc[-_ ]?a$/i) || channels.find((c) => /^fsc/i.test(c.name) && !/[-_ ][hw]$/i.test(c.name));
  const sscA = by(/^ssc[-_ ]?a$/i) || channels.find((c) => /^ssc/i.test(c.name) && !/[-_ ][hw]$/i.test(c.name));
  const fscH = by(/^fsc[-_ ]?h$/i);
  const viab = channels.find((c) => c.kind !== 'scatter' && c.kind !== 'time' && (VIABILITY.test(c.label || '') || VIABILITY.test(c.name)));
  return { fscA: fscA ? fscA.name : null, sscA: sscA ? sscA.name : null, fscH: fscH ? fscH.name : null, viab: viab ? viab.name : null };
}

/**
 * Build the front-end gates from a sample of events.
 * @param {{fscA:Float32Array, sscA:Float32Array, fscH?:Float32Array, viab?:Float32Array}} cols scale values
 * @param {{fscA, sscA, fscH?, viab?}} tx the channels' transforms (scale <-> data)
 * @param {{cells?:boolean, singlets?:boolean, live?:boolean}} steps
 * @returns {{cells?, singlets?, live?, n, notes: string[]}} geometry in data units, and
 *   the fraction of its parent each gate keeps in this sample of events
 */
export function autoPregate(cols, tx, steps = { cells: true, singlets: true, live: true }) {
  const n = cols.fscA.length;
  const notes = [];
  const out = { n, notes };
  let keep = new Uint8Array(n).fill(1);
  const count = (m) => m.reduce((s, v) => s + v, 0);

  if (steps.cells) {
    const c = findCells(cols.fscA, cols.sscA);
    if (!c.polygon) {
      notes.push('Too few events to find the cells.');
      return out;
    }
    const next = new Uint8Array(n);
    for (let i = 0; i < n; i++) next[i] = pointInPolygon([cols.fscA[i], cols.sscA[i]], c.polygon) ? 1 : 0;
    const polygon = c.polygon.map(([x, y]) => [tx.fscA.inverse(x), tx.sscA.inverse(y)]);
    out.cells = { polygon, kept: count(next) / Math.max(1, count(keep)) };
    keep = next;
  }

  if (steps.singlets && cols.fscH) {
    const A = new Float64Array(n);
    const H = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      A[i] = tx.fscA.inverse(cols.fscA[i]);
      H[i] = tx.fscH.inverse(cols.fscH[i]);
    }
    const r = findSingletRatio(A, H, { keep });
    if (!r) notes.push('Too few events to find singlets.');
    else {
      const inA = [];
      for (let i = 0; i < n; i++) if (keep[i] && A[i] > 0) inA.push(A[i]);
      inA.sort((a, b) => a - b);
      const aMin = Math.max(quantile(inA, 0.001) * 0.9, tx.fscA.inverse(0.001));
      const aMax = Math.max(tx.fscA.inverse(1.02), quantile(inA, 1) * 1.05);
      // follow the band's two edges with several vertices, so it stays a
      // ratio band on any display scale (polygons are drawn straight on screen)
      const K = 6;
      const along = Array.from({ length: K }, (_, k) => aMin * (aMax / aMin) ** (k / (K - 1)));
      const polygon = [...along.map((a) => [a, a * r.lo]), ...along.slice().reverse().map((a) => [a, a * r.hi])];
      const next = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!keep[i] || !(A[i] >= aMin)) continue;
        const q = H[i] / A[i];
        next[i] = q >= r.lo && q <= r.hi ? 1 : 0;
      }
      out.singlets = { polygon, ratio: r, kept: count(next) / Math.max(1, count(keep)) };
      keep = next;
    }
  } else if (steps.singlets) notes.push('No FSC-H parameter, so singlets were skipped.');

  if (steps.live && cols.viab) {
    const t = findLiveThreshold(cols.viab, { keep });
    if (t === null) notes.push('Too few events to find live cells.');
    else {
      const next = new Uint8Array(n);
      for (let i = 0; i < n; i++) next[i] = keep[i] && cols.viab[i] < t ? 1 : 0;
      out.live = { rect: { x0: null, x1: tx.viab.inverse(t), y0: null, y1: null }, threshold: t, kept: count(next) / Math.max(1, count(keep)) };
    }
  } else if (steps.live) notes.push('No viability dye chosen, so live cells were skipped.');

  return out;
}
