// Gating view: tool bar, plot grid and the inspector.

import { useEffect } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { setUI, addPlot, updateSettings } from '../state/doc.js';
import { suggestAxes, allChannels } from '../state/derived.js';
import { ROOT } from '../../core/gates.js';
import { PlotCard } from '../plot/PlotCard.jsx';
import { BackgateStrip } from '../plot/Backgate.jsx';
import { Inspector } from './Inspector.jsx';
import { Icon, IconButton, openMenu, rectOf, Empty } from './ui.jsx';
import { chooseFiles } from './Sidebar.jsx';
import { openDemo } from '../state/loader.js';

export const TOOLS = [
  { id: 'select', label: 'Select and edit', key: 'V', icon: 'select' },
  { id: 'rect', label: 'Rectangle gate', key: 'R', icon: 'rect' },
  { id: 'polygon', label: 'Polygon gate', key: 'P', icon: 'polygon' },
  { id: 'ellipse', label: 'Ellipse gate', key: 'E', icon: 'ellipse' },
  { id: 'quad', label: 'Quadrant gate', key: 'Q', icon: 'quad' },
  { id: 'range', label: 'Range gate (histograms)', key: 'G', icon: 'range' },
  { id: 'split', label: 'Split gate (histograms)', key: 'S', icon: 'split' },
];

const HINTS = {
  select: 'Click a gate to select it. Drag to move, drag handles to reshape. Double-click to drill down; right-click for more.',
  rect: 'Drag on a plot to draw a rectangle. Drag past an axis to leave that side open.',
  polygon: 'Click to place corners. Double-click, press Enter or click the first corner to finish. Backspace removes the last corner.',
  ellipse: 'Drag on a plot to draw an ellipse. Use its handles to rotate and resize.',
  quad: 'Click on a plot to place the quadrant centre.',
  range: 'Drag across a histogram to gate a range.',
  split: 'Click on a histogram to split it into negative and positive.',
};

export function SampleNav() {
  const doc = useSel((s) => s.doc);
  const sampleId = useSel((s) => s.ui.sampleId);
  const meta = useSel((s) => s.meta);
  const list = doc.samples;
  const i = list.findIndex((x) => x.id === sampleId);
  const go = (d) => {
    if (!list.length) return;
    const j = (Math.max(0, i) + d + list.length) % list.length;
    setUI({ sampleId: list[j].id });
  };
  const cur = list[i];
  return (
    <div class="sample-nav" role="group" aria-label="Current sample">
      <IconButton icon="left" label="Previous sample ( [ )" onClick={() => go(-1)} disabled={list.length < 2} />
      <button
        type="button"
        class="sample-pick"
        disabled={!list.length}
        onClick={(e) =>
          openMenu(
            rectOf(e.currentTarget),
            list.map((x) => ({ label: x.name, checked: x.id === sampleId, disabled: (meta[x.id] || {}).status === 'missing', why: 'Data file not loaded', onClick: () => setUI({ sampleId: x.id }) })),
            { title: 'Show sample' },
          )
        }
      >
        <span class="sample-pick-name">{cur ? cur.name : 'No samples'}</span>
        {cur ? (
          <span class="sample-pick-pos num">
            {i + 1}/{list.length}
          </span>
        ) : null}
        <Icon name="down" size={12} />
      </button>
      <IconButton icon="right" label="Next sample ( ] )" onClick={() => go(1)} disabled={list.length < 2} />
    </div>
  );
}

function Toolbar() {
  const tool = useSel((s) => s.ui.tool);
  const scope = useSel((s) => s.ui.scope);
  const inspector = useSel((s) => s.ui.inspector);
  const plotSize = useSel((s) => s.doc.settings.plotSize || 290);
  const addNew = () => {
    const s = store.get();
    const doc = s.doc;
    const pop = s.ui.selectedGate && doc.gates[s.ui.selectedGate] ? s.ui.selectedGate : ROOT;
    let x;
    let y;
    if (pop === ROOT) {
      const ch = allChannels(doc);
      x = (ch.find((c) => /^fsc-a$/i.test(c.name)) || ch[0] || {}).name;
      y = (ch.find((c) => /^ssc-a$/i.test(c.name)) || ch[1] || {}).name || null;
    } else [x, y] = suggestAxes(doc, pop);
    if (!x) return;
    addPlot({ pop, x, y, type: y ? 'pseudo' : 'hist' });
  };
  return (
    <div class="toolbar" role="toolbar" aria-label="Gating tools">
      <SampleNav />
      <div class="tool-group" role="radiogroup" aria-label="Gate tools">
        {TOOLS.map((t) => (
          <button type="button" role="radio" aria-checked={tool === t.id ? 'true' : 'false'} class={`tool ${tool === t.id ? 'is-on' : ''}`} title={`${t.label} (${t.key})`} aria-label={t.label} onClick={() => setUI({ tool: t.id })} key={t.id}>
            <Icon name={t.icon} size={16} />
          </button>
        ))}
      </div>
      <div class="scope" role="radiogroup" aria-label="Gate edits apply to">
        <span class="scope-label">Edits apply to</span>
        <div class="seg seg-sm">
          <button type="button" role="radio" aria-checked={scope === 'all' ? 'true' : 'false'} class={scope === 'all' ? 'is-on' : ''} onClick={() => setUI({ scope: 'all' })}>
            All samples
          </button>
          <button type="button" role="radio" aria-checked={scope === 'sample' ? 'true' : 'false'} class={scope === 'sample' ? 'is-on scope-one' : ''} onClick={() => setUI({ scope: 'sample' })} title="Gate edits change only the sample on screen">
            This sample
          </button>
        </div>
      </div>
      <div class="toolbar-end">
        <label class="size-ctl" title="Plot size">
          <Icon name="grid" size={14} />
          <input type="range" min="200" max="460" step="10" value={plotSize} onInput={(e) => updateSettings({ plotSize: parseInt(e.currentTarget.value, 10) })} aria-label="Plot size" />
        </label>
        <button type="button" class="btn btn-default btn-sm" onClick={addNew} title="Add a plot of the selected population">
          <Icon name="plus" size={14} />
          <span>Plot</span>
        </button>
        <IconButton icon="sliders" label={inspector ? 'Hide inspector' : 'Show inspector'} active={inspector} onClick={() => setUI({ inspector: !inspector })} />
      </div>
    </div>
  );
}

export function GatingView() {
  const plots = useSel((s) => s.doc.plots);
  const sampleId = useSel((s) => s.ui.sampleId);
  const nSamples = useSel((s) => s.doc.samples.length);
  const tool = useSel((s) => s.ui.tool);
  const inspector = useSel((s) => s.ui.inspector);
  const plotSize = useSel((s) => s.doc.settings.plotSize || 290);
  return (
    <div class={`gating ${inspector ? 'with-inspector' : ''}`}>
      <div class="gating-main">
        <Toolbar />
        <p class="hint" aria-live="polite">
          <Icon name="help" size={13} />
          <span>{HINTS[tool]}</span>
        </p>
        {nSamples === 0 ? (
          <Empty
            icon="upload"
            title="Add data to start gating"
            action={
              <div class="empty-actions">
                <button type="button" class="btn btn-primary" onClick={chooseFiles}>
                  <Icon name="plus" />
                  <span>Add FCS files</span>
                </button>
                <button type="button" class="btn btn-default" onClick={() => openDemo()}>
                  <Icon name="flask" />
                  <span>Open the demo experiment</span>
                </button>
              </div>
            }
          >
            Drop FCS files onto this window. They are read on this computer and never uploaded.
          </Empty>
        ) : plots.length === 0 ? (
          <Empty icon="grid" title="No plots yet">Use “Plot” in the tool bar to add one.</Empty>
        ) : (
          <div class="plot-grid" style={{ '--plot-size': `${plotSize}px` }}>
            {plots.map((p, i) => (
              <PlotCard plot={p} sampleId={sampleId} index={i} total={plots.length} key={p.id} />
            ))}
          </div>
        )}
        {nSamples > 0 ? <BackgateStrip /> : null}
      </div>
      {inspector ? <Inspector /> : null}
    </div>
  );
}

export function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !typing && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        import('../state/doc.js').then((m) => (e.shiftKey ? m.redo() : m.undo()));
        return;
      }
      if (mod && !typing && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        import('../state/doc.js').then((m) => m.redo());
        return;
      }
      if (typing || mod || e.altKey) return;
      const s = store.get();
      if (s.ui.dialog || s.ui.menu) return;
      if (s.ui.view === 'gating') {
        const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
        if (t) {
          setUI({ tool: t.id });
          return;
        }
        if (e.key === 'Escape') {
          if (s.ui.tool !== 'select') setUI({ tool: 'select' });
          else setUI({ selectedGate: null });
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && s.ui.selectedGate) {
          e.preventDefault();
          import('../state/gating.js').then((m) => m.removeGate(s.ui.selectedGate));
          return;
        }
      }
      if (e.key === '[' || e.key === ']') {
        const list = s.doc.samples;
        if (list.length < 2) return;
        const i = list.findIndex((x) => x.id === s.ui.sampleId);
        const j = (Math.max(0, i) + (e.key === ']' ? 1 : -1) + list.length) % list.length;
        setUI({ sampleId: list[j].id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
