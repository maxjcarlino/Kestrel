// Batch: every gating plot for every sample, with its gates and frequencies,
// so the whole gating strategy can be checked across the experiment at once.

import { useSel } from '../state/store.js';
import { setUI, samplesInGroup } from '../state/doc.js';
import { popName, channelInfo } from '../state/derived.js';
import { StaticPanel } from './LayoutView.jsx';
import { Empty, Icon } from './ui.jsx';

function axesLabel(doc, p) {
  const x = channelInfo(doc, p.x);
  const y = p.y && p.type !== 'hist' ? channelInfo(doc, p.y) : null;
  return `${x.label || x.name}${y ? ` × ${y.label || y.name}` : ''}`;
}

export function BatchView() {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const groupId = useSel((s) => (s.ui.batchGroup === undefined ? (doc.groups.find((g) => /^samples$/i.test(g.name)) || {}).id || '' : s.ui.batchGroup));
  const size = useSel((s) => s.ui.batchSize || 190);
  const samples = samplesInGroup(doc, groupId || null);
  const ready = samples.filter((x) => (meta[x.id] || {}).status === 'ready');
  const plots = doc.plots;
  const open = (sampleId, plotId) => setUI({ view: 'gating', sampleId, focusPlot: plotId, flashPlot: plotId });

  return (
    <div class="batch-view">
      <div class="batch-bar">
        <h2>Batch</h2>
        <span class="muted small">
          {plots.length} plot{plots.length === 1 ? '' : 's'} × {ready.length} sample{ready.length === 1 ? '' : 's'}. Gates and frequencies are those of each sample. Click a plot to open it.
        </span>
        <div class="batch-ctl">
          <label class="field-inline">
            <span>Samples</span>
            <select class="field field-sm" value={groupId || ''} onChange={(e) => setUI({ batchGroup: e.currentTarget.value })}>
              <option value="">All samples</option>
              {doc.groups.map((g) => (
                <option value={g.id} key={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label class="size-ctl" title="Panel size">
            <Icon name="grid" size={14} />
            <input type="range" min="140" max="320" step="10" value={size} onInput={(e) => setUI({ batchSize: parseInt(e.currentTarget.value, 10) })} aria-label="Panel size" />
          </label>
        </div>
      </div>
      {!plots.length || !ready.length ? (
        <Empty icon="layers" title={plots.length ? 'No loaded samples in this group' : 'No plots yet'}>
          {plots.length ? 'Choose another group, or add data files.' : 'Draw plots and gates in the Gating view; they appear here for every sample.'}
        </Empty>
      ) : (
        <div class="batch-scroll">
          <div class="batch batch-all" style={{ gridTemplateColumns: `minmax(100px, 150px) repeat(${plots.length}, ${size}px)` }}>
            <div class="batch-corner" />
            {plots.map((p) => (
              <div class="batch-col" key={p.id}>
                <b>{popName(doc, p.pop)}</b>
                <span>{axesLabel(doc, p)}</span>
              </div>
            ))}
            {ready.map((smp) => (
              <>
                <div class="batch-row" key={`h${smp.id}`}>
                  {smp.name}
                </div>
                {plots.map((p) => (
                  <button type="button" class="batch-cell" onClick={() => open(smp.id, p.id)} title={`Open ${popName(doc, p.pop)} for ${smp.name}`} key={`${p.id}|${smp.id}`}>
                    <StaticPanel plot={p} sampleId={smp.id} size={size} title="" subtitle="" />
                  </button>
                ))}
              </>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
