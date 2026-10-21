// Right panel: details of the selected gate, or sample info and display settings.

import { useEffect, useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { setUI, renameGate, patchGate, setGeometry, setQuadCenter, setSplitThreshold, clearOverride, applyOverrideToAll, makeOverride, hasOverride, effectiveGate, updateSettings } from '../state/doc.js';
import { frequency, popPath, channelInfo, compLabel, popSig } from '../state/derived.js';
import { request } from '../state/bridge.js';
import { drillDown, convertGate, removeGate, exportPopulation, gateMenuItems } from '../state/gating.js';
import { quadCenter, splitThreshold, canConvertToPolygon, GATE_COLORS } from '../../core/gate-geometry.js';
import { formatStat } from '../../core/stats.js';
import { formatValue } from '../../core/transforms.js';
import { booleanLabel } from '../../core/gates.js';
import { COLORMAPS, cssGradient } from '../plot/render.js';
import { Icon, IconButton, InlineEdit, NumberField, Segmented, openMenu, rectOf, Button } from './ui.jsx';

const TYPE_LABEL = { rect: 'Rectangle', polygon: 'Polygon', ellipse: 'Ellipse', range: 'Range', boolean: 'Boolean' };

export function Inspector() {
  const selected = useSel((s) => s.ui.selectedGate);
  const exists = useSel((s) => !!(s.ui.selectedGate && s.doc.gates[s.ui.selectedGate]));
  return (
    <aside class="inspector" aria-label="Inspector">
      {selected && exists ? <GateInspector id={selected} /> : <SampleInspector />}
    </aside>
  );
}

function GateInspector({ id }) {
  const doc = useSel((s) => s.doc);
  const sampleId = useSel((s) => s.ui.sampleId);
  const counts = useSel((s) => (s.counts[sampleId] || {}).counts || null);
  const g0 = doc.gates[id];
  const g = effectiveGate(doc, sampleId, id) || g0;
  const own = hasOverride(doc, sampleId, id);
  const smp = doc.samples.find((x) => x.id === sampleId);
  const n = counts ? counts[id] : undefined;
  const isQuad = g.link && g.link.kind === 'quad';
  const isSplit = g.link && g.link.kind === 'split';
  const xi = g.x ? channelInfo(doc, g.x) : null;
  const yi = g.y ? channelInfo(doc, g.y) : null;
  const ctx = () => ({ sampleId, scope: store.get().ui.scope });

  // medians of the gate's own parameters for this population
  const [med, setMed] = useState(null);
  const sig = sampleId ? popSig(store.get(), sampleId, id) : '';
  useEffect(() => {
    setMed(null);
    if (!sampleId || !g.x || (store.get().meta[sampleId] || {}).status !== 'ready') return;
    const reqs = [{ pop: id, channel: g.x, stat: 'median' }];
    if (g.y) reqs.push({ pop: id, channel: g.y, stat: 'median' });
    let alive = true;
    request(sampleId, 'stats', { reqs }).then((v) => alive && setMed(v), () => {});
    return () => {
      alive = false;
    };
  }, [sig, sampleId, g.x, g.y]);

  const kind = (isQuad ? 'Quadrant' : isSplit ? 'Split' : TYPE_LABEL[g.type]) + (g0.scale ? ' (own scale)' : '');
  const dims = g.type === 'boolean' ? booleanLabel(g, doc.gates) : `${xi ? xi.label || xi.name : ''}${yi ? ` × ${yi.label || yi.name}` : ''}`;

  return (
    <div class="insp">
      <div class="insp-head">
        <button
          type="button"
          class="swatch big"
          style={{ background: g0.color }}
          aria-label="Change colour"
          onClick={(e) => openMenu(rectOf(e.currentTarget), [{ swatches: GATE_COLORS, value: g0.color, onPick: (c) => patchGate(id, { color: c }) }], { title: 'Colour' })}
        />
        <div class="insp-title">
          <InlineEdit value={g0.name} onCommit={(v) => renameGate(id, v)} class="insp-name" />
          <div class="insp-kind">
            {kind} · {dims}
          </div>
        </div>
        <IconButton icon="more" label="Gate actions" onClick={(e) => openMenu(rectOf(e.currentTarget), gateMenuItems(id), { title: g0.name })} />
      </div>
      <div class="insp-path" title={popPath(doc, id)}>
        {popPath(doc, id, ' › ')}
      </div>

      <div class="stat-grid">
        <div>
          <span class="eyebrow">Events</span>
          <b class="num">{n === undefined ? '–' : formatStat('count', n)}</b>
        </div>
        <div>
          <span class="eyebrow">% of parent</span>
          <b class="num">{fmtPct(frequency(doc, counts, id, 'freqParent'))}</b>
        </div>
        <div>
          <span class="eyebrow">% of total</span>
          <b class="num">{fmtPct(frequency(doc, counts, id, 'freqTotal'))}</b>
        </div>
        {xi && med ? (
          <div>
            <span class="eyebrow">Median {xi.label || xi.name}</span>
            <b class="num">{formatStat('median', med[0])}</b>
          </div>
        ) : null}
        {yi && med && med.length > 1 ? (
          <div>
            <span class="eyebrow">Median {yi.label || yi.name}</span>
            <b class="num">{formatStat('median', med[1])}</b>
          </div>
        ) : null}
      </div>

      {g0.scale ? (
        <p class="note-warn">
          <Icon name="help" size={13} /> This imported gate keeps the scale it was defined on, so its edges can look curved here. Use “Evaluate on the plot’s current scale” in its menu to straighten them.
        </p>
      ) : null}
      {g.type !== 'boolean' ? (
        <div class={`scope-card ${own ? 'is-own' : ''}`}>
          <Icon name={own ? 'sliders' : 'link'} size={15} />
          <div>
            <b>{own ? `Adjusted for ${smp ? smp.name : 'this sample'}` : 'Shared by all samples'}</b>
            <p>{own ? 'Edits here change only this sample.' : 'Edits change this gate in every sample unless “This sample” is chosen above the plots.'}</p>
            <div class="scope-actions">
              {own ? (
                <>
                  <Button size="sm" onClick={() => clearOverride(id, sampleId)}>Use shared gate</Button>
                  <Button size="sm" onClick={() => applyOverrideToAll(id, sampleId)}>Apply to all samples</Button>
                </>
              ) : (
                <Button size="sm" disabled={!sampleId} onClick={() => makeOverride(id, sampleId)}>Adjust for this sample only</Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <Geometry g={g} xi={xi} yi={yi} isQuad={isQuad} isSplit={isSplit} ctx={ctx} />

      <div class="insp-actions">
        <Button icon="drill" onClick={() => drillDown(id)}>Drill down</Button>
        {canConvertToPolygon(g0) ? <Button icon="convert" onClick={() => convertGate(id)}>Convert to polygon</Button> : null}
        <Button icon="download" disabled={!sampleId} onClick={() => exportPopulation(sampleId, id, 'fcs')}>Export FCS</Button>
        <Button icon="download" disabled={!sampleId} onClick={() => exportPopulation(sampleId, id, 'csv')}>Export CSV</Button>
        <Button icon="trash" variant="danger" onClick={() => removeGate(id)}>Delete</Button>
      </div>
    </div>
  );
}

function fmtPct(v) {
  return Number.isFinite(v) ? `${formatStat('freqParent', v)}%` : '–';
}

function Bound({ label, value, onCommit }) {
  return (
    <label class="bound">
      <span>{label}</span>
      <NumberField value={value} allowEmpty placeholder="open" onCommit={onCommit} format={(v) => (Math.abs(v) >= 100 ? Math.round(v) : Number(v.toPrecision(4)))} />
    </label>
  );
}

function Geometry({ g, xi, yi, isQuad, isSplit, ctx }) {
  if (g.type === 'boolean') return null;
  const nm = (c) => (c ? c.label || c.name : '');
  if (isQuad) {
    const [cx, cy] = quadCenter(g);
    return (
      <div class="geom">
        <div class="eyebrow">Quadrant centre</div>
        <div class="geom-grid">
          <Bound label={nm(xi)} value={cx} onCommit={(v) => v !== null && setQuadCenter(g.link.group, [v, cy], ctx())} />
          <Bound label={nm(yi)} value={cy} onCommit={(v) => v !== null && setQuadCenter(g.link.group, [cx, v], ctx())} />
        </div>
      </div>
    );
  }
  if (isSplit) {
    const t = splitThreshold(g);
    return (
      <div class="geom">
        <div class="eyebrow">Split at</div>
        <div class="geom-grid">
          <Bound label={nm(xi)} value={t} onCommit={(v) => v !== null && setSplitThreshold(g.link.group, v, ctx())} />
        </div>
      </div>
    );
  }
  if (g.type === 'rect') {
    const r = g.rect || {};
    const set = (k) => (v) => setGeometry(g.id, { rect: { ...r, [k]: v } }, ctx());
    return (
      <div class="geom">
        <div class="eyebrow">Bounds (leave empty for an open side)</div>
        <div class="geom-grid">
          <Bound label={`${nm(xi)} from`} value={r.x0} onCommit={set('x0')} />
          <Bound label="to" value={r.x1} onCommit={set('x1')} />
          <Bound label={`${nm(yi)} from`} value={r.y0} onCommit={set('y0')} />
          <Bound label="to" value={r.y1} onCommit={set('y1')} />
        </div>
      </div>
    );
  }
  if (g.type === 'range') {
    const r = g.range || {};
    const set = (k) => (v) => setGeometry(g.id, { range: { ...r, [k]: v } }, ctx());
    return (
      <div class="geom">
        <div class="eyebrow">Range (leave empty for an open side)</div>
        <div class="geom-grid">
          <Bound label={`${nm(xi)} from`} value={r.lo} onCommit={set('lo')} />
          <Bound label="to" value={r.hi} onCommit={set('hi')} />
        </div>
      </div>
    );
  }
  if (g.type === 'ellipse') {
    const e = g.ellipse;
    return (
      <div class="geom">
        <div class="eyebrow">Ellipse centre</div>
        <p class="geom-read num">
          {nm(xi)} {formatValue(e.c[0])} · {nm(yi)} {formatValue(e.c[1])}
        </p>
      </div>
    );
  }
  if (g.type === 'polygon') {
    return (
      <div class="geom">
        <div class="eyebrow">Polygon</div>
        <p class="geom-read">{g.polygon.length} corners. Drag a corner on the plot to move it.</p>
      </div>
    );
  }
  return null;
}

function SampleInspector() {
  const doc = useSel((s) => s.doc);
  const sampleId = useSel((s) => s.ui.sampleId);
  const meta = useSel((s) => s.meta[s.ui.sampleId] || null);
  const comp = useSel((s) => (s.ui.sampleId ? compLabel(s, s.ui.sampleId) : ''));
  const smp = doc.samples.find((x) => x.id === sampleId);
  const st = doc.settings;
  const kw = (meta && meta.summary) || {};
  return (
    <div class="insp">
      <div class="insp-section">
        <div class="eyebrow">Sample</div>
        {smp ? (
          <>
            <h3 class="insp-sample">{smp.name}</h3>
            <dl class="kv">
              <dt>Events</dt>
              <dd class="num">{formatStat('count', smp.nEvents)}</dd>
              <dt>Parameters</dt>
              <dd class="num">{(smp.channels || []).length}</dd>
              {meta && meta.version ? (
                <>
                  <dt>Format</dt>
                  <dd>{meta.version}</dd>
                </>
              ) : null}
              {kw.$CYT ? (
                <>
                  <dt>Cytometer</dt>
                  <dd>{kw.$CYT}</dd>
                </>
              ) : null}
              {kw.$DATE ? (
                <>
                  <dt>Acquired</dt>
                  <dd>
                    {kw.$DATE}
                    {kw.$BTIM ? ` ${kw.$BTIM}` : ''}
                  </dd>
                </>
              ) : null}
              <dt>Compensation</dt>
              <dd>
                <button type="button" class="link-btn" onClick={() => setUI({ view: 'comp' })}>
                  {comp}
                </button>
              </dd>
            </dl>
            {meta && meta.compError ? (
              <p class="note-warn">
                <Icon name="warn" size={13} /> Compensation could not be applied: {meta.compError}
              </p>
            ) : null}
            {meta && meta.compMissing && meta.compMissing.length ? (
              <p class="note-warn">
                <Icon name="warn" size={13} /> The compensation matrix lists {meta.compMissing.join(', ')}, which {meta.compMissing.length > 1 ? 'are' : 'is'} not in this file; those rows were skipped.
              </p>
            ) : null}
            {meta && meta.warnings && meta.warnings.length ? (
              <ul class="note-list">
                {meta.warnings.slice(0, 4).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p class="muted">No sample selected.</p>
        )}
      </div>
      <div class="insp-section">
        <div class="eyebrow">Display</div>
        <div class="setting">
          <span>Density colours</span>
          <div class="cmap-list" role="radiogroup" aria-label="Density colours">
            {Object.entries(COLORMAPS).map(([k, v]) => (
              <button type="button" role="radio" aria-checked={st.colormap === k ? 'true' : 'false'} class={`cmap ${st.colormap === k ? 'is-on' : ''}`} onClick={() => updateSettings({ colormap: k })} title={v.label} key={k}>
                <i style={{ background: cssGradient(k) }} />
                <span>{v.label}</span>
              </button>
            ))}
          </div>
        </div>
        <label class="setting row">
          <span>Smoothing</span>
          <input type="range" min="0" max="3" step="0.1" value={st.smooth ?? 1} onInput={(e) => updateSettings({ smooth: parseFloat(e.currentTarget.value) })} />
        </label>
        <div class="setting row">
          <span>Dot size</span>
          <NumberField
            class="field-sm dotsize-field"
            value={st.dotSize || 1}
            step="1"
            onCommit={(v) => updateSettings({ dotSize: Math.max(1, Math.min(20, Math.round(v))) })}
            aria-label="Default dot size in pixels"
          />
        </div>
        <p class="muted small">Applies to plots with no dot size of their own. Set one on a plot from its options menu to override it there.</p>
        <div class="setting row">
          <span>Gate labels show</span>
          <Segmented
            size="sm"
            label="Gate labels show"
            value={st.labelStat || 'freqParent'}
            onChange={(v) => updateSettings({ labelStat: v })}
            options={[{ value: 'freqParent', label: '% parent' }, { value: 'freqTotal', label: '% total' }, { value: 'count', label: 'Count' }]}
          />
        </div>
        <label class="setting row check">
          <input type="checkbox" checked={st.showLabels !== false} onChange={(e) => updateSettings({ showLabels: e.currentTarget.checked })} />
          <span>Show gate labels</span>
        </label>
        <label class="setting row check">
          <input type="checkbox" checked={!!st.histSmooth} onChange={(e) => updateSettings({ histSmooth: e.currentTarget.checked })} />
          <span>Smooth histograms</span>
        </label>
      </div>
      <div class="insp-section tip">
        <Icon name="help" size={14} />
        <p>Click a gate to see its numbers here. Double-click a gate to open a plot of that population; right-click it for more, including converting it to a polygon.</p>
      </div>
    </div>
  );
}
