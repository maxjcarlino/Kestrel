// Backgating strip: the gating path of the selected population, one small plot
// per step from the ungated FSC-A × SSC-A plot down to the selected gate. Each
// panel shows the parent population with the gate drawn and its frequency.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { setUI } from '../state/doc.js';
import { popName, popSig, compKey, allChannels, sampleHasChannel } from '../state/derived.js';
import { ROOT, ancestors } from '../../core/gates.js';
import { transformKey } from '../../core/transforms.js';
import { fetchLayer, drawPanel } from './export.js';
import { useTheme } from '../theme.js';
import { Icon } from '../components/ui.jsx';


/** Steps of the gating path for a population: [{plot, gate}], starting ungated. */
export function gatingPath(doc, sel) {
  const steps = [];
  const g = sel && doc.gates[sel];
  if (g) {
    for (const a of [...ancestors(doc.gates, sel), g]) {
      if (!a || a.type === 'boolean' || !a.x) continue;
      const twoD = !!a.y && a.type !== 'range';
      const members = a.link ? Object.values(doc.gates).filter((m) => m.link && m.link.group === a.link.group) : [a];
      steps.push({ plot: { id: `bg-${a.id}`, pop: a.parent || ROOT, x: a.x, y: twoD ? a.y : null, type: twoD ? 'pseudo' : 'hist', overlay: 'none' }, gate: a, gates: members });
    }
  }
  const chans = allChannels(doc).map((c) => c.name);
  const fsc = chans.find((n) => /^fsc-a$/i.test(n)) || chans.find((n) => /^fsc/i.test(n));
  const ssc = chans.find((n) => /^ssc-a$/i.test(n)) || chans.find((n) => /^ssc/i.test(n));
  const first = steps[0];
  const startsUngated = first && first.plot.pop === ROOT && first.plot.x === fsc && first.plot.y === ssc;
  if (fsc && ssc && !startsUngated) steps.unshift({ plot: { id: 'bg-root', pop: ROOT, x: fsc, y: ssc, type: 'pseudo', overlay: 'none' }, gate: null, gates: [] });
  return steps;
}

function Step({ step, sampleId, theme, last, PW }) {
  const PH = Math.round(PW * 0.92);
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta[sampleId]);
  const counts = useSel((s) => (s.counts[sampleId] || {}).counts);
  const ref = useRef();
  const { plot, gate } = step;
  const state = store.get();
  const chans = meta && meta.channels ? meta.channels.map((c) => c.name) : [];
  const ok = meta && meta.status === 'ready' && [plot.x, plot.y].every((c) => !c || sampleHasChannel(doc, chans, c));
  const key = ok
    ? [sampleId, plot.pop, plot.x, plot.y || '-', popSig(state, sampleId, plot.pop), transformKey(doc.transforms[plot.x]), plot.y ? transformKey(doc.transforms[plot.y]) : '', compKey(state, sampleId), doc.settings.colormap].join('|')
    : null;
  const [layer, setLayer] = useState(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetchLayer(plot, sampleId, PW - 18, PH - 22 - 20, theme).then((r) => alive && setLayer(r), () => {});
    return () => {
      alive = false;
    };
  }, [key, theme, PW]);
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
    drawPanel(ctx, { plot, sampleId, layer: layer.layer, message: ok ? layer.message : 'Not available', theme, title: ' ', subtitle: '', ox: 0, oy: 0, PW, PH, gates: step.gates, selected: last && gate ? gate.id : null });
  }, [layer, doc.gates, doc.overrides, doc.settings, counts, theme, last, PW]);
  const onClick = () => {
    if (gate) setUI({ selectedGate: gate.id });
    const shown = store.get().doc.plots.find((p) => p.pop === plot.pop && p.x === plot.x && (p.y || null) === plot.y);
    if (shown) setUI({ focusPlot: shown.id, flashPlot: shown.id });
  };
  return (
    <button type="button" class={`bg-item ${last ? 'is-current' : ''}`} onClick={onClick} title={gate ? `Select ${gate.name}` : 'Ungated events'}>
      <canvas ref={ref} style={{ width: `${PW}px`, height: `${PH}px` }} aria-hidden="true" />
      <span class="bg-cap">
        {gate ? (
          <>
            <span class="bg-from">{popName(doc, plot.pop)}</span>
            <span class="bg-arrow">→</span>
            <b class="bg-to" style={{ '--gc': gate.color }}>
              {gate.name}
            </b>
          </>
        ) : (
          <b>All events (ungated)</b>
        )}
      </span>
    </button>
  );
}

export function BackgateStrip() {
  const doc = useSel((s) => s.doc);
  const sampleId = useSel((s) => s.ui.sampleId);
  const sel = useSel((s) => s.ui.selectedGate);
  const open = useSel((s) => s.ui.backgate !== false);
  const theme = useTheme();
  const rowRef = useRef();
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [open, !!sampleId]);
  useEffect(() => {
    const el = rowRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [sel, open]);
  const g = sel && doc.gates[sel];
  if (!sampleId) return null;
  const steps = gatingPath(doc, g ? sel : null);
  // fit the whole path when possible: 10 px gaps, 10 px of card padding and border each
  const PW = Math.max(178, Math.min(226, Math.floor((width - (steps.length - 1) * 10) / steps.length) - 10));
  if (!steps.length) return null;
  return (
    <section class={`backgate ${open ? '' : 'is-closed'}`} aria-label="Gating path">
      <header class="bg-head">
        <button type="button" class="bg-toggle" onClick={() => setUI({ backgate: !open })} aria-expanded={open ? 'true' : 'false'}>
          <Icon name={open ? 'down' : 'up'} size={12} />
          <span class="eyebrow">Gating path</span>
        </button>
        {g ? (
          <span class="bg-sel">
            <i style={{ background: g.color }} />
            {g.name}
            <span class="muted">from ungated events, step by step</span>
          </span>
        ) : (
          <span class="muted small">Select a population to see every gate that leads to it.</span>
        )}
      </header>
      {open ? (
        <div class="bg-row" ref={rowRef}>
          {steps.map((st, i) => (
            <Step step={st} sampleId={sampleId} theme={theme} last={i === steps.length - 1 && !!st.gate} PW={PW} key={st.plot.id} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
