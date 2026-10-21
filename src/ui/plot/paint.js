// Shared plot painting used by interactive plots, batch layouts and exports.

import { makeTransform } from '../../core/transforms.js';
import { ROOT } from '../../core/gates.js';
import { formatStat, STATS } from '../../core/stats.js';
import {
  plotArea, densityImage, dotImage, contours, smoothHist, drawFrame, drawAxes, gateShape, drawGates, parseColor, withAlpha, toPx,
} from './render.js';
import { frequency, hierarchyRows } from '../state/derived.js';
import { effectiveGate } from '../state/doc.js';

/** Stat columns a gating-hierarchy panel can show, and their default set. */
export const TREE_STATS = ['count', 'freqParent', 'freqGrandparent', 'freqTotal'];
export const TREE_STATS_DEFAULT = ['count', 'freqParent'];
// A hierarchy panel has no axis ticks, so it doesn't need the scatter-plot
// margin (left gutter for y-axis ticks, bottom gutter for x-axis ticks).
const TREE_MARGIN = { l: 6, r: 6, t: 4, b: 4 };

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Ids of populations coloured on top of a plot. */
export function overlayIds(doc, plot) {
  if (!plot.overlay || plot.overlay === 'none') return [];
  if (plot.overlay === 'children') {
    return Object.values(doc.gates)
      .filter((g) => (g.parent || ROOT) === plot.pop)
      .map((g) => g.id);
  }
  return doc.gates[plot.overlay] ? [plot.overlay] : [];
}

/**
 * Pool several engine 'plot' results (one per sample, same req) into one by
 * summing their binned counts. Used to concatenate samples into one plot.
 */
export function mergeResults(list) {
  const valid = (list || []).filter((r) => r && !r.missing);
  if (!valid.length) return (list || []).find((r) => r && r.missing) || null;
  const first = valid[0];
  const counts = new Uint32Array(first.counts.length);
  const overlays = (first.overlays || []).map((o) => ({ id: o.id, counts: new Uint32Array(o.counts.length), n: 0 }));
  let n = 0;
  let total = 0;
  for (const r of valid) {
    for (let i = 0; i < counts.length; i++) counts[i] += r.counts[i] || 0;
    n += r.n || 0;
    total += r.total || 0;
    (r.overlays || []).forEach((o, i) => {
      if (!overlays[i]) return;
      for (let j = 0; j < overlays[i].counts.length; j++) overlays[i].counts[j] += o.counts[j] || 0;
      overlays[i].n += o.n || 0;
    });
  }
  return { ...first, counts, overlays, n, total };
}

/**
 * Turn an engine plot result into a drawable layer.
 * @returns {{kind, canvas?, levels?, series?, overlays?, ymax?, n}}
 */
export function buildLayer(res, { type, settings, theme, overlayColors = [] }) {
  if (!res || res.missing) return null;
  if (res.kind === '2d') {
    const { w, h, counts } = res;
    // sparse populations get larger dots so they stay visible
    const dot = Math.max(settings.dotSize || 1, res.n > 0 && res.n < 3000 ? 2 : 1);
    let img;
    const layers = (res.overlays || []).map((o, i) => ({ counts: o.counts, rgb: parseColor(overlayColors[i] || theme.accent) }));
    if (layers.length) {
      img = dotImage(counts, w, h, parseColor(theme.muted), layers, dot);
    } else if (type === 'dot') {
      img = dotImage(counts, w, h, parseColor(theme.dot), [], dot);
    } else if (type === 'contour') {
      const c = contours(counts, w, h, { cell: Math.max(2, Math.round(Math.min(w, h) / 70)) });
      const outl = new Uint32Array(counts.length);
      for (let i = 0; i < counts.length; i++) outl[i] = c.outlier[i] ? 1 : 0;
      const oimg = dotImage(outl, w, h, parseColor(theme.dot), [], 1);
      const canvas = makeCanvas(w, h);
      canvas.getContext('2d').putImageData(oimg, 0, 0);
      return { kind: 'contour', canvas, levels: c.levels, w, h, n: res.n };
    } else {
      const sigma = Math.max(0.8, Math.min(w, h) / 160) * (settings.smooth ?? 1);
      img = densityImage(counts, w, h, { cmap: settings.colormap, dark: theme.dark, sigma, dot });
    }
    const canvas = makeCanvas(w, h);
    canvas.getContext('2d').putImageData(img, 0, 0);
    return { kind: 'image', canvas, w, h, n: res.n };
  }
  if (res.kind === '1d') {
    const sm = settings.histSmooth ? 1.4 : 0;
    const series = smoothHist(res.counts, sm);
    const overlays = (res.overlays || []).map((o, i) => ({ series: smoothHist(o.counts, sm), color: overlayColors[i] || theme.accent }));
    let ymax = 0;
    for (const v of series) if (v > ymax) ymax = v;
    for (const o of overlays) for (const v of o.series) if (v > ymax) ymax = v;
    return { kind: 'hist', series, overlays, ymax: ymax * 1.08 || 1, n: res.n };
  }
  return null;
}

/** Label text for each gate on a plot. */
export function gateLabels(doc, counts, gates, stat) {
  const map = new Map();
  const unit = (STATS[stat] && STATS[stat].unit) || '';
  for (const g of gates) {
    const v = frequency(doc, counts, g.id, stat);
    const value = Number.isFinite(v) ? `${formatStat(stat, v)}${unit}` : '';
    map.set(g.id, { value });
  }
  return map;
}

/**
 * Draw a gating-hierarchy panel: the gate tree under `plot.pop` (ROOT for
 * the whole hierarchy), one row per population, with the stat columns from
 * `plot.statCols` (count / % parent / % grandparent / % total) right
 * aligned next to each name.
 */
export function paintHierarchy(ctx, { area, doc, plot, counts, theme, selected }) {
  const stats = (plot.statCols && plot.statCols.length ? plot.statCols : TREE_STATS_DEFAULT).filter((s) => STATS[s]);
  const rowH = 19;
  const headerH = 17;
  const padX = 6;
  // Keep at least ~70px for names; split whatever's left between stat columns,
  // never wider than 48px each (narrower when the panel or the list is small).
  const minNameW = 70;
  const colW = stats.length ? Math.max(30, Math.min(48, Math.floor((area.w - padX * 2 - minNameW) / stats.length))) : 0;
  const statsW = stats.length * colW;
  const nameW = Math.max(30, area.w - padX * 2 - statsW);
  const small = area.w < 170;
  const fontHead = `600 ${small ? 9 : 10}px ${theme.fontUI}`;
  const fontName = `500 ${small ? 10 : 11}px ${theme.fontUI}`;
  const fontVal = `500 ${small ? 10 : 11}px ${theme.fontMono}`;

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();

  ctx.textBaseline = 'middle';
  ctx.font = fontHead;
  ctx.fillStyle = theme.muted;
  const hy = area.y + headerH / 2 + 1;
  ctx.textAlign = 'left';
  ctx.fillText('Population', area.x + padX, hy);
  stats.forEach((key, i) => {
    ctx.textAlign = 'right';
    ctx.fillText(STATS[key].short, area.x + padX + nameW + i * colW + colW - 6, hy);
  });
  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(area.x, area.y + headerH + 0.5);
  ctx.lineTo(area.x + area.w, area.y + headerH + 0.5);
  ctx.stroke();

  const rootId = plot.pop && plot.pop !== ROOT ? plot.pop : ROOT;
  const rows = hierarchyRows(doc, rootId);
  const allRows = rootId === ROOT ? [{ gate: null, depth: 0 }, ...rows] : rows;
  const maxRows = Math.max(0, Math.floor((area.h - headerH) / rowH));
  const shown = allRows.slice(0, maxRows);
  const overflow = allRows.length - shown.length;

  let y = area.y + headerH;
  for (const { gate, depth } of shown) {
    const rowY = y;
    y += rowH;
    const gid = gate ? gate.id : ROOT;
    if (selected != null && selected === gid) {
      ctx.fillStyle = withAlpha(theme.accent, 0.14);
      ctx.fillRect(area.x, rowY, area.w, rowH);
    }
    const cy = rowY + rowH / 2;
    const indent = Math.min(depth, 4) * 8;
    ctx.textAlign = 'left';
    ctx.font = fontName;
    ctx.fillStyle = theme.labelFg;
    let nameX = area.x + padX + indent;
    if (gate && gate.color) {
      ctx.save();
      ctx.fillStyle = gate.color;
      ctx.beginPath();
      ctx.arc(nameX + 3, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = theme.labelFg;
      nameX += 9;
    }
    const name = gate ? gate.name : 'All events';
    const avail = Math.max(10, area.x + padX + nameW - nameX);
    let text = name;
    if (ctx.measureText(text).width > avail) {
      while (text.length > 1 && ctx.measureText(`${text}…`).width > avail) text = text.slice(0, -1);
      text += '…';
    }
    ctx.fillText(text, nameX, cy);
    ctx.font = fontVal;
    ctx.fillStyle = theme.tick;
    ctx.textAlign = 'right';
    stats.forEach((key, i) => {
      const v = frequency(doc, counts, gid, key);
      const txt = Number.isFinite(v) ? `${formatStat(key, v)}${STATS[key].unit || ''}` : '–';
      ctx.fillText(txt, area.x + padX + nameW + i * colW + colW - 6, cy);
    });
  }
  if (overflow > 0) {
    ctx.textAlign = 'left';
    ctx.font = `500 10px ${theme.fontUI}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(`+${overflow} more`, area.x + padX, y + rowH / 2);
  }
  ctx.restore();
}

/**
 * Paint a complete plot into a 2D context sized W×H (CSS pixels).
 * Returns {area, shapes, labelBoxes}.
 */
export function paintPlot(ctx, o) {
  const { W, H, doc, plot, sampleId, layer, theme, counts, selected, hover, readOnly, overridden, message } = o;
  const area = plot.type === 'tree' ? plotArea(W, H, TREE_MARGIN) : plotArea(W, H);
  if (!o.noClear) ctx.clearRect(0, 0, W, H);
  if (plot.type === 'tree') {
    drawFrame(ctx, area, theme);
    paintHierarchy(ctx, { area, doc, plot, counts, theme, selected });
    if (message) {
      ctx.save();
      ctx.fillStyle = theme.labelBg;
      ctx.fillRect(area.x + 1, area.y + 1, area.w - 2, area.h - 2);
      ctx.fillStyle = theme.tick;
      ctx.font = `500 12px ${theme.fontUI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      wrapText(ctx, message, area.x + area.w / 2, area.y + area.h / 2, area.w - 24, 16);
      ctx.restore();
    }
    return { area, shapes: [], labelBoxes: [] };
  }
  const is2D = !!plot.y && plot.type !== 'hist';
  const tx = makeTransform(doc.transforms[plot.x]);
  const ty = is2D ? makeTransform(doc.transforms[plot.y]) : null;
  drawFrame(ctx, area, theme);
  const fontTick = `10.5px ${theme.fontUI}`;
  if (layer && layer.kind === 'image') {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer.canvas, area.x, area.y, area.w, area.h);
    ctx.restore();
  } else if (layer && layer.kind === 'contour') {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(layer.canvas, area.x, area.y, area.w, area.h);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    const kx = area.w / layer.w;
    const ky = area.h / layer.h;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    layer.levels.forEach((lv) => {
      ctx.strokeStyle = theme.dark ? 'rgba(226,232,240,0.85)' : 'rgba(30,36,46,0.85)';
      ctx.beginPath();
      const s = lv.segs;
      for (let i = 0; i < s.length; i += 4) {
        ctx.moveTo(area.x + s[i] * kx, area.y + area.h - s[i + 1] * ky);
        ctx.lineTo(area.x + s[i + 2] * kx, area.y + area.h - s[i + 3] * ky);
      }
      ctx.stroke();
    });
    ctx.restore();
  } else if (layer && layer.kind === 'hist') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    const n = layer.series.length;
    const path = (series) => {
      ctx.beginPath();
      ctx.moveTo(area.x, area.y + area.h);
      for (let i = 0; i < n; i++) {
        const x = area.x + ((i + 0.5) / n) * area.w;
        const y = area.y + area.h - (series[i] / layer.ymax) * area.h;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(area.x + area.w, area.y + area.h);
      ctx.closePath();
    };
    const base = layer.overlays.length ? theme.muted : theme.histFill;
    path(layer.series);
    ctx.fillStyle = withAlpha(base, layer.overlays.length ? 0.35 : 0.32);
    ctx.fill();
    ctx.strokeStyle = base;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    for (const ov of layer.overlays) {
      path(ov.series);
      ctx.fillStyle = withAlpha(ov.color, 0.18);
      ctx.fill();
      ctx.strokeStyle = ov.color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }
  drawAxes(ctx, area, { tx, ty, theme, font: fontTick, yMax: !is2D && layer ? layer.ymax : 0 });

  // gates
  const gates = o.gates || [];
  const shapes = [];
  for (const g of gates) {
    const eff = effectiveGate(doc, sampleId, g.id) || g;
    const sh = gateShape(eff, area, tx, ty || tx);
    if (sh) shapes.push(sh);
  }
  const labels = gateLabels(doc, counts, gates, doc.settings.labelStat || 'freqParent');
  const selGate = selected ? doc.gates[selected] : null;
  const labelBoxes = drawGates(ctx, area, shapes, {
    theme,
    selected,
    selectedGroup: selGate && selGate.link ? selGate.link.group : null,
    hover,
    labels,
    overridden,
    readOnly,
    showLabels: doc.settings.showLabels !== false,
    fontLabel: `600 11px ${theme.fontUI}`,
    fontValue: `500 11px ${theme.fontMono}`,
  });

  if (message) {
    ctx.save();
    ctx.fillStyle = theme.labelBg;
    ctx.fillRect(area.x + 1, area.y + 1, area.w - 2, area.h - 2);
    ctx.fillStyle = theme.tick;
    ctx.font = `500 12px ${theme.fontUI}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    wrapText(ctx, message, area.x + area.w / 2, area.y + area.h / 2, area.w - 24, 16);
    ctx.restore();
  }
  return { area, shapes, labelBoxes, tx, ty };
}

function wrapText(ctx, text, x, y, maxW, lh) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  const y0 = y - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * lh));
}

export { toPx };
