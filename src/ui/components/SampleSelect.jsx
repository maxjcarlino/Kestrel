// Choosing the samples (and their order) for a Batch grid or Layout figure:
// every sample, one group, or a hand-picked list that can be put in any order
// (drag, the arrows, or a one-click sort by name, group, events or keyword).

import { useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { resolveSamples, selectionLabel, orderNote, moveId } from '../state/sample-select.js';
import { sortSamples, sortableKeywords } from '../state/sample-sort.js';
import { samplesInGroup } from '../state/doc.js';
import { Icon, IconButton, Popover, openMenu, rectOf } from './ui.jsx';

/**
 * A button showing the current selection; it opens the chooser.
 * @param {{groupId, ids}} value
 * @param {(sel) => void} onChange
 */
export function SampleSelect({ value, onChange, class: cls = '' }) {
  const doc = useSel((s) => s.doc);
  const [anchor, setAnchor] = useState(null);
  return (
    <>
      <button type="button" class={`field sample-select-btn ${cls}`} onClick={(e) => setAnchor(anchor ? null : rectOf(e.currentTarget))} aria-haspopup="dialog" aria-expanded={!!anchor}>
        <span>{selectionLabel(doc, value)}</span>
        <Icon name="down" size={12} />
      </button>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom">
          <SampleChooser value={value} onChange={onChange} />
        </Popover>
      ) : null}
    </>
  );
}

function SampleChooser({ value, onChange }) {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const custom = Array.isArray(value.ids);
  const shown = resolveSamples(doc, meta, value);
  const ids = shown.map((s) => s.id);

  // read the latest selection: several quick clicks can land before a re-render
  const latestIds = () => (Array.isArray(value.ids) ? value.ids.filter((id) => store.get().doc.samples.some((s) => s.id === id)) : ids);
  const setIds = (next) => onChange({ groupId: value.groupId || null, ids: next });
  const mode = custom ? 'custom' : value.groupId || '';
  const pickMode = (m) => {
    if (m === 'custom') setIds(ids); // start from what's shown now, in its order
    else onChange({ groupId: m || null, ids: null });
  };
  const toggle = (id) => {
    const cur = latestIds();
    setIds(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  };
  const move = (id, d) => setIds(moveId(latestIds(), id, latestIds().indexOf(id) + d));
  const sortChosen = (e) => {
    const kws = sortableKeywords(doc, meta);
    const apply = (sort) => {
      const cur = latestIds();
      const picked = doc.samples.filter((s) => cur.includes(s.id));
      setIds(sortSamples(doc, meta, picked, sort).map((s) => s.id));
    };
    openMenu(rectOf(e.currentTarget), [
      { heading: 'Put the chosen samples in order by' },
      { label: 'Name', onClick: () => apply({ by: 'name' }) },
      { label: 'Group', disabled: !doc.groups.length, onClick: () => apply({ by: 'group' }) },
      { label: 'Event count', onClick: () => apply({ by: 'events' }) },
      { label: 'Order added', onClick: () => apply({ by: 'file' }) },
      { label: 'Keyword', icon: 'tag', disabled: !kws.length, submenu: kws.map((k) => ({ label: k, onClick: () => apply({ by: 'kw', key: k }) })) },
      { divider: true },
      { label: 'Reverse the order', icon: 'sort', onClick: () => setIds(latestIds().slice().reverse()) },
    ]);
  };
  const addGroup = (e) =>
    openMenu(
      rectOf(e.currentTarget),
      doc.groups.map((g) => ({
        label: g.name,
        onClick: () => {
          const cur = latestIds();
          setIds([...cur, ...sortSamples(doc, meta, samplesInGroup(doc, g.id)).map((s) => s.id).filter((id) => !cur.includes(id))]);
        },
      })),
    );

  // chosen samples first, in their order; then the rest, in the sample list's order
  const rest = custom ? sortSamples(doc, meta, doc.samples).filter((s) => !ids.includes(s.id)) : [];
  const row = (smp, i, chosen) => {
    const st = (meta[smp.id] || {}).status;
    return (
      <li
        key={smp.id}
        class={`ss-row ${chosen ? 'is-chosen' : ''} ${dragId === smp.id ? 'is-dragging' : ''} ${overId === smp.id && dragId !== smp.id ? 'is-over' : ''}`}
        draggable={chosen}
        onDragStart={(e) => {
          setDragId(smp.id);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', smp.id);
        }}
        onDragOver={(e) => {
          if (!dragId || !chosen) return;
          e.preventDefault();
          setOverId(smp.id);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId && chosen && dragId !== smp.id) setIds(moveId(latestIds(), dragId, latestIds().indexOf(smp.id)));
          setDragId(null);
          setOverId(null);
        }}
        onDragEnd={() => {
          setDragId(null);
          setOverId(null);
        }}
      >
        {chosen ? <span class="ss-grip" aria-hidden="true">⋮⋮</span> : <span class="ss-grip" />}
        <label class="ss-label">
          <input type="checkbox" checked={chosen} onChange={() => toggle(smp.id)} />
          <span class="ss-name">{smp.name}</span>
          {st !== 'ready' ? <span class="muted small">not loaded</span> : null}
        </label>
        {chosen ? (
          <span class="ss-move">
            <IconButton icon="up" size={12} label={`Move ${smp.name} up`} disabled={i === 0} onClick={() => move(smp.id, -1)} />
            <IconButton icon="down" size={12} label={`Move ${smp.name} down`} disabled={i === shown.length - 1} onClick={() => move(smp.id, 1)} />
          </span>
        ) : null}
      </li>
    );
  };

  return (
    <div class="sample-chooser">
      <label class="field-row">
        <span>Show</span>
        <select class="field" value={mode} onChange={(e) => pickMode(e.currentTarget.value)} aria-label="Samples to show">
          <option value="">All samples</option>
          {doc.groups.map((g) => (
            <option value={g.id} key={g.id}>
              Group: {g.name}
            </option>
          ))}
          <option value="custom">Samples I choose…</option>
        </select>
      </label>
      {custom ? (
        <>
          <div class="ss-tools">
            <span class="muted small">
              {shown.length} chosen. Drag or use the arrows to order them.
            </span>
            <button type="button" class="link-btn" onClick={sortChosen} disabled={shown.length < 2}>
              Sort…
            </button>
            {doc.groups.length ? (
              <button type="button" class="link-btn" onClick={addGroup}>
                Add group…
              </button>
            ) : null}
            <button type="button" class="link-btn" disabled={!rest.length} onClick={() => setIds([...latestIds(), ...rest.map((s) => s.id)])}>
              All
            </button>
            <button type="button" class="link-btn" disabled={!shown.length} onClick={() => setIds([])}>
              None
            </button>
          </div>
          <ul class="ss-list" aria-label="Samples">
            {shown.map((s, i) => row(s, i, true))}
            {rest.length && shown.length ? <li class="ss-sep" role="presentation" /> : null}
            {rest.map((s, i) => row(s, i, false))}
          </ul>
        </>
      ) : (
        <>
          <p class="muted small ss-note">
            {shown.length} sample{shown.length === 1 ? '' : 's'}, {orderNote(doc)}. To pick samples one by one or put them in your own order, choose “Samples I choose…”.
          </p>
          <ul class="ss-list ss-preview" aria-label="Samples">
            {shown.map((s) => (
              <li class="ss-row" key={s.id}>
                <span class="ss-name">{s.name}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
