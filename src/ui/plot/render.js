// Canvas rendering for plots: density images, contours, histograms, axes and gates.

import { rectScale, quadCenter, splitThreshold } from '../../core/gate-geometry.js';
import { EDGE_LO, EDGE_HI, ellipseToScale } from '../../core/gates.js';
import { formatValue, makeTransform } from '../../core/transforms.js';

export const MARGIN = { l: 44, r: 10, t: 8, b: 24 };

export function plotArea(W, H, m = MARGIN) {
  return { x: m.l, y: m.t, w: Math.max(20, W - m.l - m.r), h: Math.max(20, H - m.t - m.b) };
}

export const toPx = (area, sx, sy) => [area.x + sx * area.w, area.y + (1 - sy) * area.h];
export const toScale = (area, px, py) => [(px - area.x) / area.w, 1 - (py - area.y) / area.h];

// ------------------------------------------------------------------ colour maps

export const COLORMAPS = {
  classic: { label: 'Classic', stops: [[0, '#1530c9'], [0.16, '#0d7cf2'], [0.34, '#00bfd8'], [0.5, '#2dd36f'], [0.66, '#c7df1f'], [0.8, '#ffb000'], [0.92, '#ff5a1f'], [1, '#e8141c']] },
  viridis: { label: 'Viridis', stops: [[0, '#440154'], [0.25, '#3b528b'], [0.5, '#21918c'], [0.75, '#5ec962'], [1, '#fde725']] },
  turbo: { label: 'Turbo', stops: [[0, '#30123b'], [0.13, '#4662d7'], [0.27, '#36aaf9'], [0.4, '#1ae4b6'], [0.53, '#72fe5e'], [0.66, '#c8ef34'], [0.79, '#faba39'], [0.9, '#f66b19'], [1, '#ca2a04']] },
  magma: { label: 'Magma', stops: [[0, '#2c115f'], [0.25, '#721f81'], [0.5, '#b73779'], [0.75, '#f1605d'], [1, '#feca8d']] },
  gray: { label: 'Greyscale', stops: [[0, '#a3a9b4'], [1, '#101318']] },
};

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lutCache = new Map();
export function lut(name, dark) {
  const key = name + (dark ? ':d' : ':l');
  if (lutCache.has(key)) return lutCache.get(key);
  let stops = (COLORMAPS[name] || COLORMAPS.classic).stops;
  if (name === 'gray' && dark) stops = [[0, '#5d6573'], [1, '#f2f4f8']];
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const a = hex(c0);
    const b = hex(c1);
    for (let j = 0; j < 3; j++) out[i * 3 + j] = Math.round(a[j] + (b[j] - a[j]) * f);
  }
  lutCache.set(key, out);
  return out;
}

export function cssGradient(name) {
  const stops = (COLORMAPS[name] || COLORMAPS.classic).stops;
  return `linear-gradient(90deg, ${stops.map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(', ')})`;
}

// ------------------------------------------------------------------ smoothing

export function blur(src, w, h, sigma) {
  const n = w * h;
  const out = new Float32Array(n);
  if (!(sigma > 0.05)) {
    for (let i = 0; i < n; i++) out[i] = src[i];
    return out;
  }
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let j = -r; j <= r; j++) {
    k[j + r] = Math.exp((-j * j) / (2 * sigma * sigma));
    ks += k[j + r];
  }
  for (let j = 0; j < k.length; j++) k[j] /= ks;
  const tmp = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = src[row + x];
      if (v === 0) continue;
      const a = Math.max(0, x - r);
      const b = Math.min(w - 1, x + r);
      for (let xx = a; xx <= b; xx++) tmp[row + xx] += v * k[xx - x + r];
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = tmp[row + x];
      if (v === 0) continue;
      const a = Math.max(0, y - r);
      const b = Math.min(h - 1, y + r);
      for (let yy = a; yy <= b; yy++) out[yy * w + x] += v * k[yy - y + r];
    }
  }
  return out;
}

// ------------------------------------------------------------------ images

/** Pseudocolour: each occupied pixel is coloured by smoothed local density. */
export function densityImage(counts, w, h, { cmap = 'classic', dark = false, sigma = 1.6, dot = 1 } = {}) {
  const dens = blur(counts, w, h, sigma);
  let hi = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] > 0 && dens[i] > hi) hi = dens[i];
  const img = new ImageData(w, h);
  const data = img.data;
  const L = lut(cmap, dark);
  const inv = hi > 0 ? 1 / hi : 1;
  for (let y = 0; y < h; y++) {
    const oy = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (counts[i] === 0) continue;
      let t = Math.sqrt(dens[i] * inv);
      if (t > 1) t = 1;
      const ci = ((t * 255) | 0) * 3;
      const o = (oy + x) * 4;
      data[o] = L[ci];
      data[o + 1] = L[ci + 1];
      data[o + 2] = L[ci + 2];
      data[o + 3] = 255;
    }
  }
  return dot > 1 ? dilate(img, w, h) : img;
}

/** Solid dots. `layers` = [{counts, rgb}] drawn in order over the base. */
export function dotImage(base, w, h, baseRGB, layers = [], dot = 1) {
  const img = new ImageData(w, h);
  const data = img.data;
  const paint = (counts, rgb) => {
    for (let y = 0; y < h; y++) {
      const oy = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) {
        if (counts[y * w + x] === 0) continue;
        const o = (oy + x) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
  };
  if (base) paint(base, baseRGB);
  for (const l of layers) paint(l.counts, l.rgb);
  return dot > 1 ? dilate(img, w, h) : img;
}

function dilate(img, w, h) {
  const src = img.data;
  const out = new ImageData(w, h);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (src[o + 3] === 0) continue;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= w || yy >= h) continue;
        const p = (yy * w + xx) * 4;
        if (d[p + 3] && !(dx === 0 && dy === 0)) continue;
        d[p] = src[o];
        d[p + 1] = src[o + 1];
        d[p + 2] = src[o + 2];
        d[p + 3] = 255;
      }
    }
  }
  return out;
}

export function parseColor(c) {
  if (!c) return [80, 80, 80];
  if (c[0] === '#') {
    const h = c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c;
    return hex(h.slice(0, 7));
  }
  const m = c.match(/\d+(\.\d+)?/g);
  return m ? m.slice(0, 3).map(Number) : [80, 80, 80];
}

// ------------------------------------------------------------------ contours

/**
 * Equal-probability contours. Returns { levels: [{p, segs:Float32Array}], outlier: Uint8Array(w*h) }
 * Segment coordinates are in bin units with y pointing up.
 */
export function contours(counts, w, h, { cell = 3, sigma = 1.4, probs = [0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] } = {}) {
  const gw = Math.max(2, Math.ceil(w / cell));
  const gh = Math.max(2, Math.ceil(h / cell));
  const g = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, (y / cell) | 0);
    for (let x = 0; x < w; x++) {
      const c = counts[y * w + x];
      if (c) g[gy * gw + Math.min(gw - 1, (x / cell) | 0)] += c;
    }
  }
  const d = blur(g, gw, gh, sigma);
  let total = 0;
  for (let i = 0; i < d.length; i++) total += d[i];
  const order = Array.from(d.keys()).filter((i) => d[i] > 0).sort((a, b) => d[b] - d[a]);
  const levels = [];
  if (total > 0 && order.length > 3) {
    let acc = 0;
    const want = probs.map((p) => (1 - p) * total);
    const sorted = probs.map((p, i) => ({ p, target: want[i] })).sort((a, b) => a.target - b.target);
    let si = 0;
    for (const i of order) {
      acc += d[i];
      while (si < sorted.length && acc >= sorted[si].target) {
        levels.push({ p: sorted[si].p, level: d[i] });
        si++;
      }
      if (si >= sorted.length) break;
    }
  }
  const out = [];
  const seen = new Set();
  for (const L of levels) {
    if (seen.has(L.level)) continue;
    seen.add(L.level);
    out.push({ p: L.p, segs: march(d, gw, gh, L.level, cell) });
  }
  // outliers: occupied pixels in coarse cells below the lowest level
  const lowest = levels.length ? Math.min(...levels.map((l) => l.level)) : Infinity;
  const outlier = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, (y / cell) | 0);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (counts[i] && d[gy * gw + Math.min(gw - 1, (x / cell) | 0)] < lowest) outlier[i] = 1;
    }
  }
  return { levels: out, outlier };
}

function march(d, gw, gh, level, cell) {
  const segs = [];
  const v = (x, y) => d[y * gw + x];
  const cx = (x) => (x + 0.5) * cell;
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const a = v(x, y);
      const b = v(x + 1, y);
      const c = v(x + 1, y + 1);
      const e = v(x, y + 1);
      let idx = 0;
      if (a >= level) idx |= 1;
      if (b >= level) idx |= 2;
      if (c >= level) idx |= 4;
      if (e >= level) idx |= 8;
      if (idx === 0 || idx === 15) continue;
      const lerp = (p, q) => (Math.abs(q - p) < 1e-12 ? 0.5 : (level - p) / (q - p));
      const bottom = () => [cx(x + lerp(a, b)), cx(y)];
      const right = () => [cx(x + 1), cx(y + lerp(b, c))];
      const top = () => [cx(x + lerp(e, c)), cx(y + 1)];
      const left = () => [cx(x), cx(y + lerp(a, e))];
      const push = (p, q) => segs.push(p[0], p[1], q[0], q[1]);
      switch (idx) {
        case 1: case 14: push(left(), bottom()); break;
        case 2: case 13: push(bottom(), right()); break;
        case 3: case 12: push(left(), right()); break;
        case 4: case 11: push(right(), top()); break;
        case 5: push(left(), top()); push(bottom(), right()); break;
        case 6: case 9: push(bottom(), top()); break;
        case 7: case 8: push(left(), top()); break;
        case 10: push(left(), bottom()); push(right(), top()); break;
        default: break;
      }
    }
  }
  return new Float32Array(segs);
}

// ------------------------------------------------------------------ histograms

export function smoothHist(counts, sigma = 1.2) {
  const n = counts.length;
  if (!(sigma > 0)) return Float64Array.from(counts);
  const r = Math.ceil(sigma * 3);
  const k = [];
  let ks = 0;
  for (let j = -r; j <= r; j++) {
    const v = Math.exp((-j * j) / (2 * sigma * sigma));
    k.push(v);
    ks += v;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    for (let j = -r; j <= r; j++) {
      const ii = i + j;
      if (ii < 0 || ii >= n) continue;
      s += counts[ii] * k[j + r];
      w += k[j + r];
    }
    out[i] = w > 0 ? (s * ks) / w / ks : 0;
  }
  return out;
}

export function niceStep(max, target = 4) {
  const raw = max / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

// ------------------------------------------------------------------ axes

export function drawFrame(ctx, area, theme) {
  ctx.save();
  ctx.fillStyle = theme.plotBg;
  ctx.fillRect(area.x, area.y, area.w, area.h);
  ctx.restore();
}

function placeLabels(ctx, items, horizontal) {
  // items: {pos, text, priority}; returns accepted
  const sorted = items.slice().sort((a, b) => b.priority - a.priority);
  const placed = [];
  for (const it of sorted) {
    const wdt = ctx.measureText(it.text).width;
    const size = horizontal ? wdt : 11;
    const a = it.pos - size / 2 - 3;
    const b = it.pos + size / 2 + 3;
    if (placed.some((p) => !(b <= p.a || a >= p.b))) continue;
    placed.push({ ...it, a, b });
  }
  return placed;
}

/**
 * Draw ticks and tick labels.
 * @param {object} o {tx, ty, yMax (histogram counts), theme, font, yLabelMode}
 */
export function drawAxes(ctx, area, o) {
  const { tx, ty, theme } = o;
  ctx.save();
  ctx.strokeStyle = theme.axis;
  ctx.fillStyle = theme.tick;
  ctx.lineWidth = 1;
  ctx.font = o.font || '10px sans-serif';
  // frame
  ctx.strokeRect(Math.round(area.x) + 0.5, Math.round(area.y) + 0.5, Math.round(area.w) - 1, Math.round(area.h) - 1);
  // x axis
  if (tx) {
    const ticks = tx.ticks();
    const items = [];
    let lastPx = -Infinity;
    const sortedTicks = ticks.slice().sort((a, b) => a.s - b.s);
    for (const t of sortedTicks) {
      const px = area.x + t.s * area.w;
      if (px < area.x - 0.5 || px > area.x + area.w + 0.5) continue;
      if (!t.major && px - lastPx < 3) continue;
      lastPx = px;
      const len = t.major ? 5 : 3;
      const x = Math.round(px) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, area.y + area.h);
      ctx.lineTo(x, area.y + area.h + len);
      ctx.stroke();
      if (t.label) items.push({ pos: px, text: t.label, priority: t.priority });
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const it of placeLabels(ctx, items, true)) {
      const half = ctx.measureText(it.text).width / 2;
      const px = Math.min(Math.max(it.pos, area.x + half - 4), area.x + area.w + (o.marginRight ?? 8) - half);
      ctx.fillText(it.text, px, area.y + area.h + 7);
    }
  }
  // y axis
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  if (ty) {
    const ticks = ty.ticks();
    const items = [];
    let lastPx = Infinity;
    const sortedTicks = ticks.slice().sort((a, b) => a.s - b.s);
    for (const t of sortedTicks) {
      const py = area.y + (1 - t.s) * area.h;
      if (py < area.y - 0.5 || py > area.y + area.h + 0.5) continue;
      if (!t.major && lastPx - py < 3) continue;
      lastPx = py;
      const len = t.major ? 5 : 3;
      const y = Math.round(py) + 0.5;
      ctx.beginPath();
      ctx.moveTo(area.x - len, y);
      ctx.lineTo(area.x, y);
      ctx.stroke();
      if (t.label) items.push({ pos: py, text: t.label, priority: t.priority });
    }
    for (const it of placeLabels(ctx, items, false)) {
      const py = Math.min(Math.max(it.pos, area.y + 5), area.y + area.h + 4);
      ctx.fillText(it.text, area.x - 7, py);
    }
  } else if (o.yMax > 0) {
    const step = niceStep(o.yMax, 3);
    for (let v = 0; v <= o.yMax * 1.0001; v += step) {
      const py = area.y + (1 - v / o.yMax) * area.h;
      const y = Math.round(py) + 0.5;
      ctx.beginPath();
      ctx.moveTo(area.x - 5, y);
      ctx.lineTo(area.x, y);
      ctx.stroke();
      const label = o.yLabelMode === 'percent' ? `${Math.round(v)}` : formatValue(v, step);
      ctx.fillText(label, area.x - 7, Math.min(Math.max(py, area.y + 5), area.y + area.h));
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------ gates

export const HANDLE = 4;

/**
 * Pixel geometry for a gate (or a linked group drawn once).
 * Returns { gate, kind, path?, closed?, handles:[{x,y,part,index}], bbox, label:{x,y,align} }
 */
export function gateShape(g, area, tx, ty) {
  const P = (sx, sy) => toPx(area, sx, sy);
  if (g.type === 'rect' && g.link && g.link.kind === 'quad') {
    const [cx, cy] = quadCenter(g);
    const sx = cx === null || cx === undefined ? 0.5 : tx.scale(cx);
    const sy = cy === null || cy === undefined ? 0.5 : ty.scale(cy);
    const [px, py] = P(sx, sy);
    const role = g.link.role;
    const lx = role === 'UL' || role === 'LL' ? area.x + 6 : area.x + area.w - 6;
    const ly = role === 'UL' || role === 'UR' ? area.y + 6 : area.y + area.h - 6;
    const rs = rectScale(g.rect, tx, ty);
    const [x0, y1] = P(rs.x0, rs.y0);
    const [x1, y0] = P(rs.x1, rs.y1);
    return {
      gate: g,
      kind: 'quad',
      center: [px, py],
      path: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
      closed: true,
      bbox: { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) },
      handles: [{ x: px, y: py, part: 'center', index: 0 }],
      label: { x: lx, y: ly, align: role === 'UL' || role === 'LL' ? 'left' : 'right', valign: role === 'UL' || role === 'UR' ? 'top' : 'bottom' },
    };
  }
  if (g.type === 'rect') {
    const rs = rectScale(g.rect || {}, tx, ty);
    const [x0, y1] = P(rs.x0, rs.y0);
    const [x1, y0] = P(rs.x1, rs.y1);
    const r = g.rect || {};
    const handles = [];
    const bounded = (v) => v !== null && v !== undefined;
    const cxm = (x0 + x1) / 2;
    const cym = (y0 + y1) / 2;
    const clampX = (x) => Math.min(Math.max(x, area.x), area.x + area.w);
    const clampY = (y) => Math.min(Math.max(y, area.y), area.y + area.h);
    handles.push({ x: clampX(x0), y: clampY(y1), part: 'corner', index: 0 });
    handles.push({ x: clampX(x1), y: clampY(y1), part: 'corner', index: 1 });
    handles.push({ x: clampX(x1), y: clampY(y0), part: 'corner', index: 2 });
    handles.push({ x: clampX(x0), y: clampY(y0), part: 'corner', index: 3 });
    if (bounded(r.x0)) handles.push({ x: x0, y: clampY(cym), part: 'edge', index: 0 });
    if (bounded(r.x1)) handles.push({ x: x1, y: clampY(cym), part: 'edge', index: 1 });
    if (bounded(r.y0)) handles.push({ x: clampX(cxm), y: y1, part: 'edge', index: 2 });
    if (bounded(r.y1)) handles.push({ x: clampX(cxm), y: y0, part: 'edge', index: 3 });
    const bx0 = Math.max(Math.min(x0, x1), area.x);
    const by0 = Math.max(Math.min(y0, y1), area.y);
    return {
      gate: g,
      kind: 'rect',
      path: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
      closed: true,
      bbox: { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) },
      handles,
      label: { x: bx0 + 4, y: by0 + 4, align: 'left', valign: 'top' },
    };
  }
  // A gate with its own evaluation scales (imported Gating-ML) is drawn by
  // sampling its edges in that space, so the outline is exactly what is gated.
  const own = (g.type === 'polygon' || g.type === 'ellipse') && g.scale && g.scale.x && g.scale.y ? [makeTransform(g.scale.x), makeTransform(g.scale.y)] : null;
  const curved = own && !(own[0].key === tx.key && own[1].key === ty.key);
  const mapEval = (ex, ey) => P(clampS(tx.scale(own[0].inverse(ex))), clampS(ty.scale(own[1].inverse(ey))));
  if (g.type === 'polygon') {
    const verts = g.polygon || [];
    const handlesPx = verts.map(([x, y]) => P(clampS(tx.scale(x)), clampS(ty.scale(y))));
    let pts = handlesPx;
    if (curved) {
      const ev = verts.map(([x, y]) => [own[0].scale(x), own[1].scale(y)]);
      pts = [];
      for (let i = 0; i < ev.length; i++) {
        const a = ev[i];
        const b = ev[(i + 1) % ev.length];
        for (let k = 0; k < 24; k++) {
          const t = k / 24;
          pts.push(mapEval(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
        }
      }
    }
    const bbox = bboxOf(pts);
    return {
      gate: g,
      kind: 'polygon',
      path: pts,
      closed: true,
      bbox,
      handles: handlesPx.map((p, i) => ({ x: p[0], y: p[1], part: 'vertex', index: i })),
      label: labelForBox(bbox, area),
    };
  }
  if (g.type === 'ellipse') {
    const space = curved ? own : [tx, ty];
    const { c, u, v } = ellipseToScale(g.ellipse, space[0], space[1]);
    const pts = [];
    for (let k = 0; k < 96; k++) {
      const th = (2 * Math.PI * k) / 96;
      const ex = c[0] + Math.cos(th) * u[0] + Math.sin(th) * v[0];
      const ey = c[1] + Math.cos(th) * u[1] + Math.sin(th) * v[1];
      pts.push(curved ? mapEval(ex, ey) : P(ex, ey));
    }
    if (curved) {
      const C = P(clampS(tx.scale(g.ellipse.c[0])), clampS(ty.scale(g.ellipse.c[1])));
      const H = (p) => ({ ...pt(P(clampS(tx.scale(p[0])), clampS(ty.scale(p[1])))) });
      const bbox = bboxOf(pts);
      return {
        gate: g,
        kind: 'ellipse',
        path: pts,
        closed: true,
        bbox,
        center: C,
        handles: [{ x: C[0], y: C[1], part: 'center', index: 0 }, { ...H(g.ellipse.a), part: 'axisA', index: 1 }, { ...H(g.ellipse.b), part: 'axisB', index: 1 }],
        label: labelForBox(bbox, area),
      };
    }
    const bbox = bboxOf(pts);
    const C = P(c[0], c[1]);
    return {
      gate: g,
      kind: 'ellipse',
      path: pts,
      closed: true,
      bbox,
      center: C,
      handles: [
        { x: C[0], y: C[1], part: 'center', index: 0 },
        { ...pt(P(c[0] + u[0], c[1] + u[1])), part: 'axisA', index: 1 },
        { ...pt(P(c[0] - u[0], c[1] - u[1])), part: 'axisA', index: -1 },
        { ...pt(P(c[0] + v[0], c[1] + v[1])), part: 'axisB', index: 1 },
        { ...pt(P(c[0] - v[0], c[1] - v[1])), part: 'axisB', index: -1 },
      ],
      label: labelForBox(bbox, area),
    };
  }
  if (g.type === 'range') {
    const r = g.range || {};
    const s0 = r.lo === null || r.lo === undefined ? EDGE_LO : tx.scale(r.lo);
    const s1 = r.hi === null || r.hi === undefined ? EDGE_HI : tx.scale(r.hi);
    const x0 = area.x + s0 * area.w;
    const x1 = area.x + s1 * area.w;
    const isSplit = g.link && g.link.kind === 'split';
    const barY = area.y + area.h * (isSplit ? 0.1 : 0.14);
    const handles = [];
    if (isSplit) {
      const t = splitThreshold(g);
      const px = area.x + tx.scale(t) * area.w;
      handles.push({ x: px, y: barY, part: 'split', index: 0 });
    } else {
      if (r.lo !== null && r.lo !== undefined) handles.push({ x: x0, y: barY, part: 'lo', index: 0 });
      if (r.hi !== null && r.hi !== undefined) handles.push({ x: x1, y: barY, part: 'hi', index: 1 });
    }
    const vx0 = Math.max(x0, area.x);
    const vx1 = Math.min(x1, area.x + area.w);
    const role = isSplit ? g.link.role : null;
    return {
      gate: g,
      kind: isSplit ? 'split' : 'range',
      x0,
      x1,
      barY,
      bbox: { x0: Math.min(x0, x1), y0: area.y, x1: Math.max(x0, x1), y1: area.y + area.h },
      handles,
      label: isSplit
        ? { x: role === 'L' ? vx1 - 6 : vx0 + 6, y: area.y + 6, align: role === 'L' ? 'right' : 'left', valign: 'top' }
        : { x: Math.max(vx0, area.x) + 4, y: barY - 18, align: 'left', valign: 'top' },
    };
  }
  return null;
}

function pt(p) {
  return { x: p[0], y: p[1] };
}

function clampS(v) {
  if (!Number.isFinite(v)) return v > 0 ? 1.5 : -0.5;
  return Math.max(-0.5, Math.min(1.5, v));
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

function labelForBox(b, area) {
  const x = Math.max(area.x + 4, Math.min(b.x0, area.x + area.w - 30));
  let y = b.y0 - 18;
  if (y < area.y + 2) y = Math.max(area.y + 4, b.y0 + 4);
  return { x, y, align: 'left', valign: 'top' };
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Draw gates and their labels.
 * @param {object[]} shapes from gateShape
 * @param {object} o {selected, hover, theme, labels: Map(id -> {name, value}), overridden:Set, fontLabel, fontValue, showLabels}
 */
export function drawGates(ctx, area, shapes, o) {
  const { theme } = o;
  ctx.save();
  // clip shapes to the plot area (a hair outside so edges on the border stay visible)
  ctx.beginPath();
  ctx.rect(area.x - 1, area.y - 1, area.w + 2, area.h + 2);
  ctx.clip();
  const drawnQuads = new Set();
  for (const sh of shapes) {
    const g = sh.gate;
    const sel = o.selected && (o.selected === g.id || (o.selectedGroup && g.link && g.link.group === o.selectedGroup));
    const hov = o.hover === g.id;
    const color = g.color || theme.accent;
    const dashed = o.overridden && o.overridden.has(g.id);
    ctx.lineWidth = sel ? 2 : 1.5;
    ctx.strokeStyle = color;
    ctx.setLineDash(dashed ? [5, 3] : []);
    if (sh.kind === 'quad') {
      const key = g.link.group;
      if (sel) {
        ctx.fillStyle = withAlpha(color, 0.08);
        fillPath(ctx, sh.path);
      }
      if (drawnQuads.has(key)) continue;
      drawnQuads.add(key);
      const [px, py] = sh.center;
      ctx.strokeStyle = sel ? theme.accent : theme.gateLine;
      ctx.beginPath();
      ctx.moveTo(px, area.y);
      ctx.lineTo(px, area.y + area.h);
      ctx.moveTo(area.x, py);
      ctx.lineTo(area.x + area.w, py);
      ctx.stroke();
      continue;
    }
    if (sh.kind === 'range' || sh.kind === 'split') {
      ctx.fillStyle = withAlpha(color, sel ? 0.14 : hov ? 0.1 : 0.06);
      if (sh.kind === 'range') ctx.fillRect(Math.min(sh.x0, sh.x1), area.y, Math.abs(sh.x1 - sh.x0), area.h);
      ctx.beginPath();
      if (sh.kind === 'range') {
        ctx.moveTo(sh.x0, sh.barY - 6);
        ctx.lineTo(sh.x0, sh.barY + 6);
        ctx.moveTo(sh.x0, sh.barY);
        ctx.lineTo(sh.x1, sh.barY);
        ctx.moveTo(sh.x1, sh.barY - 6);
        ctx.lineTo(sh.x1, sh.barY + 6);
      } else {
        const h = sh.handles[0];
        if (!drawnQuads.has(g.link.group)) {
          drawnQuads.add(g.link.group);
          ctx.strokeStyle = sel ? theme.accent : theme.gateLine;
          ctx.moveTo(h.x, area.y);
          ctx.lineTo(h.x, area.y + area.h);
        }
      }
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = withAlpha(color, sel ? 0.12 : hov ? 0.08 : 0.035);
    fillPath(ctx, sh.path);
    ctx.beginPath();
    sh.path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (sh.closed) ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // handles of the selected gate
  for (const sh of shapes) {
    const g = sh.gate;
    const sel = o.selected === g.id;
    if (!sel || o.readOnly) continue;
    for (const h of sh.handles) {
      ctx.fillStyle = theme.plotBg;
      ctx.strokeStyle = g.color || theme.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (h.part === 'center' || h.part === 'split') ctx.arc(h.x, h.y, HANDLE + 0.5, 0, Math.PI * 2);
      else ctx.rect(h.x - HANDLE, h.y - HANDLE, HANDLE * 2, HANDLE * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();

  // labels: measured, placed without overlaps, then drawn
  if (o.showLabels === false) return [];
  const pad = 4;
  const h = 17;
  const items = [];
  for (const sh of shapes) {
    const g = sh.gate;
    const info = o.labels && o.labels.get(g.id);
    let name = g.name;
    const value = info && info.value ? info.value : '';
    const manual = g.labelPos && sh.kind !== 'quad' ? toPx(area, g.labelPos[0], g.labelPos[1]) : null;
    let { x, y, align, valign } = sh.label;
    if (manual) {
      x = manual[0];
      y = manual[1];
      align = 'left';
      valign = 'top';
    }
    ctx.font = o.fontValue;
    const wv = value ? ctx.measureText(value).width : 0;
    ctx.font = o.fontLabel;
    let wn = ctx.measureText(name).width;
    const room = sh.kind === 'quad' || sh.kind === 'split' ? area.w / 2 - 10 : area.w - 8;
    if (wn + wv + 6 + pad * 2 > room) {
      // too wide: shorten the name, keeping the value
      if (value) {
        name = '';
        wn = 0;
      } else {
        while (name.length > 3 && ctx.measureText(name + '…').width + pad * 2 > room) name = name.slice(0, -1);
        name += '…';
        wn = ctx.measureText(name).width;
      }
    }
    const w = (name ? wn : 0) + (value ? wv + (name ? 6 : 0) : 0) + pad * 2;
    items.push({ sh, g, name, value, wn, w, x, y, align, valign, manual: !!manual });
  }
  const clampBox = (bx, by, w) => [Math.max(area.x + 1, Math.min(bx, area.x + area.w - w - 1)), Math.max(area.y + 1, Math.min(by, area.y + area.h - h - 1))];
  const hits = (a, list) => list.some((b) => a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y);
  const placed = [];
  // corner labels (quadrants) and manual positions first; they do not move
  const order = items.slice().sort((p, q) => (q.sh.kind === 'quad' || q.manual ? 1 : 0) - (p.sh.kind === 'quad' || p.manual ? 1 : 0));
  for (const it of order) {
    const bx0 = it.align === 'right' ? it.x - it.w : it.x;
    const by0 = it.valign === 'bottom' ? it.y - h : it.y;
    const bb = it.sh.bbox;
    const cands = [[bx0, by0]];
    if (!(it.sh.kind === 'quad' || it.manual)) {
      cands.push([bx0, by0 + h + 3], [bx0, by0 - h - 3], [bx0, by0 + 2 * (h + 3)]);
      if (bb) cands.push([bb.x1 - it.w - 4, bb.y0 + 4], [bb.x0 + 4, bb.y1 - h - 4], [bb.x1 - it.w - 4, bb.y1 - h - 4]);
    } else {
      cands.push([bx0, it.valign === 'bottom' ? by0 - h - 3 : by0 + h + 3]);
    }
    let chosen = null;
    for (const [cx, cy] of cands) {
      const [x, y] = clampBox(cx, cy, it.w);
      const box = { x, y, w: it.w, h };
      if (!hits(box, placed)) {
        chosen = box;
        break;
      }
    }
    if (!chosen) {
      const [x, y] = clampBox(cands[0][0], cands[0][1], it.w);
      chosen = { x, y, w: it.w, h };
    }
    it.box = chosen;
    placed.push(chosen);
  }
  const boxes = [];
  ctx.save();
  for (const it of items) {
    const { g, name, value, wn } = it;
    const { x: bx, y: by, w } = it.box;
    const sel = o.selected === g.id;
    ctx.fillStyle = theme.labelBg;
    roundRect(ctx, bx, by, w, h, 4);
    ctx.fill();
    ctx.lineWidth = sel ? 1.5 : 1;
    ctx.strokeStyle = sel ? g.color || theme.accent : withAlpha(g.color || theme.accent, 0.55);
    ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (name) {
      ctx.fillStyle = theme.labelFg;
      ctx.font = o.fontLabel;
      ctx.fillText(name, bx + pad, by + h / 2 + 0.5);
    }
    if (value) {
      ctx.font = o.fontValue;
      ctx.fillStyle = g.color || theme.accent;
      ctx.fillText(value, bx + pad + (name ? wn + 6 : 0), by + h / 2 + 0.5);
    }
    boxes.push({ id: g.id, x: bx, y: by, w, h, title: g.name });
  }
  ctx.restore();
  return boxes;
}

function fillPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

export function withAlpha(color, a) {
  const [r, g, b] = parseColor(color);
  return `rgba(${r},${g},${b},${a})`;
}

/** Hit test shapes (topmost first). Returns {gate, part, index} or null. */
export function hitTest(shapes, labelBoxes, x, y, selectedId) {
  // handles of the selected gate first
  for (const sh of shapes) {
    if (sh.gate.id !== selectedId) continue;
    for (const h of sh.handles) {
      if (Math.abs(h.x - x) <= HANDLE + 3 && Math.abs(h.y - y) <= HANDLE + 3) return { gate: sh.gate, part: h.part, index: h.index, shape: sh };
    }
  }
  for (const b of labelBoxes || []) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      const sh = shapes.find((s) => s.gate.id === b.id);
      return { gate: sh.gate, part: 'label', index: 0, shape: sh };
    }
  }
  // quad centres / split lines
  for (const sh of shapes) {
    if (sh.kind === 'quad') {
      const [cx, cy] = sh.center;
      if (Math.abs(cx - x) <= 6 && Math.abs(cy - y) <= 6) return { gate: sh.gate, part: 'center', index: 0, shape: sh };
    }
    if (sh.kind === 'split') {
      const h = sh.handles[0];
      if (Math.abs(h.x - x) <= 5) return { gate: sh.gate, part: 'split', index: 0, shape: sh };
    }
  }
  for (let i = shapes.length - 1; i >= 0; i--) {
    const sh = shapes[i];
    if (sh.kind === 'range' || sh.kind === 'split') {
      const a = Math.min(sh.x0, sh.x1);
      const b = Math.max(sh.x0, sh.x1);
      if (x >= a && x <= b) return { gate: sh.gate, part: 'body', index: 0, shape: sh };
      continue;
    }
    if (inside(sh.path, x, y)) return { gate: sh.gate, part: 'body', index: 0, shape: sh };
  }
  return null;
}

function inside(poly, x, y) {
  let ins = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a];
    const [xb, yb] = poly[b];
    if ((ya > y) !== (yb > y)) {
      const xi = xa + ((y - ya) * (xb - xa)) / (yb - ya);
      if (x < xi) ins = !ins;
    }
  }
  return ins;
}

/** Read theme colours from CSS custom properties. */
export function readTheme(el) {
  const cs = getComputedStyle(el || document.documentElement);
  const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
  return {
    plotBg: v('--plot-bg', '#ffffff'),
    axis: v('--plot-axis', '#5b6576'),
    tick: v('--plot-tick', '#3d4553'),
    dot: v('--plot-dot', '#2f3540'),
    muted: v('--plot-muted', '#c3c8d1'),
    accent: v('--accent', '#0b72a8'),
    gateLine: v('--plot-gate', '#2c3340'),
    labelBg: v('--plot-label-bg', 'rgba(255,255,255,0.9)'),
    labelFg: v('--plot-label-fg', '#151a23'),
    histFill: v('--plot-hist', '#6b7a90'),
    dark: v('--is-dark', '0') === '1',
    fontUI: v('--font-ui', 'system-ui, sans-serif'),
    fontMono: v('--font-mono', 'ui-monospace, monospace'),
  };
}
