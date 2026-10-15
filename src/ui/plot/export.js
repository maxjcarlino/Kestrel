// Figure export: PNG (high resolution canvas) and SVG (vector axes, gates and
// labels with the event layer embedded as an image). SVG output comes from a
// small recording context that mirrors the Canvas 2D calls used by paintPlot,
// so both formats look the same.

import { store } from '../state/store.js';
import { request } from '../state/bridge.js';
import { channelInfo, popName, popPath, gatesForPlot, frequency } from '../state/derived.js';
import { buildLayer, paintPlot, overlayIds, makeCanvas } from './paint.js';
import { plotArea, smoothHist, drawAxes, drawFrame, niceStep, withAlpha } from './render.js';
import { makeTransform } from '../../core/transforms.js';
import { exportTheme } from '../theme.js';
import { saveFile, safeName } from '../util/download.js';
import { report } from '../state/gating.js';
import { toast } from '../state/doc.js';

// ------------------------------------------------------------------ SVG recorder

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paint(c) {
  if (!c || c === 'none') return { color: 'none', opacity: 1 };
  const m = String(c).match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { color: `rgb(${p[0]},${p[1]},${p[2]})`, opacity: p.length > 3 ? p[3] : 1 };
  }
  return { color: c, opacity: 1 };
}

const r2 = (v) => Math.round(v * 100) / 100;

export class SvgContext {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.parts = [];
    this.defs = [];
    this.path = '';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.globalAlpha = 1;
    this.lineCap = 'butt';
    this.imageSmoothingEnabled = true;
    this.dash = [];
    this.stack = [];
    this.openGroups = 0;
    this.clipId = 0;
    this.isSvgRecorder = true;
    this.measure = makeCanvas(4, 4).getContext('2d');
  }
  save() {
    this.stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, globalAlpha: this.globalAlpha, dash: this.dash, groups: this.openGroups });
    this.openGroups = 0;
  }
  restore() {
    while (this.openGroups > 0) {
      this.parts.push('</g>');
      this.openGroups--;
    }
    const st = this.stack.pop();
    if (st) {
      Object.assign(this, { fillStyle: st.fillStyle, strokeStyle: st.strokeStyle, lineWidth: st.lineWidth, font: st.font, textAlign: st.textAlign, textBaseline: st.textBaseline, globalAlpha: st.globalAlpha, dash: st.dash });
      this.openGroups = st.groups;
    }
  }
  setTransform() {}
  setLineDash(d) {
    this.dash = d || [];
  }
  measureText(t) {
    this.measure.font = this.font;
    return this.measure.measureText(t);
  }
  clearRect() {}
  beginPath() {
    this.path = '';
  }
  moveTo(x, y) {
    this.path += `M${r2(x)} ${r2(y)}`;
  }
  lineTo(x, y) {
    this.path += `L${r2(x)} ${r2(y)}`;
  }
  quadraticCurveTo(cx, cy, x, y) {
    this.path += `Q${r2(cx)} ${r2(cy)} ${r2(x)} ${r2(y)}`;
  }
  closePath() {
    this.path += 'Z';
  }
  rect(x, y, w, h) {
    this.path += `M${r2(x)} ${r2(y)}h${r2(w)}v${r2(h)}h${r2(-w)}Z`;
  }
  arc(x, y, r, a0, a1) {
    if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6) {
      this.path += `M${r2(x + r)} ${r2(y)}A${r2(r)} ${r2(r)} 0 1 1 ${r2(x - r)} ${r2(y)}A${r2(r)} ${r2(r)} 0 1 1 ${r2(x + r)} ${r2(y)}`;
    }
  }
  ellipse(x, y, rx, ry) {
    this.path += `M${r2(x + rx)} ${r2(y)}A${r2(rx)} ${r2(ry)} 0 1 1 ${r2(x - rx)} ${r2(y)}A${r2(rx)} ${r2(ry)} 0 1 1 ${r2(x + rx)} ${r2(y)}`;
  }
  attrsFill() {
    const p = paint(this.fillStyle);
    const op = p.opacity * this.globalAlpha;
    return `fill="${p.color}"${op < 1 ? ` fill-opacity="${r2(op)}"` : ''}`;
  }
  attrsStroke() {
    const p = paint(this.strokeStyle);
    const op = p.opacity * this.globalAlpha;
    return `fill="none" stroke="${p.color}" stroke-width="${r2(this.lineWidth)}"${op < 1 ? ` stroke-opacity="${r2(op)}"` : ''}${this.dash.length ? ` stroke-dasharray="${this.dash.join(' ')}"` : ''}${this.lineCap !== 'butt' ? ` stroke-linecap="${this.lineCap}"` : ''}`;
  }
  fill() {
    if (this.path) this.parts.push(`<path d="${this.path}" ${this.attrsFill()}/>`);
  }
  stroke() {
    if (this.path) this.parts.push(`<path d="${this.path}" ${this.attrsStroke()}/>`);
  }
  fillRect(x, y, w, h) {
    this.parts.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${this.attrsFill()}/>`);
  }
  strokeRect(x, y, w, h) {
    this.parts.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${this.attrsStroke()}/>`);
  }
  clip() {
    const id = `clip${++this.clipId}`;
    this.defs.push(`<clipPath id="${id}"><path d="${this.path}"/></clipPath>`);
    this.parts.push(`<g clip-path="url(#${id})">`);
    this.openGroups++;
  }
  textAttrs() {
    const anchor = this.textAlign === 'center' ? 'middle' : this.textAlign === 'right' || this.textAlign === 'end' ? 'end' : 'start';
    const base = this.textBaseline === 'top' ? 'hanging' : this.textBaseline === 'middle' ? 'central' : this.textBaseline === 'bottom' ? 'text-after-edge' : 'alphabetic';
    return `text-anchor="${anchor}" dominant-baseline="${base}" style="font:${esc(this.font)}"`;
  }
  fillText(t, x, y) {
    this.parts.push(`<text x="${r2(x)}" y="${r2(y)}" ${this.textAttrs()} ${this.attrsFill()}>${esc(t)}</text>`);
  }
  rotatedText(t, x, y, angle) {
    this.parts.push(`<text transform="translate(${r2(x)} ${r2(y)}) rotate(${r2((angle * 180) / Math.PI)})" ${this.textAttrs()} ${this.attrsFill()}>${esc(t)}</text>`);
  }
  drawImage(img, x, y, w, h) {
    const url = img.toDataURL('image/png');
    const op = this.globalAlpha < 1 ? ` opacity="${r2(this.globalAlpha)}"` : '';
    this.parts.push(`<image href="${url}" x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" preserveAspectRatio="none" style="image-rendering:pixelated"${op}/>`);
  }
  group(svgInner, dx, dy) {
    this.parts.push(`<g transform="translate(${r2(dx)} ${r2(dy)})">${svgInner}</g>`);
  }
  inner() {
    while (this.openGroups > 0) {
      this.parts.push('</g>');
      this.openGroups--;
    }
    return (this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '') + this.parts.join('');
  }
  toString() {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">${this.inner()}</svg>\n`;
  }
}

export function rotatedText(ctx, text, x, y, angle) {
  if (ctx.isSvgRecorder) return ctx.rotatedText(text, x, y, angle);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillText(text, 0, 0);
  ctx.restore();
  return undefined;
}

// ------------------------------------------------------------------ figure panels

const TITLE_H = 22;
const XT_H = 20;
const YT_W = 18;

/** Fetch the event layer for a plot at a given size. */
export async function fetchLayer(plot, sampleId, W, H, theme) {
  const s = store.get();
  const doc = s.doc;
  const is2D = !!plot.y && plot.type !== 'hist';
  const area = plotArea(W, H);
  const ov = overlayIds(doc, plot);
  const req = is2D
    ? { pop: plot.pop, x: plot.x, y: plot.y, w: Math.round(area.w), h: Math.round(area.h), overlays: ov }
    : { pop: plot.pop, x: plot.x, bins: Math.max(64, Math.min(512, Math.round(area.w / 1.25))), overlays: ov };
  const res = await request(sampleId, 'plot', { req });
  if (res.missing) return { layer: null, message: `${res.missing.join(' and ')} not in this sample` };
  const layer = buildLayer(res, { type: plot.type, settings: doc.settings, theme, overlayColors: ov.map((id) => (doc.gates[id] ? doc.gates[id].color : theme.accent)) });
  return { layer, message: layer && layer.n === 0 ? 'No events' : null };
}

/**
 * Draw one titled panel (plot + axis titles) at (ox, oy) with outer size PW×PH.
 */
export function drawPanel(ctx, o) {
  const { plot, sampleId, layer, message, theme, title, subtitle, ox, oy, PW, PH } = o;
  const s = store.get();
  const doc = s.doc;
  const counts = (s.counts[sampleId] || {}).counts || null;
  const W = PW - YT_W;
  const H = PH - TITLE_H - XT_H;
  ctx.save();
  if (!ctx.isSvgRecorder) ctx.translate(ox, oy);
  const off = ctx.isSvgRecorder ? [ox, oy] : [0, 0];
  // title
  ctx.fillStyle = theme.labelFg;
  ctx.font = `600 12px ${theme.fontUI}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(title || popName(doc, plot.pop), off[0] + YT_W + 2, off[1] + TITLE_H / 2);
  if (subtitle) {
    ctx.font = `400 10.5px ${theme.fontUI}`;
    ctx.fillStyle = theme.tick;
    ctx.textAlign = 'right';
    ctx.fillText(subtitle, off[0] + PW - 6, off[1] + TITLE_H / 2);
  }
  // plot body
  const inner = ctx.isSvgRecorder ? new SvgContext(W, H) : null;
  const target = inner || ctx;
  if (!inner) {
    ctx.save();
    ctx.translate(YT_W, TITLE_H);
  }
  paintPlot(target, { W, H, doc, plot, sampleId, layer, theme, counts, gates: o.gates || gatesForPlot(doc, plot), selected: o.selected || null, hover: null, readOnly: true, overridden: new Set(), message, noClear: true });
  if (inner) ctx.group(inner.inner(), ox + YT_W, oy + TITLE_H);
  else ctx.restore();
  // axis titles
  const area = plotArea(W, H);
  const xi = channelInfo(doc, plot.x);
  const xt = xi.label ? `${xi.label} (${xi.name})` : xi.name;
  ctx.fillStyle = theme.labelFg;
  ctx.font = `500 11px ${theme.fontUI}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(xt, off[0] + YT_W + area.x + area.w / 2, off[1] + TITLE_H + H + XT_H / 2);
  let yt = 'Count';
  if (plot.y && plot.type !== 'hist') {
    const yi = channelInfo(doc, plot.y);
    yt = yi.label ? `${yi.label} (${yi.name})` : yi.name;
  }
  rotatedText(ctx, yt, off[0] + YT_W / 2 + 1, off[1] + TITLE_H + area.y + area.h / 2, -Math.PI / 2);
  ctx.restore();
}

/** Export a single plot. */
export async function exportPlotImage(plot, sampleId, format) {
  if (!sampleId) return;
  const s = store.get();
  const theme = exportTheme();
  const PW = 380;
  const PH = 400;
  const smp = s.doc.samples.find((x) => x.id === sampleId);
  try {
    const { layer, message } = await fetchLayer(plot, sampleId, PW - YT_W, PH - TITLE_H - XT_H, theme);
    const title = popPath(s.doc, plot.pop);
    const subtitle = smp ? smp.name : '';
    const base = safeName(`${smp ? smp.name : 'plot'} - ${popName(s.doc, plot.pop)}`);
    if (format === 'svg') {
      const svg = new SvgContext(PW, PH);
      svg.fillStyle = '#ffffff';
      svg.fillRect(0, 0, PW, PH);
      drawPanel(svg, { plot, sampleId, layer, message, theme, title, subtitle, ox: 0, oy: 0, PW, PH });
      report(await saveFile(`${base}.svg`, svg.toString()), 'Plot exported as SVG');
    } else {
      const scale = 3;
      const c = makeCanvas(PW * scale, PH * scale);
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, PW, PH);
      drawPanel(ctx, { plot, sampleId, layer, message, theme, title, subtitle, ox: 0, oy: 0, PW, PH });
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      report(await saveFile(`${base}.png`, blob), 'Plot exported as PNG');
    }
  } catch (e) {
    toast(`Export failed: ${e.message}`, { kind: 'error' });
  }
}

// ------------------------------------------------------------------ overlay histograms

export async function fetchOverlay(spec, bins = 256) {
  const s = store.get();
  const out = [];
  for (const sid of spec.sampleIds) {
    if ((s.meta[sid] || {}).status !== 'ready') continue;
    try {
      const res = await request(sid, 'plot', { req: { pop: spec.pop, x: spec.channel, bins } });
      if (res.missing) continue;
      out.push({ sampleId: sid, counts: res.counts, n: res.n });
    } catch (e) {
      /* skip */
    }
  }
  return out;
}

export const SERIES_COLORS = ['#1f6fd1', '#d9480f', '#2b8a3e', '#ae3ec9', '#e67700', '#0b7285', '#c2255c', '#5f3dc4', '#5c940d', '#495057'];

/** Draw an overlay histogram (normalised to mode, optionally offset). */
export function drawOverlay(ctx, o) {
  const { spec, series, theme, W, H } = o;
  const s = store.get();
  const doc = s.doc;
  const tx = makeTransform(doc.transforms[spec.channel]);
  const offset = spec.mode === 'offset';
  const legendW = 0;
  const area = plotArea(W - legendW, H);
  drawFrame(ctx, area, theme);
  const k = series.length;
  const step = offset && k > 1 ? Math.min(0.32, 0.75 / k) : 0;
  const hScale = offset && k > 1 ? 1 - step * (k - 1) : 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  const smoothed = series.map((ser) => smoothHist(ser.counts, 1.4));
  let gmax = 0;
  for (const sm of smoothed) for (const v of sm) if (v > gmax) gmax = v;
  series.forEach((ser, i) => {
    const sm = smoothed[i];
    let mx = 0;
    for (const v of sm) if (v > mx) mx = v;
    const total = ser.n || 1;
    const norm = spec.normalize === 'count' ? gmax : spec.normalize === 'percent' ? total : mx;
    const base = area.y + area.h - (offset ? i * step * area.h : 0);
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    const n = sm.length;
    ctx.beginPath();
    ctx.moveTo(area.x, base);
    for (let b = 0; b < n; b++) {
      const x = area.x + ((b + 0.5) / n) * area.w;
      const yv = norm > 0 ? sm[b] / norm : 0;
      ctx.lineTo(x, base - yv * hScale * area.h * (spec.normalize === 'percent' ? 4 : 1));
    }
    ctx.lineTo(area.x + area.w, base);
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, offset ? 0.35 : 0.15);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  ctx.restore();
  drawAxes(ctx, area, { tx, ty: null, theme, font: `10.5px ${theme.fontUI}`, yMax: 0 });
  // legend
  ctx.save();
  ctx.font = `500 10.5px ${theme.fontUI}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  series.forEach((ser, i) => {
    const smp = doc.samples.find((x) => x.id === ser.sampleId);
    const label = smp ? smp.name : '?';
    const y = area.y + 10 + i * 15;
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    ctx.fillStyle = color;
    ctx.fillRect(area.x + area.w - 118, y - 4, 10, 8);
    ctx.fillStyle = theme.labelFg;
    ctx.fillText(label.length > 16 ? label.slice(0, 15) + '…' : label, area.x + area.w - 104, y);
  });
  ctx.restore();
  return area;
}

export { niceStep, frequency };
