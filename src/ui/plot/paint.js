// Shared plot painting used by interactive plots, batch layouts and exports.

import { makeTransform } from '../../core/transforms.js';
import { ROOT } from '../../core/gates.js';
import { formatStat } from '../../core/stats.js';
import {
  plotArea, densityImage, dotImage, contours, smoothHist, drawFrame, drawAxes, gateShape, drawGates, parseColor, withAlpha, toPx,
} from './render.js';
import { frequency } from '../state/derived.js';
import { effectiveGate } from '../state/doc.js';

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
  for (const g of gates) {
    const v = frequency(doc, counts, g.id, stat === 'count' ? 'count' : stat);
    let value = '';
    if (Number.isFinite(v)) value = stat === 'count' ? formatStat('count', v) : `${formatStat('freqParent', v)}%`;
    map.set(g.id, { value });
  }
  return map;
}

/**
 * Paint a complete plot into a 2D context sized W×H (CSS pixels).
 * Returns {area, shapes, labelBoxes}.
 */
export function paintPlot(ctx, o) {
  const { W, H, doc, plot, sampleId, layer, theme, counts, selected, hover, readOnly, overridden, message } = o;
  const is2D = !!plot.y && plot.type !== 'hist';
  const area = plotArea(W, H);
  const tx = makeTransform(doc.transforms[plot.x]);
  const ty = is2D ? makeTransform(doc.transforms[plot.y]) : null;
  if (!o.noClear) ctx.clearRect(0, 0, W, H);
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
