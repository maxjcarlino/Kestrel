// Pure helpers for creating and editing gate geometry. All interactive
// operations happen in display-scale space (0..1 per axis) and are converted
// back to data units through the axis transforms.

import { EDGE_LO, EDGE_HI } from './gates.js';

export const ELLIPSE_POLY_POINTS = 36;

let counter = 0;
export function newId(prefix = 'g') {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}${counter.toString(36)}`;
}

/** Palette for gates: distinct, readable on light and dark plots. */
export const GATE_COLORS = ['#1f77d0', '#d6336c', '#2b9a66', '#e8590c', '#7048e8', '#0c8599', '#c2255c', '#5c940d', '#ae3ec9', '#f08c00', '#364fc7', '#087f5b'];

export function nextColor(gates) {
  const used = new Map();
  for (const g of Object.values(gates || {})) used.set(g.color, (used.get(g.color) || 0) + 1);
  let best = GATE_COLORS[0];
  let bestN = Infinity;
  for (const c of GATE_COLORS) {
    const n = used.get(c) || 0;
    if (n < bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

function inv(t, s) {
  return t.inverse(s);
}

/** Map a scale coordinate to a data value, snapping beyond-edge values. */
export function snapToData(t, s, { allowNull = false } = {}) {
  if (s <= 0) return allowNull ? null : inv(t, Math.min(s, EDGE_LO));
  if (s >= 1) return allowNull ? null : inv(t, Math.max(s, EDGE_HI));
  return inv(t, s);
}

/** Rectangle from two scale-space corners. Edges at/beyond the axis become unbounded. */
export function rectFromScale(a, b, tx, ty) {
  const sx0 = Math.min(a[0], b[0]);
  const sx1 = Math.max(a[0], b[0]);
  const sy0 = Math.min(a[1], b[1]);
  const sy1 = Math.max(a[1], b[1]);
  return {
    x0: sx0 <= 0 ? null : inv(tx, sx0),
    x1: sx1 >= 1 ? null : inv(tx, sx1),
    y0: sy0 <= 0 ? null : inv(ty, sy0),
    y1: sy1 >= 1 ? null : inv(ty, sy1),
  };
}

export function rangeFromScale(a, b, tx) {
  const s0 = Math.min(a, b);
  const s1 = Math.max(a, b);
  return { lo: s0 <= 0 ? null : inv(tx, s0), hi: s1 >= 1 ? null : inv(tx, s1) };
}

/** Polygon vertex from a scale point, snapping near/beyond edges outside the axis. */
export function vertexFromScale(p, tx, ty) {
  const sx = p[0] <= 0 ? EDGE_LO : p[0] >= 1 ? EDGE_HI : p[0];
  const sy = p[1] <= 0 ? EDGE_LO : p[1] >= 1 ? EDGE_HI : p[1];
  return [inv(tx, sx), inv(ty, sy)];
}

/** Rectangle bounds in scale space (unbounded edges map just beyond the axis). */
export function rectScale(rect, tx, ty) {
  const f = (t, v, d) => (v === null || v === undefined ? d : t.scale(v));
  return {
    x0: f(tx, rect.x0, EDGE_LO),
    x1: f(tx, rect.x1, EDGE_HI),
    y0: f(ty, rect.y0, EDGE_LO),
    y1: f(ty, rect.y1, EDGE_HI),
  };
}

/** Convert a rectangle or ellipse gate to an equivalent polygon gate. */
export function toPolygon(g, tx, ty) {
  if (g.type === 'polygon') return g;
  if (g.type === 'rect') {
    const r = rectScale(g.rect || {}, tx, ty);
    const pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    const polygon = pts.map(([sx, sy]) => [inv(tx, sx), inv(ty, sy)]);
    const out = { ...g, type: 'polygon', polygon };
    delete out.rect;
    delete out.link;
    return out;
  }
  if (g.type === 'ellipse') {
    const e = g.ellipse;
    const c = [tx.scale(e.c[0]), ty.scale(e.c[1])];
    const u = [tx.scale(e.a[0]) - c[0], ty.scale(e.a[1]) - c[1]];
    const v = [tx.scale(e.b[0]) - c[0], ty.scale(e.b[1]) - c[1]];
    const polygon = [];
    for (let k = 0; k < ELLIPSE_POLY_POINTS; k++) {
      const th = (2 * Math.PI * k) / ELLIPSE_POLY_POINTS;
      const sx = c[0] + Math.cos(th) * u[0] + Math.sin(th) * v[0];
      const sy = c[1] + Math.cos(th) * u[1] + Math.sin(th) * v[1];
      polygon.push([inv(tx, sx), inv(ty, sy)]);
    }
    const out = { ...g, type: 'polygon', polygon };
    delete out.ellipse;
    delete out.link;
    return out;
  }
  return null;
}

export function canConvertToPolygon(g) {
  return !!g && (g.type === 'rect' || g.type === 'ellipse');
}

function shift(t, v, d) {
  if (v === null || v === undefined) return v;
  return inv(t, t.scale(v) + d);
}

/** Translate gate geometry by a scale-space offset. */
export function translateGeometry(g, dx, dy, tx, ty) {
  switch (g.type) {
    case 'rect': {
      const r = g.rect || {};
      return { rect: { x0: shift(tx, r.x0, dx), x1: shift(tx, r.x1, dx), y0: shift(ty, r.y0, dy), y1: shift(ty, r.y1, dy) } };
    }
    case 'range': {
      const r = g.range || {};
      return { range: { lo: shift(tx, r.lo, dx), hi: shift(tx, r.hi, dx) } };
    }
    case 'polygon':
      return { polygon: g.polygon.map(([x, y]) => [shift(tx, x, dx), shift(ty, y, dy)]) };
    case 'ellipse': {
      const e = g.ellipse;
      const m = (p) => [shift(tx, p[0], dx), shift(ty, p[1], dy)];
      return { ellipse: { c: m(e.c), a: m(e.a), b: m(e.b) } };
    }
    default:
      return {};
  }
}

/** Ellipse from a scale-space drag box (axes aligned with the screen). */
export function ellipseFromBox(p0, p1, tx, ty) {
  const cx = (p0[0] + p1[0]) / 2;
  const cy = (p0[1] + p1[1]) / 2;
  const rx = Math.max(Math.abs(p1[0] - p0[0]) / 2, 0.004);
  const ry = Math.max(Math.abs(p1[1] - p0[1]) / 2, 0.004);
  return {
    c: [inv(tx, cx), inv(ty, cy)],
    a: [inv(tx, cx + rx), inv(ty, cy)],
    b: [inv(tx, cx), inv(ty, cy + ry)],
  };
}

/** Build the four linked rectangle gates of a quadrant. */
export function makeQuadrant({ parent, x, y, center, names, colors, group = newId('q') }) {
  const [cx, cy] = center;
  const roles = ['UL', 'UR', 'LL', 'LR'];
  return roles.map((role, i) => ({
    id: newId('g'),
    name: names[i],
    parent,
    type: 'rect',
    x,
    y,
    color: colors[i],
    rect: quadRect(role, cx, cy),
    link: { kind: 'quad', group, role },
  }));
}

export function quadRect(role, cx, cy) {
  switch (role) {
    case 'UL': return { x0: null, x1: cx, y0: cy, y1: null };
    case 'UR': return { x0: cx, x1: null, y0: cy, y1: null };
    case 'LL': return { x0: null, x1: cx, y0: null, y1: cy };
    default: return { x0: cx, x1: null, y0: null, y1: cy };
  }
}

/** Center of a quadrant group from any member gate. */
export function quadCenter(g) {
  const r = g.rect || {};
  const role = g.link && g.link.role;
  const cx = role === 'UL' || role === 'LL' ? r.x1 : r.x0;
  const cy = role === 'UL' || role === 'UR' ? r.y0 : r.y1;
  return [cx, cy];
}

export function makeSplit({ parent, x, threshold, names, colors, group = newId('s') }) {
  return [
    { id: newId('g'), name: names[0], parent, type: 'range', x, y: null, color: colors[0], range: { lo: null, hi: threshold }, link: { kind: 'split', group, role: 'L' } },
    { id: newId('g'), name: names[1], parent, type: 'range', x, y: null, color: colors[1], range: { lo: threshold, hi: null }, link: { kind: 'split', group, role: 'R' } },
  ];
}

export function splitThreshold(g) {
  const r = g.range || {};
  return g.link && g.link.role === 'L' ? r.hi : r.lo;
}

export function splitRange(role, t) {
  return role === 'L' ? { lo: null, hi: t } : { lo: t, hi: null };
}

/** Marker-style names such as "CD3+ CD4−" for quadrants. */
export function quadrantNames(xName, yName) {
  const m = (s) => String(s || '').trim();
  const X = m(xName);
  const Y = m(yName);
  return [`${X}− ${Y}+`, `${X}+ ${Y}+`, `${X}− ${Y}−`, `${X}+ ${Y}−`];
}

/** Point-in-polygon in pixel/scale space (used for hit testing). */
export function pointInPolygon(pt, poly) {
  let inside = false;
  const [x, y] = pt;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a];
    const [xb, yb] = poly[b];
    if ((ya > y) !== (yb > y)) {
      const xi = xa + ((y - ya) * (xb - xa)) / (yb - ya);
      if (x < xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance from point p to segment ab. */
export function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}
