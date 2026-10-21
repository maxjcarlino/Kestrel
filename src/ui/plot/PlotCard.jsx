// Interactive plot: data layer, axes with channel dropdowns, gates and gating tools.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useSel } from '../state/store.js';
import { setUI, updatePlot, removePlot, addPlot, beginTxn, commitTxn, cancelTxn, setGeometry, setQuadCenter, setSplitThreshold, patchGate, renameGate, effectiveGate, toast } from '../state/doc.js';
import { popSig, compKey, gatesForPlot, hiddenChildren, channelInfo, popName, popPath, allChannels, sampleHasChannel } from '../state/derived.js';
import { request } from '../state/bridge.js';
import { makeTransform, transformKey, formatValue } from '../../core/transforms.js';
import { rectFromScale, rangeFromScale, vertexFromScale, ellipseFromBox, translateGeometry, quadCenter, splitThreshold } from '../../core/gate-geometry.js';
import { ROOT, ancestors } from '../../core/gates.js';
import { plotArea, toPx, toScale, hitTest } from './render.js';
import { buildLayer, paintPlot, overlayIds, mergeResults } from './paint.js';
import { createGate, createQuadrant, createSplit, drillDown, gateMenuItems, overriddenSet } from '../state/gating.js';
import { Icon, IconButton, openMenu, rectOf, TextField, Popover, NumberField } from '../components/ui.jsx';
import { AxisMenu } from './AxisMenu.jsx';
import { ConcatMenu } from './ConcatMenu.jsx';
import { useTheme } from '../theme.js';
import { exportPlotImage } from './export.js';

const TWO_D_TOOLS = new Set(['rect', 'polygon', 'ellipse', 'quad']);
const ONE_D_TOOLS = new Set(['range', 'split']);

export const PLOT_TYPES = [
  { value: 'pseudo', label: 'Pseudocolour', icon: 'pseudo' },
  { value: 'dot', label: 'Dot plot', icon: 'dot' },
  { value: 'contour', label: 'Contour', icon: 'contour' },
  { value: 'hist', label: 'Histogram', icon: 'hist' },
];

function useSize(ref) {
  const [size, setSize] = useState({ W: 0, H: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const W = Math.round(r.width);
      const H = Math.round(r.height);
      setSize((s) => (s.W === W && s.H === H ? s : { W, H }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return size;
}

export function PlotCard({ plot, sampleId, index = 0, total = 1 }) {
  const doc = useSel((s) => s.doc);
  const ui = useSel((s) => ({
    tool: s.ui.tool,
    selectedGate: s.ui.selectedGate,
    scope: s.ui.scope,
    editingName: s.ui.editingName,
    flashPlot: s.ui.flashPlot,
    focusPlot: s.ui.focusPlot,
  }));
  const counts = useSel((s) => (s.counts[sampleId] || {}).counts || null);
  const meta = useSel((s) => s.meta[sampleId] || null);
  const metaAll = useSel((s) => s.meta);
  const theme = useTheme();
  const cardRef = useRef();
  const wrapRef = useRef();
  const canvasRef = useRef();
  const { W, H } = useSize(wrapRef);
  const state = store.get();

  const is2D = !!plot.y && plot.type !== 'hist';
  const area = plotArea(W, H);
  const bw = Math.max(16, Math.round(area.w));
  const bh = Math.max(16, Math.round(area.h));
  const histBins = Math.max(64, Math.min(512, Math.round(area.w / 1.25)));
  const ovIds = useMemo(() => overlayIds(doc, plot), [doc.gates, plot.overlay, plot.pop]);
  const ovColors = ovIds.map((id) => (doc.gates[id] ? doc.gates[id].color : theme.accent));
  const status = meta ? meta.status : 'missing';
  const sampleChannels = meta && meta.channels ? meta.channels.map((c) => c.name) : [];
  const missingChannel = status === 'ready' ? [plot.x, is2D ? plot.y : null].filter((c) => c && !sampleHasChannel(doc, sampleChannels, c)) : [];
  const popExists = plot.pop === ROOT || !!doc.gates[plot.pop];

  // Concatenation: pool several samples' binned counts into one plot.
  const concatIds = plot.concatIds && plot.concatIds.length ? plot.concatIds : null;
  const concatReady = concatIds
    ? concatIds.filter((id) => {
        const m = metaAll[id];
        if (!m || m.status !== 'ready') return false;
        const chans = m.channels ? m.channels.map((c) => c.name) : [];
        return [plot.x, is2D ? plot.y : null].every((c) => !c || sampleHasChannel(doc, chans, c));
      })
    : null;
  const sigFor = (id) => [popSig(state, id, plot.pop), ovIds.map((o) => popSig(state, id, o)).join(','), compKey(state, id)].join(',');

  const key =
    (concatReady ? concatReady.length > 0 : sampleId && status === 'ready' && !missingChannel.length) && W > 40 && popExists
      ? [
          concatReady ? `concat:${concatReady.join(',')}:${concatReady.map(sigFor).join(';')}` : `${sampleId}:${sigFor(sampleId)}`,
          plot.pop, plot.x, is2D ? plot.y : '-', is2D ? `${bw}x${bh}` : histBins,
          transformKey(doc.transforms[plot.x]), is2D ? transformKey(doc.transforms[plot.y]) : '',
        ].join('|')
      : null;

  // ---------------------------------------------------------------- data
  const [data, setData] = useState(null);
  const latest = useRef(null);
  latest.current = {
    key,
    ids: concatReady || (sampleId ? [sampleId] : []),
    req: is2D ? { pop: plot.pop, x: plot.x, y: plot.y, w: bw, h: bh, overlays: ovIds } : { pop: plot.pop, x: plot.x, bins: histBins, overlays: ovIds },
  };
  const reqState = useRef({ inflight: false, want: false });
  useEffect(() => {
    if (!key) return;
    const r = reqState.current;
    r.want = true;
    const run = () => {
      if (r.inflight || !r.want) return;
      r.want = false;
      const cur = latest.current;
      if (!cur.key || !cur.ids.length) return;
      r.inflight = true;
      Promise.all(cur.ids.map((id) => request(id, 'plot', { req: cur.req }).catch((err) => ({ missing: [err.message] })))).then((list) => {
        r.inflight = false;
        const res = list.length > 1 ? mergeResults(list) : list[0];
        setData({ key: cur.key, res });
        run();
      });
    };
    run();
  }, [key]);

  const layer = useMemo(() => {
    if (!data || !data.res) return null;
    return buildLayer(data.res, { type: plot.type, settings: { ...doc.settings, dotSize: plot.dotSize ?? doc.settings.dotSize }, theme, overlayColors: ovColors });
  }, [data, plot.type, plot.dotSize, doc.settings.colormap, doc.settings.dotSize, doc.settings.smooth, doc.settings.histSmooth, theme, ovColors.join(',')]);

  const stale = data && data.key !== key;

  let message = null;
  if (concatIds) {
    if (!concatReady.length) message = 'None of the samples chosen for concatenation have this data yet.';
    else if (!popExists) message = 'This population was deleted.';
    else if (data && data.error) message = data.error;
    else if (layer && layer.n === 0 && !stale) message = 'No events in this population across the concatenated samples.';
  } else {
    if (!sampleId) message = 'Add a data file to start.';
    else if (status === 'loading') message = 'Loading data…';
    else if (status === 'missing') message = 'This data file is not loaded. Add it from the Samples panel.';
    else if (status === 'error') message = `Could not read this file: ${meta.error}`;
    else if (!popExists) message = 'This population was deleted.';
    else if (missingChannel.length) message = `${missingChannel.join(' and ')} ${missingChannel.length > 1 ? 'are' : 'is'} not in this sample.`;
    else if (data && data.error) message = data.error;
    else if (layer && layer.n === 0 && !stale) message = 'No events in this population for this sample.';
  }

  // ---------------------------------------------------------------- interaction state
  const gates = useMemo(() => gatesForPlot(doc, plot), [doc.gates, plot.pop, plot.x, plot.y, plot.type]);
  const overridden = useMemo(() => overriddenSet(doc, sampleId), [doc.overrides, sampleId]);
  const inter = useRef({ drag: null, draw: null, hover: null, shapes: [], labelBoxes: [], area });
  const readoutRef = useRef();
  const [, bump] = useState(0);
  const redraw = useRef(() => {});

  const tx = makeTransform(doc.transforms[plot.x]);
  const ty = is2D ? makeTransform(doc.transforms[plot.y]) : tx;

  redraw.current = () => {
    const cv = canvasRef.current;
    if (!cv || W < 10 || H < 10) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const res = paintPlot(ctx, {
      W, H, doc, plot, sampleId, layer, theme, counts, gates,
      selected: ui.selectedGate, hover: inter.current.hover, overridden, message,
    });
    inter.current.shapes = res.shapes;
    inter.current.labelBoxes = res.labelBoxes;
    inter.current.area = res.area;
    drawInteraction(ctx, res.area);
    if (stale && !message) {
      ctx.save();
      ctx.fillStyle = theme.accent;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(res.area.x, res.area.y, Math.min(res.area.w, 36), 2);
      ctx.restore();
    }
  };

  function drawInteraction(ctx, a) {
    const d = inter.current.draw;
    if (!d) return;
    ctx.save();
    ctx.strokeStyle = theme.accent;
    ctx.fillStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    const P = (p) => toPx(a, p[0], p[1]);
    if (d.type === 'rect') {
      const [x0, y0] = P(d.p0);
      const [x1, y1] = P(d.p1);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (d.type === 'ellipse') {
      const [x0, y0] = P(d.p0);
      const [x1, y1] = P(d.p1);
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (d.type === 'polygon') {
      ctx.beginPath();
      d.pts.forEach((p, i) => {
        const [x, y] = P(p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      if (d.cursor) {
        const [cx, cy] = P(d.cursor);
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      d.pts.forEach((p, i) => {
        const [x, y] = P(p);
        ctx.beginPath();
        ctx.arc(x, y, i === 0 ? 4.5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? theme.plotBg : theme.accent;
        ctx.fill();
        ctx.stroke();
      });
    } else if (d.type === 'range') {
      const x0 = a.x + d.s0 * a.w;
      const x1 = a.x + d.s1 * a.w;
      ctx.globalAlpha = 0.15;
      ctx.fillRect(Math.min(x0, x1), a.y, Math.abs(x1 - x0), a.h);
      ctx.globalAlpha = 1;
      ctx.strokeRect(Math.min(x0, x1), a.y, Math.abs(x1 - x0), a.h);
    }
    ctx.restore();
  }

  useLayoutEffect(() => {
    redraw.current();
  });

  // Focus / flash after drill-down
  useEffect(() => {
    if (ui.focusPlot === plot.id && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setUI({ focusPlot: null });
    }
  }, [ui.focusPlot]);
  useEffect(() => {
    if (ui.flashPlot === plot.id) {
      const t = setTimeout(() => setUI({ flashPlot: null }), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [ui.flashPlot]);

  // ---------------------------------------------------------------- pointer handlers
  const local = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const ctxEdit = () => ({ sampleId, scope: store.get().ui.scope });

  const onPointerDown = (e) => {
    if (e.button !== 0 || !layer) return;
    const [x, y] = local(e);
    const a = inter.current.area;
    const s = toScale(a, x, y);
    const tool = store.get().ui.tool;
    const inPlot = x >= a.x - 4 && x <= a.x + a.w + 4 && y >= a.y - 4 && y <= a.y + a.h + 4;
    if (tool === 'select') {
      const hit = hitTest(inter.current.shapes, inter.current.labelBoxes, x, y, store.get().ui.selectedGate);
      if (hit) {
        setUI({ selectedGate: hit.gate.id });
        const g = effectiveGate(store.get().doc, sampleId, hit.gate.id);
        inter.current.drag = { hit, part: hit.part, index: hit.index, start: s, g, moved: false, startPx: [x, y], labelOffset: null };
        if (hit.part === 'label') {
          const lp = g.labelPos;
          const box = inter.current.labelBoxes.find((b) => b.id === g.id);
          const anchor = lp || (box ? toScale(a, box.x, box.y) : s);
          inter.current.drag.labelOffset = [s[0] - anchor[0], s[1] - anchor[1]];
        }
        canvasRef.current.setPointerCapture(e.pointerId);
      } else if (inPlot) {
        setUI({ selectedGate: null });
      }
      return;
    }
    if (!inPlot) return;
    if (is2D && ONE_D_TOOLS.has(tool)) {
      toast('Range and split gates work on histograms. Switch this plot to a histogram, or pick a 2-D tool.', { kind: 'warn' });
      return;
    }
    if (!is2D && TWO_D_TOOLS.has(tool)) {
      toast('That tool needs a two-parameter plot. Use Range or Split on histograms.', { kind: 'warn' });
      return;
    }
    if (tool === 'rect' || tool === 'ellipse') {
      inter.current.draw = { type: tool, p0: s, p1: s };
      canvasRef.current.setPointerCapture(e.pointerId);
    } else if (tool === 'range') {
      inter.current.draw = { type: 'range', s0: s[0], s1: s[0] };
      canvasRef.current.setPointerCapture(e.pointerId);
    } else if (tool === 'polygon') {
      const d = inter.current.draw;
      if (!d || d.type !== 'polygon') {
        inter.current.draw = { type: 'polygon', pts: [s], cursor: s };
      } else {
        const first = toPx(a, d.pts[0][0], d.pts[0][1]);
        if (d.pts.length >= 3 && Math.hypot(first[0] - x, first[1] - y) < 9) {
          finishPolygon();
          return;
        }
        d.pts.push(s);
      }
    } else if (tool === 'quad') {
      createQuadrant(plot, [tx.inverse(clamp01(s[0])), ty.inverse(clamp01(s[1]))]);
    } else if (tool === 'split') {
      createSplit(plot, tx.inverse(clamp01(s[0])));
    }
    redraw.current();
  };

  function finishPolygon() {
    const d = inter.current.draw;
    inter.current.draw = null;
    if (!d || d.pts.length < 3) {
      redraw.current();
      return;
    }
    const pts = d.pts.filter((p, i) => i === 0 || Math.hypot(p[0] - d.pts[i - 1][0], p[1] - d.pts[i - 1][1]) > 0.002);
    if (pts.length < 3) {
      redraw.current();
      return;
    }
    createGate(plot, 'polygon', { polygon: pts.map((p) => vertexFromScale(p, tx, ty)) });
  }

  const onPointerMove = (e) => {
    const [x, y] = local(e);
    const a = inter.current.area;
    const s = toScale(a, x, y);
    const ro = readoutRef.current;
    if (ro) {
      const inside = s[0] >= 0 && s[0] <= 1 && s[1] >= 0 && s[1] <= 1;
      ro.textContent = inside ? (is2D ? `x ${formatValue(tx.inverse(s[0]))}  y ${formatValue(ty.inverse(s[1]))}` : `x ${formatValue(tx.inverse(s[0]))}`) : '';
    }
    const d = inter.current.draw;
    if (d) {
      if (d.type === 'rect' || d.type === 'ellipse') d.p1 = s;
      else if (d.type === 'range') d.s1 = s[0];
      else if (d.type === 'polygon') d.cursor = s;
      redraw.current();
      return;
    }
    const drag = inter.current.drag;
    if (drag) {
      if (!drag.moved) {
        if (Math.hypot(x - drag.startPx[0], y - drag.startPx[1]) < 2) return;
        drag.moved = true;
        beginTxn();
      }
      applyDrag(drag, s, x, y);
      return;
    }
    if (store.get().ui.tool === 'select' && layer) {
      const hit = hitTest(inter.current.shapes, inter.current.labelBoxes, x, y, store.get().ui.selectedGate);
      const hid = hit ? hit.gate.id : null;
      canvasRef.current.style.cursor = hit ? cursorFor(hit) : 'default';
      if (hid !== inter.current.hover) {
        inter.current.hover = hid;
        redraw.current();
      }
    } else {
      canvasRef.current.style.cursor = 'crosshair';
    }
  };

  function applyDrag(drag, s, x, y) {
    const g = drag.g;
    const ctx = { ...ctxEdit(), transient: true };
    const dx = s[0] - drag.start[0];
    const dy = s[1] - drag.start[1];
    const part = drag.part;
    if (part === 'label') {
      patchGate(g.id, { labelPos: [s[0] - drag.labelOffset[0], s[1] - drag.labelOffset[1]] }, { transient: true });
      return;
    }
    if (g.link && g.link.kind === 'quad' && (part === 'body' || part === 'center')) {
      const [cx, cy] = quadCenter(g);
      const ncx = tx.inverse(clamp01(tx.scale(cx) + dx));
      const ncy = ty.inverse(clamp01(ty.scale(cy) + dy));
      setQuadCenter(g.link.group, [ncx, ncy], ctx);
      return;
    }
    if (g.link && g.link.kind === 'split') {
      const t = splitThreshold(g);
      setSplitThreshold(g.link.group, tx.inverse(clamp01(tx.scale(t) + dx)), ctx);
      return;
    }
    if (part === 'body' || (part === 'center' && g.type === 'ellipse')) {
      setGeometry(g.id, translateGeometry(g, dx, is2D ? dy : 0, tx, ty), ctx);
      return;
    }
    if (part === 'vertex' && g.type === 'polygon') {
      const poly = g.polygon.slice();
      poly[drag.index] = vertexFromScale(s, tx, ty);
      setGeometry(g.id, { polygon: poly }, ctx);
      return;
    }
    if (g.type === 'rect' && (part === 'corner' || part === 'edge')) {
      const r = { ...g.rect };
      const setX = (which) => {
        r[which] = s[0] <= 0 ? null : s[0] >= 1 ? null : tx.inverse(s[0]);
      };
      const setY = (which) => {
        r[which] = s[1] <= 0 ? null : s[1] >= 1 ? null : ty.inverse(s[1]);
      };
      const i = drag.index;
      if (part === 'corner') {
        setX(i === 0 || i === 3 ? 'x0' : 'x1');
        setY(i === 0 || i === 1 ? 'y0' : 'y1');
      } else if (i === 0) setX('x0');
      else if (i === 1) setX('x1');
      else if (i === 2) setY('y0');
      else setY('y1');
      // keep the low edge below the high edge
      if (r.x0 !== null && r.x1 !== null && r.x0 > r.x1) [r.x0, r.x1] = [r.x1, r.x0];
      if (r.y0 !== null && r.y1 !== null && r.y0 > r.y1) [r.y0, r.y1] = [r.y1, r.y0];
      setGeometry(g.id, { rect: r }, ctx);
      return;
    }
    if (g.type === 'ellipse' && (part === 'axisA' || part === 'axisB')) {
      const a = inter.current.area;
      const e = g.ellipse;
      const c = [tx.scale(e.c[0]), ty.scale(e.c[1])];
      const u = [tx.scale(e.a[0]) - c[0], ty.scale(e.a[1]) - c[1]];
      const v = [tx.scale(e.b[0]) - c[0], ty.scale(e.b[1]) - c[1]];
      // work in pixels so the axes stay perpendicular on screen
      const up = [u[0] * a.w, -u[1] * a.h];
      const vp = [v[0] * a.w, -v[1] * a.h];
      const cp = toPx(a, c[0], c[1]);
      const pp = [x - cp[0], y - cp[1]];
      let nu = up;
      let nv = vp;
      if (part === 'axisA') {
        nu = [pp[0] * drag.index, pp[1] * drag.index];
        const lu = Math.hypot(nu[0], nu[1]) || 1;
        const lv = Math.hypot(vp[0], vp[1]);
        const cross = up[0] * vp[1] - up[1] * vp[0];
        const sgn = cross >= 0 ? 1 : -1;
        nv = [(-nu[1] / lu) * lv * sgn, (nu[0] / lu) * lv * sgn];
      } else {
        const lv = Math.hypot(vp[0], vp[1]) || 1;
        const dir = [vp[0] / lv, vp[1] / lv];
        const proj = Math.max(3, Math.abs(pp[0] * dir[0] + pp[1] * dir[1]));
        nv = [dir[0] * proj, dir[1] * proj];
      }
      const toS = (p) => [p[0] / a.w, -p[1] / a.h];
      const nus = toS(nu);
      const nvs = toS(nv);
      setGeometry(g.id, {
        ellipse: {
          c: e.c,
          a: [tx.inverse(c[0] + nus[0]), ty.inverse(c[1] + nus[1])],
          b: [tx.inverse(c[0] + nvs[0]), ty.inverse(c[1] + nvs[1])],
        },
      }, ctx);
      return;
    }
    if (g.type === 'range' && (part === 'lo' || part === 'hi')) {
      const r = { ...g.range };
      r[part] = s[0] <= 0 || s[0] >= 1 ? null : tx.inverse(s[0]);
      if (r.lo !== null && r.hi !== null && r.lo > r.hi) [r.lo, r.hi] = [r.hi, r.lo];
      setGeometry(g.id, { range: r }, ctx);
    }
  }

  const onPointerUp = (e) => {
    const d = inter.current.draw;
    if (d && d.type !== 'polygon') {
      inter.current.draw = null;
      try {
        canvasRef.current.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      const a = inter.current.area;
      if (d.type === 'rect' || d.type === 'ellipse') {
        const wpx = Math.abs(d.p1[0] - d.p0[0]) * a.w;
        const hpx = Math.abs(d.p1[1] - d.p0[1]) * a.h;
        if (wpx < 4 || hpx < 4) {
          redraw.current();
          return;
        }
        if (d.type === 'rect') createGate(plot, 'rect', { rect: rectFromScale(d.p0, d.p1, tx, ty) });
        else createGate(plot, 'ellipse', { ellipse: ellipseFromBox(d.p0, d.p1, tx, ty) });
      } else if (d.type === 'range') {
        if (Math.abs(d.s1 - d.s0) * a.w < 3) {
          redraw.current();
          return;
        }
        createGate(plot, 'range', { range: rangeFromScale(d.s0, d.s1, tx) });
      }
      return;
    }
    const drag = inter.current.drag;
    if (drag) {
      inter.current.drag = null;
      if (drag.moved) commitTxn();
    }
  };

  const onDblClick = (e) => {
    const d = inter.current.draw;
    if (d && d.type === 'polygon') {
      e.preventDefault();
      // the second click of the double-click added a duplicate vertex
      if (d.pts.length > 3) d.pts.pop();
      finishPolygon();
      return;
    }
    if (store.get().ui.tool !== 'select') return;
    const [x, y] = local(e);
    const hit = hitTest(inter.current.shapes, inter.current.labelBoxes, x, y, null);
    if (hit) drillDown(hit.gate.id);
  };

  const onContextMenu = (e) => {
    e.preventDefault();
    if (inter.current.draw) {
      inter.current.draw = null;
      redraw.current();
      return;
    }
    const [x, y] = local(e);
    const hit = hitTest(inter.current.shapes, inter.current.labelBoxes, x, y, store.get().ui.selectedGate);
    const anchor = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    if (hit) {
      setUI({ selectedGate: hit.gate.id });
      openMenu(anchor, gateMenuItems(hit.gate.id), { title: hit.gate.name });
    } else {
      openMenu(anchor, plotMenuItems(), { title: 'Plot' });
    }
  };

  const onPointerLeave = () => {
    if (readoutRef.current) readoutRef.current.textContent = '';
    if (inter.current.hover) {
      inter.current.hover = null;
      redraw.current();
    }
  };

  // Escape / Enter for polygon drawing and Delete for the selected gate
  useEffect(() => {
    const key = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      const d = inter.current.draw;
      if (d && e.key === 'Escape') {
        inter.current.draw = null;
        redraw.current();
      } else if (d && d.type === 'polygon' && e.key === 'Enter') {
        finishPolygon();
      } else if (d && d.type === 'polygon' && e.key === 'Backspace') {
        e.preventDefault();
        d.pts.pop();
        if (!d.pts.length) inter.current.draw = null;
        redraw.current();
      } else if (inter.current.drag && e.key === 'Escape') {
        inter.current.drag = null;
        cancelTxn();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // ---------------------------------------------------------------- menus
  function plotMenuItems() {
    const children = Object.values(store.get().doc.gates).filter((g) => (g.parent || ROOT) === plot.pop);
    const pops = popOptions(store.get().doc);
    return [
      { heading: 'Colour events' },
      { label: 'Plain', checked: !plot.overlay || plot.overlay === 'none', onClick: () => updatePlot(plot.id, { overlay: 'none' }) },
      { label: 'By child populations', checked: plot.overlay === 'children', disabled: !children.length, why: 'This population has no child gates yet', onClick: () => updatePlot(plot.id, { overlay: 'children' }) },
      {
        label: 'Highlight a population (backgate)',
        submenu: pops.filter((p) => p.id !== ROOT).map((p) => ({ label: `${'  '.repeat(p.depth)}${p.name}`, checked: plot.overlay === p.id, onClick: () => updatePlot(plot.id, { overlay: p.id }) })),
      },
      { divider: true },
      { label: 'Duplicate plot', icon: 'copy', onClick: () => addPlot({ ...plot, id: undefined }, { after: plot.id }) },
      { label: 'Move earlier', icon: 'left', disabled: index === 0, onClick: () => moveBy(-1) },
      { label: 'Move later', icon: 'right', disabled: index >= total - 1, onClick: () => moveBy(1) },
      { label: 'Export image (PNG)', icon: 'download', onClick: () => exportPlotImage(plot, sampleId, 'png') },
      { label: 'Export image (SVG)', icon: 'download', onClick: () => exportPlotImage(plot, sampleId, 'svg') },
      { divider: true },
      { label: 'Remove plot', icon: 'trash', danger: true, onClick: () => removePlot(plot.id) },
    ];
  }

  function moveBy(dir) {
    import('../state/doc.js').then((m) => m.movePlot(plot.id, dir));
  }

  // ---------------------------------------------------------------- axis menus
  const [axisMenu, setAxisMenu] = useState(null);
  const openAxis = (axis, ev) => setAxisMenu({ axis, anchor: rectOf(ev.currentTarget) });

  // ---------------------------------------------------------------- concatenate & dot size
  const [concatMenu, setConcatMenu] = useState(null);
  const [dotMenu, setDotMenu] = useState(null);
  const defaultDot = doc.settings.dotSize || 1;

  const setType = (t) => {
    if (t === 'hist') updatePlot(plot.id, { type: 'hist', lastY: plot.y || plot.lastY || null, y: null });
    else if (!plot.y) {
      const y = plot.lastY || suggestY(store.get().doc, plot);
      updatePlot(plot.id, { type: t, y });
    } else updatePlot(plot.id, { type: t });
  };

  // ---------------------------------------------------------------- rename overlay
  const editing = ui.editingName && !ui.editingName.tree && gates.some((g) => g.id === ui.editingName.gateId) && (ui.editingName.plotId === plot.id || !ui.editingName.plotId) ? ui.editingName.gateId : null;
  let editBox = null;
  if (editing) {
    const sh = inter.current.shapes.find((x) => x.gate.id === editing);
    const lb = inter.current.labelBoxes.find((b) => b.id === editing);
    if (lb) editBox = { left: lb.x, top: lb.y };
    else if (sh) editBox = { left: sh.label.x, top: sh.label.y };
    else editBox = { left: area.x + 8, top: area.y + 8 };
  }

  const xi = channelInfo(doc, plot.x);
  const yi = plot.y ? channelInfo(doc, plot.y) : null;
  const pathText = popPath(doc, plot.pop);
  const hidden = useMemo(() => hiddenChildren(doc, plot), [doc.gates, plot.pop, plot.x, plot.y, plot.type]);
  const n = layer ? layer.n : null;
  const flash = ui.flashPlot === plot.id;
  const tool = ui.tool;

  return (
    <section ref={cardRef} class={`plot-card ${flash ? 'is-flash' : ''}`} aria-label={`Plot of ${popName(doc, plot.pop)}`} data-plot-id={plot.id}>
      <header class="plot-head">
        <button type="button" class="pop-btn" title={pathText} onClick={(e) => openMenu(rectOf(e.currentTarget), popOptions(doc).map((p) => ({ label: `${' '.repeat(p.depth)}${p.name}`, checked: p.id === plot.pop, onClick: () => updatePlot(plot.id, { pop: p.id }) })), { title: 'Show population' })}>
          <span class="pop-name">{popName(doc, plot.pop)}</span>
          <Icon name="down" size={12} />
        </button>
        <div class="plot-head-tools">
          <div class="mini-seg" role="radiogroup" aria-label="Plot type">
            {PLOT_TYPES.map((t) => (
              <button type="button" role="radio" aria-checked={plot.type === t.value ? 'true' : 'false'} class={plot.type === t.value ? 'is-on' : ''} title={t.label} aria-label={t.label} onClick={() => setType(t.value)} key={t.value}>
                <Icon name={t.icon} size={14} />
              </button>
            ))}
          </div>
          {is2D ? (
            <IconButton icon="dot" label="Dot size" active={plot.dotSize != null} onClick={(e) => setDotMenu(rectOf(e.currentTarget))} />
          ) : null}
          <IconButton icon="layers" label="Concatenate samples" active={!!concatIds} onClick={(e) => setConcatMenu(rectOf(e.currentTarget))} />
          <IconButton icon="more" label="Plot options" onClick={(e) => openMenu(rectOf(e.currentTarget), plotMenuItems(), { title: 'Plot' })} />
        </div>
      </header>
      <div class="plot-body">
        <button type="button" class="axis-y" onClick={(e) => openAxis('y', e)} title="Choose the Y-axis parameter" aria-label={`Y axis: ${yi ? (yi.label ? yi.label + ' ' : '') + yi.name : 'Count'}. Change`}>
          <span class="axis-text">
            {yi ? (
              <>
                {yi.label ? <b>{yi.label}</b> : null}
                <span>{yi.name}</span>
              </>
            ) : (
              <b>Count</b>
            )}
          </span>
          <Icon name="down" size={11} />
        </button>
        <div class={`plot-canvas-wrap tool-${tool}`} ref={wrapRef}>
          <canvas
            ref={canvasRef}
            class="plot-canvas"
            style={{ width: `${W}px`, height: `${H}px` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={onPointerLeave}
            onDblClick={onDblClick}
            onContextMenu={onContextMenu}
            aria-label={`${plot.type === 'hist' ? 'Histogram' : 'Plot'} of ${popName(doc, plot.pop)}: ${xi.label || xi.name}${yi ? ' against ' + (yi.label || yi.name) : ''}`}
            role="img"
          />
          {editing && editBox ? (
            <div class="gate-name-edit" style={{ left: `${editBox.left}px`, top: `${editBox.top}px` }}>
              <TextField
                value={doc.gates[editing].name}
                autoFocus
                onCommit={(v) => renameGate(editing, v)}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if (v) renameGate(editing, v);
                  setUI({ editingName: null });
                }}
                aria-label="Gate name"
              />
            </div>
          ) : null}
        </div>
        <div />
        <button type="button" class="axis-x" onClick={(e) => openAxis('x', e)} title="Choose the X-axis parameter" aria-label={`X axis: ${(xi.label ? xi.label + ' ' : '') + xi.name}. Change`}>
          {xi.label ? <b>{xi.label}</b> : null}
          <span>{xi.name}</span>
          <Icon name="down" size={11} />
        </button>
      </div>
      <footer class="plot-foot">
        <span class="num">
          {n === null ? '…' : `${n.toLocaleString('en-US')} events`}
          {concatIds && concatReady.length ? ` · pooled from ${concatReady.length} sample${concatReady.length > 1 ? 's' : ''}` : ''}
        </span>
        <span class="num readout" ref={readoutRef} aria-hidden="true" />
        {hidden.length ? (
          <button
            type="button"
            class="link-btn"
            onClick={(e) =>
              openMenu(
                rectOf(e.currentTarget),
                hidden.map((g) => ({ label: `${g.name} (${g.y ? `${channelInfo(doc, g.x).label || g.x} × ${channelInfo(doc, g.y).label || g.y}` : channelInfo(doc, g.x).label || g.x})`, onClick: () => updatePlot(plot.id, { x: g.x, y: g.y || null, type: g.y ? (plot.type === 'hist' ? 'pseudo' : plot.type) : 'hist' }) })),
                { title: 'Show gates drawn on other axes' },
              )
            }
          >
            {hidden.length} gate{hidden.length > 1 ? 's' : ''} on other axes
          </button>
        ) : null}
      </footer>
      {axisMenu ? (
        <AxisMenu
          anchor={axisMenu.anchor}
          axis={axisMenu.axis}
          plot={plot}
          sampleId={sampleId}
          onClose={() => setAxisMenu(null)}
        />
      ) : null}
      {concatMenu ? <ConcatMenu anchor={concatMenu} plot={plot} onClose={() => setConcatMenu(null)} /> : null}
      {dotMenu ? (
        <Popover anchor={dotMenu} onClose={() => setDotMenu(null)}>
          <div class="dotsize-pop">
            <label class="dotsize-row">
              <span>Dot size</span>
              <NumberField
                class="field-sm dotsize-field"
                value={plot.dotSize ?? defaultDot}
                step="1"
                autoFocus
                onCommit={(v) => updatePlot(plot.id, { dotSize: Math.max(1, Math.min(20, Math.round(v))) })}
                aria-label="Dot size for this plot"
              />
              <span class="muted">px</span>
            </label>
            {plot.dotSize != null ? (
              <button type="button" class="link-btn dotsize-reset" onClick={() => updatePlot(plot.id, { dotSize: null })}>
                Use default ({defaultDot} px)
              </button>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </section>
  );
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function cursorFor(hit) {
  switch (hit.part) {
    case 'vertex':
    case 'corner':
      return 'crosshair';
    case 'edge':
      return hit.index < 2 ? 'ew-resize' : 'ns-resize';
    case 'lo':
    case 'hi':
    case 'split':
      return 'ew-resize';
    case 'axisA':
    case 'axisB':
      return 'crosshair';
    case 'label':
      return 'grab';
    default:
      return 'move';
  }
}

/** Population list (depth-first) for selectors. */
export function popOptions(doc) {
  const out = [{ id: ROOT, name: 'All events', depth: 0 }];
  const kids = new Map();
  for (const g of Object.values(doc.gates)) {
    const p = g.parent || ROOT;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(g);
  }
  const order = new Map(doc.gateOrder.map((id, i) => [id, i]));
  const walk = (id, depth) => {
    const list = (kids.get(id) || []).slice().sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    for (const g of list) {
      out.push({ id: g.id, name: g.name, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(ROOT, 1);
  return out;
}

function suggestY(doc, plot) {
  const chans = allChannels(doc);
  const other = chans.find((c) => c.name !== plot.x && c.kind === (channelInfo(doc, plot.x).kind === 'scatter' ? 'scatter' : 'fluor'));
  return other ? other.name : chans.find((c) => c.name !== plot.x)?.name || plot.x;
}

export { ancestors };
