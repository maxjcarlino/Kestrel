// Picker for which samples to pool (concatenate) into one plot: a persistent
// checklist, unlike the regular menu which closes on every click.

import { useSel } from '../state/store.js';
import { updatePlot } from '../state/doc.js';
import { Popover } from '../components/ui.jsx';

export function ConcatMenu({ anchor, plot, onClose }) {
  const doc = useSel((s) => s.doc);
  const ids = plot.concatIds || [];
  const toggle = (id) => updatePlot(plot.id, { concatIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] });
  return (
    <Popover anchor={anchor} onClose={onClose} class="concat-menu" width={260}>
      <div class="concat-head">
        <span class="eyebrow">Concatenate samples</span>
        <p class="muted small">Pool events from several samples into this one plot. Gates still follow the current sample.</p>
      </div>
      <div class="concat-actions">
        <button type="button" class="link-btn" onClick={() => updatePlot(plot.id, { concatIds: doc.samples.map((s) => s.id) })}>
          Select all
        </button>
        <button type="button" class="link-btn" disabled={!ids.length} onClick={() => updatePlot(plot.id, { concatIds: [] })}>
          Clear
        </button>
      </div>
      {doc.samples.length ? (
        <div class="check-list short">
          {doc.samples.map((s) => (
            <label class="check-row" key={s.id}>
              <input type="checkbox" checked={ids.includes(s.id)} onChange={() => toggle(s.id)} />
              <span>{s.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <p class="muted small">No samples in this workspace yet.</p>
      )}
    </Popover>
  );
}
