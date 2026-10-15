// Layout: batch figures (plots × samples) and histogram overlays, exportable.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { setLayout, samplesInGroup, toast } from '../state/doc.js';
import { popName, popSig, compKey, channelInfo, allChannels } from '../state/derived.js';
import { transformKey } from '../../core/transforms.js';
import { newId } from '../../core/gate-geometry.js';
import { fetchLayer, drawPanel, SvgContext, fetchOverlay, drawOverlay, SERIES_COLORS } from '../plot/export.js';
import { makeCanvas } from '../plot/paint.js';
import { useTheme, exportTheme } from '../theme.js';
import { IconButton, Button, Segmented, Empty, openMenu, rectOf } from './ui.jsx';
import { popOptions } from '../plot/PlotCard.jsx';
import { saveFile, safeName } from '../util/download.js';
import { report } from '../state/gating.js';

const TITLE = 22;

function plotLabel(doc, p) {
  const x = channelInfo(doc, p.x);
  const y = p.y ? channelInfo(doc, p.y) : null;
  return `${popName(doc, p.pop)} · ${x.label || x.name}${y && p.type !== 'hist' ? ` × ${y.label || y.name}` : ''}`;
}

export function StaticPanel({ plot, sampleId, size, title, subtitle }) {
  const ref = useRef();
  const doc = useSel((s) => s.doc);
  const status = useSel((s) => (s.meta[sampleId] || {}).status);
  const counts = useSel((s) => (s.counts[sampleId] || {}).counts);
  const theme = useTheme();
  const state = store.get();
  const PW = size;
  const PH = size + 40;
  const key = status === 'ready'
    ? [sampleId, plot.pop, plot.x, plot.y, plot.type, plot.overlay, size, popSig(state, sampleId, plot.pop), transformKey(doc.transforms[plot.x]), plot.y ? transformKey(doc.transforms[plot.y]) : '', compKey(state, sampleId), doc.settings.colormap, doc.settings.dotSize].join('|')
    : null;
  const [layer, setLayer] = useState(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetchLayer(plot, sampleId, PW - 18, PH - 22 - 20, theme).then((r) => alive && setLayer(r), () => {});
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
    drawPanel(ctx, { plot, sampleId, layer: layer.layer, message: status === 'ready' ? layer.message : 'Not loaded', theme, title, subtitle, ox: 0, oy: 0, PW, PH });
  }, [layer, doc.gates, doc.overrides, doc.settings, counts, theme, title, subtitle]);
  return <canvas ref={ref} class="static-panel" style={{ width: `${PW}px`, height: `${PH}px` }} role="img" aria-label={`${title}${subtitle ? `, ${subtitle}` : ''}`} />;
}

export function LayoutView() {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const L = doc.layout;
  const plots = L.plotIds.map((id) => doc.plots.find((p) => p.id === id)).filter(Boolean);
  const samples = samplesInGroup(doc, L.groupId).filter((x) => (meta[x.id] || {}).status === 'ready');
  const size = L.size || 220;
  const [exporting, setExporting] = useState(false);
  const togglePlot = (id) => setLayout({ plotIds: L.plotIds.includes(id) ? L.plotIds.filter((x) => x !== id) : [...L.plotIds, id] });
  const rows = L.transpose ? plots : samples;
  const cols = L.transpose ? samples : plots;

  const exportGrid = async (format) => {
    if (!plots.length || !samples.length) return;
    setExporting(true);
    try {
      const theme = exportTheme();
      const PW = size;
      const PH = size + 40;
      const headW = 150;
      const W = headW + cols.length * (PW + 12) + 12;
      const H = TITLE + 12 + rows.length * (PH + 12);
      const layers = new Map();
      for (const p of plots) for (const smp of samples) layers.set(`${p.id}|${smp.id}`, await fetchLayer(p, smp.id, PW - 18, PH - 22 - 20, theme));
      const paintAll = (ctx) => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = theme.labelFg;
        ctx.font = `600 13px ${theme.fontUI}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(doc.name, 12, TITLE / 2 + 4);
        rows.forEach((r, ri) => {
          const y = TITLE + 12 + ri * (PH + 12);
          ctx.font = `600 11.5px ${theme.fontUI}`;
          ctx.fillStyle = theme.labelFg;
          ctx.textAlign = 'left';
          ctx.fillText(L.transpose ? plotLabel(doc, r).slice(0, 26) : r.name.slice(0, 24), 12, y + PH / 2);
          cols.forEach((c, ci) => {
            const p = L.transpose ? r : c;
            const smp = L.transpose ? c : r;
            const x = headW + ci * (PW + 12);
            const lr = layers.get(`${p.id}|${smp.id}`);
            drawPanel(ctx, { plot: p, sampleId: smp.id, layer: lr ? lr.layer : null, message: lr ? lr.message : null, theme, title: popName(doc, p.pop), subtitle: L.transpose ? smp.name : '', ox: x, oy: y, PW, PH });
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
          {doc.plots.length ? (
            <div class="check-list">
              {doc.plots.map((p) => (
                <label class="check-row" key={p.id}>
                  <input type="checkbox" checked={L.plotIds.includes(p.id)} onChange={() => togglePlot(p.id)} />
                  <span>{plotLabel(doc, p)}</span>
                </label>
              ))}
            </div>
          ) : (
            <p class="muted small">Add plots in the Gating view first.</p>
          )}
          <label class="field-row">
            <span>Samples</span>
            <select class="field" value={L.groupId || ''} onChange={(e) => setLayout({ groupId: e.currentTarget.value || null })}>
              <option value="">All samples</option>
              {doc.groups.map((g) => (
                <option value={g.id} key={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <div class="field-row">
            <span>Rows are</span>
            <Segmented value={L.transpose ? 'plots' : 'samples'} onChange={(v) => setLayout({ transpose: v === 'plots' })} options={[{ value: 'samples', label: 'Samples' }, { value: 'plots', label: 'Plots' }]} label="Rows are" />
          </div>
          <label class="field-row">
            <span>Panel size</span>
            <input type="range" min="160" max="360" step="10" value={size} onInput={(e) => setLayout({ size: parseInt(e.currentTarget.value, 10) })} />
          </label>
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
          <div class="batch" style={{ gridTemplateColumns: `minmax(90px, 160px) repeat(${cols.length}, ${size}px)` }}>
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
                  return <StaticPanel key={`${p.id}|${smp.id}`} plot={p} sampleId={smp.id} size={size} title={popName(doc, p.pop)} subtitle={L.transpose ? '' : ''} />;
                })}
              </>
            ))}
          </div>
        )}
        <OverlayPanels />
      </section>
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
    const ids = samplesInGroup(doc, doc.layout.groupId).slice(0, 4).map((s) => s.id);
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
