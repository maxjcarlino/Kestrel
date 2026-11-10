// Layout: batch figures (plots × samples) and histogram overlays, exportable.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { setLayout, toast, addPlot, updatePlot, removePlot } from '../state/doc.js';
import { resolveSamples } from '../state/sample-select.js';
import { SampleSelect } from './SampleSelect.jsx';
import { popName, popSig, compKey, channelInfo, allChannels, gatingPlots } from '../state/derived.js';
import { materializePlot } from '../state/gating.js';
import { transformKey } from '../../core/transforms.js';
import { newId } from '../../core/gate-geometry.js';
import { ROOT } from '../../core/gates.js';
import { STATS } from '../../core/stats.js';
import { fetchLayer, fetchPanelLayer, drawPanel, SvgContext, fetchOverlay, drawOverlay, SERIES_COLORS, panelStyle, panelGeom, layoutDefaults } from '../plot/export.js';
import { watchCounts } from '../state/bridge.js';
import { makeCanvas, TREE_STATS, TREE_STATS_DEFAULT } from '../plot/paint.js';
import { useTheme, exportTheme } from '../theme.js';
import { Icon, IconButton, Button, Segmented, Empty, openMenu, rectOf, Popover } from './ui.jsx';
import { popOptions } from '../plot/PlotCard.jsx';
import { saveFile, safeName } from '../util/download.js';
import { report } from '../state/gating.js';

const TITLE = 22;

function plotLabel(doc, p) {
  if (p.type === 'tree') return `${popName(doc, p.pop)} · Gating hierarchy`;
  const x = channelInfo(doc, p.x);
  const y = p.y ? channelInfo(doc, p.y) : null;
  return `${popName(doc, p.pop)} · ${x.label || x.name}${y && p.type !== 'hist' ? ` × ${y.label || y.name}` : ''}`;
}

/**
 * One read-only panel (Batch and Layout). With `style` (a Layout panel
 * style), its size, text and visible elements follow that; otherwise it's
 * drawn at `size` the standard way.
 */
export function StaticPanel({ plot, sampleId, size, title, subtitle, showTitle = true, showAxisLabels = true, style = null, onClick = null, active = false }) {
  const ref = useRef();
  const doc = useSel((s) => s.doc);
  const status = useSel((s) => (s.meta[sampleId] || {}).status);
  const counts = useSel((s) => (s.counts[sampleId] || {}).counts);
  const theme = useTheme();
  const state = store.get();
  const geom = style ? panelGeom(style) : null;
  const PW = geom ? geom.PW : size;
  const PH = geom ? geom.PH : size + 40;
  const styleKey = style ? JSON.stringify(style) : '';
  const key = status === 'ready'
    ? [
        sampleId, plot.pop, plot.x, plot.y, plot.type, plot.overlay, size, styleKey,
        popSig(state, sampleId, plot.pop), transformKey(doc.transforms[plot.x]), plot.y ? transformKey(doc.transforms[plot.y]) : '',
        compKey(state, sampleId), doc.settings.colormap, doc.settings.dotSize, plot.dotSize,
        (plot.concatIds || []).join(','), (plot.statCols || []).join(','),
      ].join('|')
    : null;
  const [layer, setLayer] = useState(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    (style ? fetchPanelLayer(plot, sampleId, style, theme) : fetchLayer(plot, sampleId, PW - 18, PH - 22 - 20, theme)).then((r) => alive && setLayer(r), () => {});
    return () => {
      alive = false;
    };
  }, [key, theme]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = PW * dpr;
    c.height = PH * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PW, PH);
    if (!layer) return;
    drawPanel(ctx, { plot, sampleId, layer: layer.layer, message: status === 'ready' ? layer.message : 'Not loaded', theme, title, subtitle, ox: 0, oy: 0, PW, PH, showTitle, showAxisLabels, style });
  }, [layer, doc.gates, doc.overrides, doc.settings, counts, theme, title, subtitle, showTitle, showAxisLabels, styleKey]);
  const label = `${title}${subtitle ? `, ${subtitle}` : ''}`;
  const canvas = <canvas ref={ref} class="static-panel" style={{ width: `${PW}px`, height: `${PH}px` }} role="img" aria-label={label} />;
  if (!onClick) return canvas;
  return (
    <button type="button" class={`panel-btn ${active ? 'is-on' : ''}`} onClick={onClick} title="Click to change how this plot is drawn">
      {canvas}
    </button>
  );
}

export function LayoutView() {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const L = doc.layout;
  const plots = L.plotIds.map((id) => doc.plots.find((p) => p.id === id)).filter(Boolean);
  // the figure's samples, in order: a group (in the sample list's order) or a hand-picked list
  const sampleSel = { groupId: L.groupId || null, ids: Array.isArray(L.sampleIds) ? L.sampleIds : null };
  const samples = resolveSamples(doc, meta, sampleSel).filter((x) => (meta[x.id] || {}).status === 'ready');
  const size = L.size || 220;
  const [exporting, setExporting] = useState(false);
  // the plot whose style popover is open, and where it opened
  const [styling, setStyling] = useState(null);
  const styleFor = (p) => panelStyle(L, p.id);
  const geomFor = (p) => panelGeom(styleFor(p));
  const openStyle = (p, e) => setStyling({ plotId: p.id, anchor: rectOf(e.currentTarget) });
  // read the layout fresh: several quick clicks can land before a re-render
  const togglePlot = (id) => {
    const ids = store.get().doc.layout.plotIds;
    setLayout({ plotIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] });
  };
  // Offer a plot for every gate, not only the plots the Gating view has; a
  // stand-in becomes a real plot when it's ticked (see gatingPlots).
  const choices = gatingPlots(doc);
  const pick = (p) => (p.auto ? setLayout({ plotIds: [...store.get().doc.layout.plotIds, materializePlot(p)] }) : togglePlot(p.id));
  const rows = L.transpose ? plots : samples;
  const cols = L.transpose ? samples : plots;
  // each plot can have its own size: a column of plots is as wide as its
  // plot; with plots as rows, every column fits the widest plot
  const widest = plots.reduce((m, p) => Math.max(m, geomFor(p).PW), 0);
  const colWidths = L.transpose ? cols.map(() => widest) : cols.map((p) => geomFor(p).PW);

  // Keep every sample shown in the grid current, not just the active one.
  const sampleIdsKey = samples.map((x) => x.id).join(',');
  useEffect(() => {
    watchCounts(sampleIdsKey ? sampleIdsKey.split(',') : []);
    return () => watchCounts([]);
  }, [sampleIdsKey]);

  const exportGrid = async (format) => {
    if (!plots.length || !samples.length) return;
    setExporting(true);
    try {
      const theme = exportTheme();
      const headW = 150;
      const gap = 12;
      const colX = [];
      let x0 = headW;
      for (const w of colWidths) {
        colX.push(x0);
        x0 += w + gap;
      }
      const rowH = rows.map((r) => (L.transpose ? geomFor(r).PH : Math.max(...plots.map((p) => geomFor(p).PH))));
      const rowY = [];
      let y0 = TITLE + gap;
      for (const h of rowH) {
        rowY.push(y0);
        y0 += h + gap;
      }
      const W = x0;
      const H = y0;
      const layers = new Map();
      for (const p of plots) for (const smp of samples) layers.set(`${p.id}|${smp.id}`, await fetchPanelLayer(p, smp.id, styleFor(p), theme));
      const paintAll = (ctx) => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = theme.labelFg;
        ctx.font = `600 13px ${theme.fontUI}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(doc.name, 12, TITLE / 2 + 4);
        rows.forEach((r, ri) => {
          const y = rowY[ri];
          ctx.font = `600 11.5px ${theme.fontUI}`;
          ctx.fillStyle = theme.labelFg;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(L.transpose ? plotLabel(doc, r).slice(0, 26) : r.name.slice(0, 24), 12, y + rowH[ri] / 2);
          cols.forEach((c, ci) => {
            const p = L.transpose ? r : c;
            const smp = L.transpose ? c : r;
            const lr = layers.get(`${p.id}|${smp.id}`);
            drawPanel(ctx, { plot: p, sampleId: smp.id, layer: lr ? lr.layer : null, message: lr ? lr.message : null, theme, title: popName(doc, p.pop), subtitle: L.transpose ? smp.name : '', ox: colX[ci], oy: y, style: styleFor(p) });
          });
        });
      };
      const base = safeName(`${doc.name} layout`);
      if (format === 'svg') {
        const svg = new SvgContext(W, H);
        paintAll(svg);
        report(await saveFile(`${base}.svg`, svg.toString()), 'Layout exported as SVG');
      } else {
        const scale = 2;
        const c = makeCanvas(W * scale, H * scale);
        const ctx = c.getContext('2d');
        ctx.scale(scale, scale);
        paintAll(ctx);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        report(await saveFile(`${base}.png`, blob), 'Layout exported as PNG');
      }
    } catch (e) {
      toast(`Export failed: ${e.message}`, { kind: 'error' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div class="layout-view">
      <aside class="layout-side">
        <section class="card">
          <header class="card-head">
            <h2>Batch figure</h2>
          </header>
          <div class="eyebrow">Plots</div>
          {choices.length ? (
            <div class="check-list">
              {choices.map((p) => {
                const on = L.plotIds.includes(p.id);
                const own = Object.keys((L.plotStyles || {})[p.id] || {}).length > 0;
                return (
                  <div class="check-row plot-pick" key={p.id}>
                    <label class="grow">
                      <input type="checkbox" checked={on} onChange={() => pick(p)} />
                      <span>{plotLabel(doc, p)}</span>
                    </label>
                    {on ? (
                      <IconButton
                        icon="sliders"
                        size={13}
                        class="plot-style-btn"
                        active={own || (styling && styling.plotId === p.id)}
                        label={own ? 'This plot has its own size, text or elements: change them' : 'Size, text and elements for this plot'}
                        onClick={(e) => openStyle(p, e)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p class="muted small">Add plots in the Gating view first.</p>
          )}
          <button
            type="button"
            class="link-btn add-tree-btn"
            onClick={() => {
              const id = addPlot({ pop: ROOT, type: 'tree', statCols: TREE_STATS_DEFAULT }, { focus: false });
              setLayout({ plotIds: [...L.plotIds, id] });
            }}
          >
            <Icon name="plus" size={13} />
            <span>Add gating hierarchy</span>
          </button>
          {doc.plots.filter((p) => p.type === 'tree').map((p) => (
            <TreePlotCard plot={p} key={p.id} />
          ))}
          <div class="field-row">
            <span>Samples</span>
            <SampleSelect value={sampleSel} onChange={(v) => setLayout({ groupId: v.groupId || null, sampleIds: v.ids })} />
          </div>
          <div class="field-row">
            <span>Rows are</span>
            <Segmented value={L.transpose ? 'plots' : 'samples'} onChange={(v) => setLayout({ transpose: v === 'plots' })} options={[{ value: 'samples', label: 'Samples' }, { value: 'plots', label: 'Plots' }]} label="Rows are" />
          </div>
          <div class="eyebrow">Every panel</div>
          <PanelStyleFields plotId={null} />
          <p class="muted small">To give one plot its own size, text or elements, click it in the figure, or use the button next to it in the list above.</p>
          <div class="card-actions">
            <Button icon="download" variant="primary" disabled={exporting || !plots.length || !samples.length} onClick={() => exportGrid('png')}>
              {exporting ? 'Exporting…' : 'Export PNG'}
            </Button>
            <Button icon="download" disabled={exporting || !plots.length || !samples.length} onClick={() => exportGrid('svg')}>
              Export SVG
            </Button>
          </div>
        </section>
        <OverlayList />
      </aside>
      <section class="layout-main">
        {!plots.length || !samples.length ? (
          <Empty icon="grid" title="Choose plots for the figure">Tick plots on the left. Every chosen plot is drawn for every sample in the group, using the same gates.</Empty>
        ) : (
          <div class="batch layout-grid" style={{ gridTemplateColumns: `minmax(90px, 160px) ${colWidths.map((w) => `${w}px`).join(' ')}` }}>
            <div />
            {cols.map((c) => (
              <div class="batch-col" key={c.id}>
                {L.transpose ? c.name : plotLabel(doc, c)}
              </div>
            ))}
            {rows.map((r) => (
              <>
                <div class="batch-row" key={`h${r.id}`}>
                  {L.transpose ? plotLabel(doc, r) : r.name}
                </div>
                {cols.map((c) => {
                  const p = L.transpose ? r : c;
                  const smp = L.transpose ? c : r;
                  return (
                    <StaticPanel
                      key={`${p.id}|${smp.id}`}
                      plot={p}
                      sampleId={smp.id}
                      size={size}
                      title={popName(doc, p.pop)}
                      subtitle=""
                      style={styleFor(p)}
                      active={!!styling && styling.plotId === p.id}
                      onClick={(e) => openStyle(p, e)}
                    />
                  );
                })}
              </>
            ))}
          </div>
        )}
        <OverlayPanels />
      </section>
      {styling && plots.some((p) => p.id === styling.plotId) ? (
        <Popover anchor={styling.anchor} onClose={() => setStyling(null)} placement="right">
          <div class="panel-style-pop">
            <div class="panel-style-head">
              <b>{plotLabel(doc, doc.plots.find((p) => p.id === styling.plotId))}</b>
              <span class="muted small">This plot only, in every row of the figure</span>
            </div>
            <PanelStyleFields plotId={styling.plotId} />
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------- panel styles

const GATE_LABEL_OPTIONS = [
  { value: 'both', label: 'Name + value', title: 'Gate name and its number' },
  { value: 'name', label: 'Name', title: 'Gate name only' },
  { value: 'value', label: 'Value', title: 'The number only' },
  { value: 'none', label: 'None', title: 'No gate labels' },
];

/**
 * The size, text and element settings for panels: with `plotId` null, the
 * defaults for every panel in the figure; with a plot id, that plot's own
 * settings, which win over the defaults (each one it changes is marked and
 * can be put back).
 */
function PanelStyleFields({ plotId }) {
  const L = useSel((s) => s.doc.layout);
  const plot = useSel((s) => (plotId ? s.doc.plots.find((p) => p.id === plotId) : null));
  const own = plotId ? (L.plotStyles || {})[plotId] || {} : {};
  const st = plotId ? panelStyle(L, plotId) : layoutDefaults(L);
  const tree = plot && plot.type === 'tree';
  const set = (k, v) => {
    const cur = store.get().doc.layout;
    const opts = { coalesce: `panel:${plotId || '*'}:${k}` };
    if (plotId) {
      const mine = (cur.plotStyles || {})[plotId] || {};
      return setLayout({ plotStyles: { ...(cur.plotStyles || {}), [plotId]: { ...mine, [k]: v } } }, opts);
    }
    if (k === 'size') return setLayout({ size: v }, opts);
    if (k === 'title') return setLayout({ showTitles: v }, opts);
    if (k === 'axisTitles') return setLayout({ showAxisLabels: v }, opts);
    return setLayout({ panel: { ...(cur.panel || {}), [k]: v } }, opts);
  };
  const reset = (keys) => {
    if (!plotId) return;
    const cur = store.get().doc.layout;
    const next = { ...((cur.plotStyles || {})[plotId] || {}) };
    for (const k of keys) delete next[k];
    const all = { ...(cur.plotStyles || {}) };
    if (Object.keys(next).length) all[plotId] = next;
    else delete all[plotId];
    setLayout({ plotStyles: all });
  };
  const mark = (k) => (plotId && own[k] !== undefined ? (
    <button
      type="button"
      class="own-mark"
      title="Set for this plot only. Click to use the figure's setting."
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        reset([k]);
      }}
    >
      <Icon name="undo" size={11} />
    </button>
  ) : null);
  const check = (k, label, disabled = false) => (
    <div class={`check-row ${plotId && own[k] !== undefined ? 'is-own' : ''}`}>
      <label class="grow">
        <input type="checkbox" checked={!!st[k]} disabled={disabled} onChange={(e) => set(k, e.currentTarget.checked)} />
        <span>{label}</span>
      </label>
      {mark(k)}
    </div>
  );
  return (
    <div class="panel-style">
      <div class={`field-row ${own.size !== undefined ? 'is-own' : ''}`}>
        <span>Panel size</span>
        <span class="range-val">
          <input type="range" min="100" max="480" step="10" value={st.size} onInput={(e) => set('size', parseInt(e.currentTarget.value, 10))} aria-label="Panel size" />
          <span class="num muted">{st.size}</span>
          {mark('size')}
        </span>
      </div>
      <div class={`field-row ${own.font !== undefined ? 'is-own' : ''}`}>
        <span>Text size</span>
        <span class="range-val">
          <input type="range" min="0.6" max="2" step="0.05" value={st.font} onInput={(e) => set('font', parseFloat(e.currentTarget.value))} aria-label="Text size" />
          <span class="num muted">{Math.round(st.font * 100)}%</span>
          {mark('font')}
        </span>
      </div>
      <div class="panel-style-checks">
        {check('title', 'Plot title')}
        {tree ? null : check('axisTitles', 'Axis labels')}
        {tree ? null : check('tickLabels', 'Axis numbers')}
        {tree ? null : check('ticks', 'Tick marks')}
        {tree ? null : check('gates', 'Gates')}
      </div>
      {tree ? null : (
        <div class={`gate-labels-row ${own.gateLabels !== undefined ? 'is-own' : ''}`}>
          <span>Gate labels</span>
          <span class="range-val">
            <Segmented value={st.gates ? st.gateLabels : 'none'} onChange={(v) => set('gateLabels', v)} options={GATE_LABEL_OPTIONS} label="Gate labels" />
            {mark('gateLabels')}
          </span>
        </div>
      )}
      {plotId && Object.keys(own).length ? (
        <button type="button" class="link-btn panel-style-reset" onClick={() => reset(Object.keys(own))}>
          Use the figure's settings for this plot
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------- tree panels

/** Inline settings for one gating-hierarchy panel: which population it's rooted at and which stat columns to show. */
function TreePlotCard({ plot: p }) {
  const doc = useSel((s) => s.doc);
  const cols = p.statCols && p.statCols.length ? p.statCols : TREE_STATS_DEFAULT;
  const toggleCol = (key) => updatePlot(p.id, { statCols: cols.includes(key) ? cols.filter((k) => k !== key) : [...cols, key] });
  return (
    <div class="tree-plot-card">
      <label class="field-row">
        <span>Root population</span>
        <select class="field field-sm" value={p.pop} onChange={(e) => updatePlot(p.id, { pop: e.currentTarget.value })}>
          {popOptions(doc).map((o) => (
            <option value={o.id} key={o.id}>
              {' '.repeat(o.depth)}
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <div class="check-list short tree-stat-cols">
        {TREE_STATS.map((key) => (
          <label class="check-row" key={key}>
            <input type="checkbox" checked={cols.includes(key)} onChange={() => toggleCol(key)} />
            <span>{STATS[key].short}</span>
          </label>
        ))}
      </div>
      <button type="button" class="link-btn danger" onClick={() => removePlot(p.id)}>
        Delete this panel
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ overlays

function OverlayList() {
  const doc = useSel((s) => s.doc);
  const overlays = doc.layout.overlays || [];
  const add = () => {
    const ch = allChannels(doc).find((c) => c.kind === 'fluor') || allChannels(doc)[0];
    if (!ch) return;
    const L = doc.layout;
    const ids = resolveSamples(doc, store.get().meta, { groupId: L.groupId || null, ids: Array.isArray(L.sampleIds) ? L.sampleIds : null }).slice(0, 4).map((s) => s.id);
    setLayout({ overlays: [...overlays, { id: newId('o'), title: `${ch.label || ch.name} overlay`, channel: ch.name, pop: 'root', sampleIds: ids, mode: 'offset', normalize: 'mode' }] });
  };
  return (
    <section class="card">
      <header class="card-head">
        <h2>Histogram overlays</h2>
        <IconButton icon="plus" label="New overlay" onClick={add} />
      </header>
      {overlays.length ? <p class="muted small">Edit each overlay on the right.</p> : <p class="muted small">Compare one parameter across samples, for example stimulated against unstimulated.</p>}
    </section>
  );
}

function OverlayPanels() {
  const doc = useSel((s) => s.doc);
  const overlays = doc.layout.overlays || [];
  if (!overlays.length) return null;
  return (
    <div class="overlays">
      {overlays.map((o) => (
        <OverlayCard spec={o} key={o.id} />
      ))}
    </div>
  );
}

function updateOverlay(id, patch) {
  const doc = store.get().doc;
  setLayout({ overlays: (doc.layout.overlays || []).map((o) => (o.id === id ? { ...o, ...patch } : o)) });
}

function OverlayCard({ spec }) {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const theme = useTheme();
  const ref = useRef();
  const [series, setSeries] = useState([]);
  const state = store.get();
  const W = 460;
  const H = 260;
  const key = [spec.channel, spec.pop, spec.sampleIds.join(','), transformKey(doc.transforms[spec.channel]), spec.sampleIds.map((id) => ((meta[id] || {}).status === 'ready' ? popSig(state, id, spec.pop) + compKey(state, id) : 'x')).join(',')].join('|');
  useEffect(() => {
    let alive = true;
    fetchOverlay(spec, 256).then((s) => alive && setSeries(s));
    return () => {
      alive = false;
    };
  }, [key]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawOverlay(ctx, { spec, series, theme, W, H });
  }, [series, theme, spec.mode, spec.normalize]);
  const ch = channelInfo(doc, spec.channel);
  const exportIt = async (format) => {
    const t = exportTheme();
    const EW = W;
    const EH = H + 40;
    const paintAll = (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, EW, EH);
      ctx.fillStyle = t.labelFg;
      ctx.font = `600 12px ${t.fontUI}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${spec.title} · ${popName(doc, spec.pop)}`, 12, 14);
      if (ctx.isSvgRecorder) {
        const inner = new SvgContext(W, H);
        drawOverlay(inner, { spec, series, theme: t, W, H });
        ctx.group(inner.inner(), 0, 24);
      } else {
        ctx.save();
        ctx.translate(0, 24);
        drawOverlay(ctx, { spec, series, theme: t, W, H });
        ctx.restore();
      }
      ctx.fillStyle = t.labelFg;
      ctx.font = `500 11px ${t.fontUI}`;
      ctx.textAlign = 'center';
      ctx.fillText(ch.label ? `${ch.label} (${ch.name})` : ch.name, W / 2, EH - 10);
    };
    const base = safeName(`${spec.title}`);
    if (format === 'svg') {
      const svg = new SvgContext(EW, EH);
      paintAll(svg);
      report(await saveFile(`${base}.svg`, svg.toString()), 'Overlay exported');
    } else {
      const c = makeCanvas(EW * 2, EH * 2);
      const ctx = c.getContext('2d');
      ctx.scale(2, 2);
      paintAll(ctx);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      report(await saveFile(`${base}.png`, blob), 'Overlay exported');
    }
  };
  return (
    <section class="card overlay-card">
      <header class="card-head">
        <input class="title-input" value={spec.title} onChange={(e) => updateOverlay(spec.id, { title: e.currentTarget.value })} aria-label="Overlay title" />
        <div class="card-head-tools">
          <IconButton icon="download" label="Export overlay" onClick={(e) => openMenu(rectOf(e.currentTarget), [{ label: 'PNG image', onClick: () => exportIt('png') }, { label: 'SVG image', onClick: () => exportIt('svg') }])} />
          <IconButton icon="trash" label="Delete overlay" onClick={() => setLayout({ overlays: (doc.layout.overlays || []).filter((o) => o.id !== spec.id) })} />
        </div>
      </header>
      <div class="overlay-body">
        <canvas ref={ref} style={{ width: `${W}px`, height: `${H}px`, maxWidth: '100%' }} role="img" aria-label={`Overlay of ${ch.label || ch.name}`} />
        <div class="overlay-ctl">
          <label class="field-row">
            <span>Parameter</span>
            <select class="field field-sm" value={spec.channel} onChange={(e) => updateOverlay(spec.id, { channel: e.currentTarget.value })}>
              {allChannels(doc).map((c) => (
                <option value={c.name} key={c.name}>
                  {c.label ? `${c.label} · ${c.name}` : c.name}
                </option>
              ))}
            </select>
          </label>
          <label class="field-row">
            <span>Population</span>
            <select class="field field-sm" value={spec.pop} onChange={(e) => updateOverlay(spec.id, { pop: e.currentTarget.value })}>
              {popOptions(doc).map((p) => (
                <option value={p.id} key={p.id}>
                  {' '.repeat(p.depth)}
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div class="field-row">
            <span>Style</span>
            <Segmented value={spec.mode} onChange={(v) => updateOverlay(spec.id, { mode: v })} options={[{ value: 'offset', label: 'Offset' }, { value: 'overlay', label: 'Overlaid' }]} label="Overlay style" />
          </div>
          <div class="field-row">
            <span>Height</span>
            <Segmented value={spec.normalize} onChange={(v) => updateOverlay(spec.id, { normalize: v })} options={[{ value: 'mode', label: '% of max' }, { value: 'count', label: 'Count' }]} label="Normalise" />
          </div>
          <div class="eyebrow">Samples</div>
          <div class="check-list short">
            {doc.samples.map((smp) => {
              const idx = spec.sampleIds.indexOf(smp.id);
              return (
                <label class="check-row" key={smp.id}>
                  <input
                    type="checkbox"
                    checked={idx >= 0}
                    onChange={() => updateOverlay(spec.id, { sampleIds: idx >= 0 ? spec.sampleIds.filter((x) => x !== smp.id) : [...spec.sampleIds, smp.id] })}
                  />
                  {idx >= 0 ? <i class="swatch-dot" style={{ background: SERIES_COLORS[idx % SERIES_COLORS.length] }} /> : null}
                  <span>{smp.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
