// Gate model and evaluation.
//
// Gate definitions are plain JSON objects. Geometry is stored in data units
// (compensated values when compensation is applied) so a gate stays attached
// to the data when display scales change. Shapes whose edges are straight on
// screen (polygons) and ellipses are evaluated in display-scale space, as in
// Gating-ML 2.0, so what you see is what is gated. Rectangles, ranges and
// quadrants are monotone and are evaluated directly on data values.
//
//   {
//     id, name, parent: 'root' | gateId, type, x, y, color,
//     rect:    { x0, x1, y0, y1 }        // null edge = unbounded
//     polygon: [[x, y], ...]
//     ellipse: { c: [x, y], a: [x, y], b: [x, y] }  // centre + conjugate axis ends
//     range:   { lo, hi }                 // 1-D, null = unbounded
//     boolean: { op: 'and' | 'or', refs: [{ id, not }] }
//     link:    { kind: 'quad' | 'split', group, role } | null
//   }

export const ROOT = 'root';
export const GATE_TYPES = ['rect', 'polygon', 'ellipse', 'range', 'boolean'];
/** Scale coordinates used for vertices snapped beyond the plotted range. */
export const EDGE_LO = -0.02;
export const EDGE_HI = 1.02;

export class GateError extends Error {}

export function gateDims(g) {
  if (!g) return [];
  if (g.type === 'boolean') return [];
  if (g.type === 'range') return [g.x];
  return [g.x, g.y];
}

export function isTwoD(g) {
  return g && (g.type === 'rect' || g.type === 'polygon' || g.type === 'ellipse');
}

/** True when evaluation needs display-scale values (shape is not axis-monotone). */
export function needsScale(g) {
  return g && (g.type === 'polygon' || g.type === 'ellipse');
}

/** Scale specs a shape gate is evaluated in: its own (Gating-ML) or the channel display scales. */
export function evalSpecs(g, transforms) {
  if (g.scale && g.scale.x && g.scale.y) return [g.scale.x, g.scale.y];
  return [transforms[g.x], transforms[g.y]];
}

const GEOMETRY_KEYS = ['rect', 'polygon', 'ellipse', 'range'];
// note: a gate's own evaluation scales (g.scale) are shared, not per sample

/** Apply a per-sample geometry override to a gate definition. */
export function applyOverride(g, ov) {
  if (!ov) return g;
  const out = { ...g };
  for (const k of GEOMETRY_KEYS) if (ov[k] !== undefined) out[k] = ov[k];
  return out;
}

export function geometryOf(g) {
  const out = {};
  for (const k of GEOMETRY_KEYS) if (g[k] !== undefined) out[k] = g[k];
  return out;
}

/** Dependencies of a gate: its parent and, for boolean gates, the operands. */
export function gateDeps(g) {
  const deps = [];
  if (g.parent && g.parent !== ROOT) deps.push(g.parent);
  if (g.type === 'boolean' && g.boolean && Array.isArray(g.boolean.refs)) {
    for (const r of g.boolean.refs) if (r && r.id && r.id !== ROOT) deps.push(r.id);
  }
  return deps;
}

/**
 * Topologically order gates so that parents and operands come first.
 * Gates with missing dependencies or cycles are returned in `invalid`.
 */
export function orderGates(gates) {
  const list = Array.isArray(gates) ? gates : Object.values(gates);
  const byId = new Map(list.map((g) => [g.id, g]));
  const state = new Map();
  const ordered = [];
  const invalid = new Set();
  const visit = (g, stack) => {
    const s = state.get(g.id);
    if (s === 2) return !invalid.has(g.id);
    if (s === 1) {
      for (const id of stack) invalid.add(id);
      return false;
    }
    state.set(g.id, 1);
    stack.push(g.id);
    let ok = true;
    for (const d of gateDeps(g)) {
      const dg = byId.get(d);
      if (!dg) {
        ok = false;
        continue;
      }
      if (!visit(dg, stack)) ok = false;
    }
    stack.pop();
    state.set(g.id, 2);
    if (!ok) invalid.add(g.id);
    else ordered.push(g);
    return ok;
  };
  for (const g of list) visit(g, []);
  return { ordered, invalid };
}

/** Children of each population, in definition order. */
export function childrenMap(gates) {
  const list = Array.isArray(gates) ? gates : Object.values(gates);
  const map = new Map();
  map.set(ROOT, []);
  for (const g of list) map.set(g.id, []);
  for (const g of list) {
    const p = g.parent || ROOT;
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(g);
  }
  return map;
}

/** Ancestors from root (exclusive) down to the gate (exclusive). */
export function ancestors(gatesById, id) {
  const out = [];
  let g = gatesById[id];
  const seen = new Set();
  while (g && g.parent && g.parent !== ROOT && !seen.has(g.parent)) {
    seen.add(g.parent);
    const p = gatesById[g.parent];
    if (!p) break;
    out.unshift(p);
    g = p;
  }
  return out;
}

export function descendants(gatesById, id) {
  const list = Object.values(gatesById);
  const out = [];
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const g of list) {
      if (g.parent === cur) {
        out.push(g.id);
        queue.push(g.id);
      }
    }
  }
  return out;
}

function lo(v) { return v === null || v === undefined ? -Infinity : v; }
function hi(v) { return v === null || v === undefined ? Infinity : v; }

/**
 * Evaluate one gate against its parent population.
 * @param {object} g gate definition (overrides applied)
 * @param {Uint32Array} parent event indices of the parent population
 * @param {{values:(ch:string)=>Float32Array|null, scaled:(ch:string)=>Float32Array|null,
 *   transform:(ch:string)=>{scale:(v:number)=>number}, pop:(id:string)=>Uint32Array, N:number}} ctx
 * @returns {Uint32Array}
 */
export function evaluateGate(g, parent, ctx) {
  switch (g.type) {
    case 'rect': return rectFilter(g, parent, ctx);
    case 'range': return rangeFilter(g, parent, ctx);
    case 'polygon': return polygonFilter(g, parent, ctx);
    case 'ellipse': return ellipseFilter(g, parent, ctx);
    case 'boolean': return booleanFilter(g, parent, ctx);
    default: throw new GateError(`Unknown gate type "${g.type}"`);
  }
}

function need(ctx, fn, ch) {
  const a = ctx[fn](ch);
  if (!a) throw new GateError(`Channel "${ch}" is not present in this sample.`);
  return a;
}

function rectFilter(g, parent, ctx) {
  const xv = need(ctx, 'values', g.x);
  const yv = need(ctx, 'values', g.y);
  const r = g.rect || {};
  const x0 = lo(r.x0), x1 = hi(r.x1), y0 = lo(r.y0), y1 = hi(r.y1);
  const out = new Uint32Array(parent.length);
  let m = 0;
  for (let k = 0, n = parent.length; k < n; k++) {
    const i = parent[k];
    const x = xv[i];
    if (x >= x0 && x < x1) {
      const y = yv[i];
      if (y >= y0 && y < y1) out[m++] = i;
    }
  }
  return out.slice(0, m);
}

function rangeFilter(g, parent, ctx) {
  const xv = need(ctx, 'values', g.x);
  const r = g.range || {};
  const x0 = lo(r.lo), x1 = hi(r.hi);
  const out = new Uint32Array(parent.length);
  let m = 0;
  for (let k = 0, n = parent.length; k < n; k++) {
    const i = parent[k];
    const x = xv[i];
    if (x >= x0 && x < x1) out[m++] = i;
  }
  return out.slice(0, m);
}

function clampScale(v) {
  if (v === Infinity) return 1e6;
  if (v === -Infinity) return -1e6;
  if (v !== v) return 0;
  return v;
}

/** Transform polygon vertices into scale space. */
export function polygonToScale(poly, tx, ty) {
  return poly.map(([x, y]) => [clampScale(tx.scale(x)), clampScale(ty.scale(y))]);
}

/**
 * Space in which a polygon or ellipse is evaluated: the gate's own scales when
 * it carries them (Gating-ML gates whose dimensions name a transformation),
 * otherwise the channel display scales. Display-scale gates clamp events to
 * the visible range so events piled on an axis are gated as drawn.
 */
function evalSpace(g, ctx) {
  const own = g.scale;
  if (own && own.x && own.y && ctx.scaledWith) {
    const sx = ctx.scaledWith(g.x, own.x);
    const sy = ctx.scaledWith(g.y, own.y);
    if (!sx) throw new GateError(`Channel "${g.x}" is not present in this sample.`);
    if (!sy) throw new GateError(`Channel "${g.y}" is not present in this sample.`);
    return { sx, sy, tx: ctx.transformFor(own.x), ty: ctx.transformFor(own.y), clamp: false };
  }
  return { sx: need(ctx, 'scaled', g.x), sy: need(ctx, 'scaled', g.y), tx: ctx.transform(g.x), ty: ctx.transform(g.y), clamp: true };
}

function polygonFilter(g, parent, ctx) {
  const poly = g.polygon || [];
  if (poly.length < 3) return new Uint32Array(0);
  const { sx, sy, tx, ty, clamp } = evalSpace(g, ctx);
  const verts = polygonToScale(poly, tx, ty);
  const n = verts.length;
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let a = 0; a < n; a++) {
    vx[a] = verts[a][0];
    vy[a] = verts[a][1];
    if (vx[a] < minX) minX = vx[a];
    if (vx[a] > maxX) maxX = vx[a];
    if (vy[a] < minY) minY = vy[a];
    if (vy[a] > maxY) maxY = vy[a];
  }
  const out = new Uint32Array(parent.length);
  let m = 0;
  for (let k = 0, len = parent.length; k < len; k++) {
    const i = parent[k];
    let x = sx[i];
    if (clamp) x = x > 0 ? (x < 1 ? x : 1) : 0;
    if (!(x >= minX && x <= maxX)) continue;
    let y = sy[i];
    if (clamp) y = y > 0 ? (y < 1 ? y : 1) : 0;
    if (!(y >= minY && y <= maxY)) continue;
    let inside = false;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const ya = vy[a];
      const yb = vy[b];
      if ((ya > y) !== (yb > y)) {
        const xi = vx[a] + ((y - ya) * (vx[b] - vx[a])) / (yb - ya);
        if (x < xi) inside = !inside;
      }
    }
    if (inside) out[m++] = i;
  }
  return out.slice(0, m);
}

/** Ellipse in scale space: centre c and conjugate semi-axis vectors u, v. */
export function ellipseToScale(e, tx, ty) {
  const c = [clampScale(tx.scale(e.c[0])), clampScale(ty.scale(e.c[1]))];
  const a = [clampScale(tx.scale(e.a[0])), clampScale(ty.scale(e.a[1]))];
  const b = [clampScale(tx.scale(e.b[0])), clampScale(ty.scale(e.b[1]))];
  return { c, u: [a[0] - c[0], a[1] - c[1]], v: [b[0] - c[0], b[1] - c[1]] };
}

function ellipseFilter(g, parent, ctx) {
  const { sx, sy, tx, ty, clamp } = evalSpace(g, ctx);
  const { c, u, v } = ellipseToScale(g.ellipse, tx, ty);
  const det = u[0] * v[1] - v[0] * u[1];
  if (Math.abs(det) < 1e-14) return new Uint32Array(0);
  const i00 = v[1] / det, i01 = -v[0] / det, i10 = -u[1] / det, i11 = u[0] / det;
  const rx = Math.abs(u[0]) + Math.abs(v[0]);
  const ry = Math.abs(u[1]) + Math.abs(v[1]);
  const out = new Uint32Array(parent.length);
  let m = 0;
  for (let k = 0, n = parent.length; k < n; k++) {
    const i = parent[k];
    let x = sx[i];
    if (clamp) x = x > 0 ? (x < 1 ? x : 1) : 0;
    const dx = x - c[0];
    if (!(dx <= rx && dx >= -rx)) continue;
    let y = sy[i];
    if (clamp) y = y > 0 ? (y < 1 ? y : 1) : 0;
    const dy = y - c[1];
    if (!(dy <= ry && dy >= -ry)) continue;
    const s = i00 * dx + i01 * dy;
    const t = i10 * dx + i11 * dy;
    if (s * s + t * t <= 1) out[m++] = i;
  }
  return out.slice(0, m);
}

function booleanFilter(g, parent, ctx) {
  const spec = g.boolean || { op: 'and', refs: [] };
  const refs = (spec.refs || []).filter((r) => r && r.id);
  if (refs.length === 0) return new Uint32Array(0);
  const N = ctx.N;
  const masks = refs.map((r) => {
    const mask = new Uint8Array(N);
    const idx = ctx.pop(r.id);
    if (!idx) throw new GateError(`Boolean gate "${g.name}" refers to a missing population.`);
    for (let k = 0; k < idx.length; k++) mask[idx[k]] = 1;
    return mask;
  });
  const nots = refs.map((r) => (r.not ? 1 : 0));
  const out = new Uint32Array(parent.length);
  let m = 0;
  const R = refs.length;
  if (spec.op === 'or') {
    for (let k = 0; k < parent.length; k++) {
      const i = parent[k];
      for (let r = 0; r < R; r++) {
        if ((masks[r][i] ^ nots[r]) === 1) {
          out[m++] = i;
          break;
        }
      }
    }
  } else {
    for (let k = 0; k < parent.length; k++) {
      const i = parent[k];
      let ok = true;
      for (let r = 0; r < R; r++) {
        if ((masks[r][i] ^ nots[r]) !== 1) {
          ok = false;
          break;
        }
      }
      if (ok) out[m++] = i;
    }
  }
  return out.slice(0, m);
}

/** Short, stable hash for cache signatures. */
export function hashString(s) {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/** Describe a boolean gate as text, e.g. "CD4 and not CD8". */
export function booleanLabel(g, gatesById) {
  const spec = g.boolean || { op: 'and', refs: [] };
  const parts = (spec.refs || []).map((r) => `${r.not ? 'not ' : ''}${gatesById[r.id] ? gatesById[r.id].name : '?'}`);
  return parts.join(spec.op === 'or' ? ' or ' : ' and ');
}
