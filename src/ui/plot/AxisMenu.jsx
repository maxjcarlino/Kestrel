// Axis dropdown: choose the parameter for an axis and edit its display scale.

import { useMemo, useRef, useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { updatePlot, setTransform, toast, undo, addDerived, removeDerived, setChannelLabel } from '../state/doc.js';
import { allChannels, isCompensated } from '../state/derived.js';
import { request } from '../state/bridge.js';
import { makeTransform, normalizeSpec, TRANSFORM_LABELS, formatValue } from '../../core/transforms.js';
import { Icon, Popover, Segmented, NumberField } from '../components/ui.jsx';

const KIND_LABEL = { scatter: 'Scatter', fluor: 'Fluorescence', mass: 'Mass channels', time: 'Time', other: 'Other', derived: 'Ratios' };
const KIND_ORDER = ['scatter', 'fluor', 'mass', 'time', 'other', 'derived'];

export function AxisMenu({ anchor, axis, plot, sampleId, onClose }) {
  const doc = useSel((s) => s.doc);
  const [q, setQ] = useState('');
  const [relabel, setRelabel] = useState(null);
  const [relabelVal, setRelabelVal] = useState('');
  const listRef = useRef();
  const chans = allChannels(doc);
  const current = axis === 'x' ? plot.x : plot.y;
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => chans.filter((c) => !needle || `${c.name} ${c.label}`.toLowerCase().includes(needle)), [chans, needle]);
  const groups = KIND_ORDER.map((k) => [k, filtered.filter((c) => (c.kind || 'fluor') === k)]).filter(([, list]) => list.length);
  const state = store.get();

  const pick = (name) => {
    if (axis === 'x') updatePlot(plot.id, { x: name });
    else if (name === null) updatePlot(plot.id, { y: null, type: 'hist', lastY: plot.y || plot.lastY || null });
    else updatePlot(plot.id, { y: name, type: plot.type === 'hist' ? 'pseudo' : plot.type });
    onClose();
  };

  const onKey = (e) => {
    const btns = [...listRef.current.querySelectorAll('button.axis-opt')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (btns[i + 1] || btns[0]).focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i <= 0) e.currentTarget.querySelector('input').focus();
      else btns[i - 1].focus();
    } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      if (filtered[0]) pick(filtered[0].name);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} class="axis-menu" width={312}>
      <div onKeyDown={onKey}>
        <div class="axis-search">
          <Icon name="search" size={14} />
          <input
            class="field"
            placeholder="Find a parameter"
            value={q}
            autoFocus
            ref={(el) => el && setTimeout(() => el.focus({ preventScroll: true }), 0)}
            onInput={(e) => setQ(e.currentTarget.value)}
            aria-label="Find a parameter"
          />
        </div>
        <div class="axis-list" ref={listRef} role="listbox" aria-label={`${axis.toUpperCase()} axis parameter`}>
          {axis === 'y' && !needle ? (
            <button type="button" role="option" aria-selected={!plot.y ? 'true' : 'false'} class={`axis-opt ${!plot.y ? 'is-on' : ''}`} onClick={() => pick(null)}>
              <Icon name="hist" size={14} />
              <b>Count</b>
              <span>histogram</span>
            </button>
          ) : null}
          {groups.map(([kind, list]) => (
            <div class="axis-group" key={kind}>
              <div class="axis-group-title">{KIND_LABEL[kind]}</div>
              {list.map((c) =>
                relabel === c.name ? (
                  <form
                    class="axis-relabel-form"
                    key={c.name}
                    onSubmit={(e) => {
                      e.preventDefault();
                      setChannelLabel(c.name, relabelVal);
                      setRelabel(null);
                    }}
                  >
                    <input
                      class="field field-sm"
                      autoFocus
                      ref={(el) => el && setTimeout(() => el.focus({ preventScroll: true }), 0)}
                      placeholder={c.name}
                      value={relabelVal}
                      onInput={(e) => setRelabelVal(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        // Stop Enter/Escape (and anything else) from reaching the
                        // picker's own keydown handler, which otherwise treats
                        // Enter as "pick the first filtered parameter".
                        e.stopPropagation();
                        if (e.key === 'Escape') setRelabel(null);
                      }}
                      aria-label={`Label for ${c.name}`}
                    />
                    <button type="submit" class="icon-btn" title="Save label">
                      <Icon name="check" size={13} />
                    </button>
                    <button type="button" class="icon-btn" title="Cancel" onClick={() => setRelabel(null)}>
                      <Icon name="close" size={13} />
                    </button>
                  </form>
                ) : (
                  <div class="axis-row" key={c.name}>
                    <button type="button" role="option" aria-selected={c.name === current ? 'true' : 'false'} class={`axis-opt ${c.name === current ? 'is-on' : ''}`} onClick={() => pick(c.name)}>
                      <span class="axis-check">{c.name === current ? <Icon name="check" size={13} /> : null}</span>
                      <b>{c.label || c.name}</b>
                      {c.label ? <span>{c.name}</span> : c.expr ? <span>{c.expr}</span> : null}
                      {sampleId && isCompensated(state, sampleId, c.name) ? <i class="comp-badge" title="Compensated">comp</i> : null}
                      {c.kind === 'derived' ? (
                        <i
                          class="axis-del"
                          role="button"
                          tabIndex={0}
                          title={`Remove the ratio ${c.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeDerived(c.name);
                          }}
                        >
                          <Icon name="close" size={12} />
                        </i>
                      ) : null}
                    </button>
                    {c.kind !== 'derived' ? (
                      <i
                        class="axis-relabel"
                        role="button"
                        tabIndex={0}
                        title={`Relabel ${c.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRelabel(c.name);
                          setRelabelVal(c.label || '');
                        }}
                      >
                        <Icon name="pencil" size={12} />
                      </i>
                    ) : null}
                  </div>
                ),
              )}
            </div>
          ))}
          {!filtered.length ? <div class="axis-none">No parameter matches “{q}”.</div> : null}
        </div>
        <RatioMaker chans={chans} sampleId={sampleId} pop={plot.pop} onCreate={(name) => pick(name)} />
        {current ? <ScaleEditor channel={current} sampleId={sampleId} pop={plot.pop} /> : null}
      </div>
    </Popover>
  );
}

/** Inline form for a ratio parameter A·(x − B) / (y − C). */
function RatioMaker({ chans, sampleId, pop, onCreate }) {
  const [open, setOpen] = useState(false);
  const real = chans.filter((c) => c.kind !== 'derived');
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [name, setName] = useState('');
  if (!open) {
    return (
      <div class="ratio-row">
        <button type="button" class="link-btn" onClick={() => setOpen(true)}>
          New ratio parameter…
        </button>
      </div>
    );
  }
  const ok = x && y && x !== y;
  const auto = ok ? `${x}/${y}` : '';
  const create = async () => {
    const nm = addDerived({ name: name.trim() || auto, x, y });
    // pick a starting display scale from the current sample
    if (sampleId) {
      try {
        const q = await request(sampleId, 'quantiles', { channel: nm, pop, ps: [1, 25, 50, 75, 99] });
        const spec = ratioSpec(q);
        // part of the same undo step as creating the ratio
        if (spec) setTransform(nm, spec, { history: false });
      } catch (e) {
        /* keep the default scale */
      }
    }
    onCreate(nm);
  };
  return (
    <div class="ratio-form">
      <div class="eyebrow">New ratio parameter</div>
      <div class="ratio-grid">
        <select class="field field-sm" value={x} onChange={(e) => setX(e.currentTarget.value)} aria-label="Numerator">
          <option value="">Numerator…</option>
          {real.map((c) => (
            <option value={c.name} key={c.name}>
              {c.label ? `${c.label} · ${c.name}` : c.name}
            </option>
          ))}
        </select>
        <span class="ratio-op">÷</span>
        <select class="field field-sm" value={y} onChange={(e) => setY(e.currentTarget.value)} aria-label="Denominator">
          <option value="">Denominator…</option>
          {real.map((c) => (
            <option value={c.name} key={c.name}>
              {c.label ? `${c.label} · ${c.name}` : c.name}
            </option>
          ))}
        </select>
      </div>
      <div class="ratio-grid two">
        <input class="field field-sm" placeholder={auto || 'Name'} value={name} onInput={(e) => setName(e.currentTarget.value)} aria-label="Ratio name" />
        <button type="button" class="btn btn-primary btn-sm" disabled={!ok} onClick={create}>
          Create
        </button>
      </div>
    </div>
  );
}

/**
 * Display scale for a ratio from its 1st, 25th, 50th, 75th and 99th
 * percentiles: linear for well-behaved positive ratios, arcsinh when the ratio
 * changes sign or has long tails (as happens when the denominator is near zero).
 */
export function ratioSpec(q) {
  if (!q || q.length < 5 || !q.every(Number.isFinite) || !(q[4] > q[0])) return null;
  const [lo, q1, mid, q3, hi] = q;
  if (lo >= 0 && hi <= Math.max(mid, 1e-9) * 25) return { type: 'linear', min: 0, max: niceUp(hi * 1.15) };
  const cofactor = Math.max((q3 - q1) / 2, Math.abs(mid) / 2, (hi - lo) / 1e4, 1e-6);
  return { type: 'arcsinh', cofactor: Number(cofactor.toPrecision(2)), min: lo < 0 ? -niceUp(-lo * 1.3) : 0, max: niceUp(Math.max(hi, cofactor) * 1.3) };
}

function niceUp(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function switchType(spec, type, kind) {
  const t = makeTransform(spec);
  const bottom = t.inverse(0);
  const top = t.inverse(1);
  switch (type) {
    case 'linear':
      return { type, min: spec.type === 'linear' ? spec.min : Math.min(0, bottom), max: top };
    case 'log':
      return { type, max: top, decades: spec.type === 'logicle' ? spec.M : 4.5 };
    case 'arcsinh': {
      const cofactor = kind === 'mass' ? 5 : 150;
      return { type, cofactor, max: top, min: Math.min(-cofactor, bottom < 0 ? bottom : -cofactor * 2) };
    }
    case 'hyperlog':
      return { type: 'hyperlog', T: top > 0 ? top : 262144, W: spec.type === 'logicle' ? Math.max(0.1, spec.W) : 1, M: 4.5, A: 0 };
    default:
      return { type: 'logicle', T: top > 0 ? top : 262144, W: spec.type === 'hyperlog' ? spec.W : 0.5, M: 4.5, A: 0 };
  }
}

/** Switch a channel's scale type, noting gates whose populations follow the display scale. */
function changeType(channel, spec) {
  setTransform(channel, spec, { coalesce: null });
  const doc = store.get().doc;
  const shaped = Object.values(doc.gates).filter((g) => (g.type === 'polygon' || g.type === 'ellipse') && !g.scale && (g.x === channel || g.y === channel));
  if (shaped.length) {
    const names = shaped.slice(0, 2).map((g) => g.name).join(', ') + (shaped.length > 2 ? ` and ${shaped.length - 2} more` : '');
    toast(`${channel} is now on a ${TRANSFORM_LABELS[spec.type]} scale. Polygon and ellipse gates follow the plot's scale, so ${names} may now hold different events.`, {
      timeout: 9000,
      action: { label: 'Undo', onClick: () => undo() },
    });
  }
}

export function ScaleEditor({ channel, sampleId, pop }) {
  const doc = useSel((s) => s.doc);
  const spec = normalizeSpec(doc.transforms[channel]);
  const info = allChannels(doc).find((c) => c.name === channel) || {};
  const kind = info.kind;
  const [busy, setBusy] = useState(false);
  const set = (patch) => setTransform(channel, { ...spec, ...patch });
  const auto = async () => {
    if (!sampleId) return;
    setBusy(true);
    try {
      const W = await request(sampleId, 'estimateW', { channel, T: spec.T, M: spec.M, A: spec.A, pop });
      if (Number.isFinite(W)) {
        set({ W: Math.max(0, Math.min(spec.M / 2, W)) });
        toast(`Logicle width for ${channel} set to ${W} from this sample's negative spread.`);
      }
    } catch (e) {
      toast(e.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="scale-editor">
      <div class="scale-head">
        <span class="eyebrow">Scale for {channel}</span>
        {info.fileLabel !== undefined ? (
          <button type="button" class="link-btn" onClick={() => setChannelLabel(channel, '')} title={info.fileLabel ? `Revert to the file's own label (${info.fileLabel})` : "Revert to no label"}>
            Reset label
          </button>
        ) : null}
      </div>
      <Segmented
        label="Scale type"
        value={spec.type}
        onChange={(t) => changeType(channel, switchType(spec, t, kind))}
        options={['linear', 'log', 'logicle', 'hyperlog', 'arcsinh'].map((t) => ({ value: t, label: TRANSFORM_LABELS[t] }))}
      />
      {spec.type === 'linear' ? (
        <div class="scale-grid">
          <label>
            <span>Minimum</span>
            <NumberField value={spec.min} onCommit={(v) => set({ min: v })} format={fmt} />
          </label>
          <label>
            <span>Maximum</span>
            <NumberField value={spec.max} onCommit={(v) => set({ max: v })} format={fmt} />
          </label>
        </div>
      ) : null}
      {spec.type === 'log' ? (
        <div class="scale-grid">
          <label>
            <span>Top of scale</span>
            <NumberField value={spec.max} onCommit={(v) => set({ max: v })} format={fmt} />
          </label>
          <label>
            <span>Decades</span>
            <NumberField value={spec.decades} onCommit={(v) => set({ decades: v })} />
          </label>
        </div>
      ) : null}
      {spec.type === 'logicle' ? (
        <>
          <div class="scale-slider">
            <label for={`w-${channel}`}>
              <span>Width (W)</span>
              <b class="num">{spec.W.toFixed(2)}</b>
            </label>
            <input
              id={`w-${channel}`}
              type="range"
              min="0"
              max={spec.M / 2}
              step="0.01"
              value={spec.W}
              onInput={(e) => set({ W: parseFloat(e.currentTarget.value) })}
            />
            <button type="button" class="btn btn-default btn-sm" onClick={auto} disabled={busy || !sampleId} title="Estimate W from the negative events of the current sample">
              {busy ? 'Estimating…' : 'Auto'}
            </button>
          </div>
          <div class="scale-grid three">
            <label>
              <span>Top (T)</span>
              <NumberField value={spec.T} onCommit={(v) => set({ T: v })} format={fmt} />
            </label>
            <label>
              <span>Decades (M)</span>
              <NumberField value={spec.M} onCommit={(v) => set({ M: v })} />
            </label>
            <label>
              <span>Extra neg. (A)</span>
              <NumberField value={spec.A} onCommit={(v) => set({ A: v })} />
            </label>
          </div>
        </>
      ) : null}
      {spec.type === 'hyperlog' ? (
        <>
          <div class="scale-slider">
            <label for={`hw-${channel}`}>
              <span>Width (W)</span>
              <b class="num">{spec.W.toFixed(2)}</b>
            </label>
            <input id={`hw-${channel}`} type="range" min="0.05" max={spec.M / 2} step="0.01" value={spec.W} onInput={(e) => set({ W: parseFloat(e.currentTarget.value) })} />
            <span />
          </div>
          <div class="scale-grid three">
            <label>
              <span>Top (T)</span>
              <NumberField value={spec.T} onCommit={(v) => set({ T: v })} format={fmt} />
            </label>
            <label>
              <span>Decades (M)</span>
              <NumberField value={spec.M} onCommit={(v) => set({ M: v })} />
            </label>
            <label>
              <span>Extra neg. (A)</span>
              <NumberField value={spec.A} onCommit={(v) => set({ A: v })} />
            </label>
          </div>
        </>
      ) : null}
      {spec.type === 'arcsinh' ? (
        <div class="scale-grid three">
          <label>
            <span>Cofactor</span>
            <NumberField value={spec.cofactor} onCommit={(v) => set({ cofactor: v })} />
          </label>
          <label>
            <span>Minimum</span>
            <NumberField value={spec.min} onCommit={(v) => set({ min: v })} format={fmt} />
          </label>
          <label>
            <span>Maximum</span>
            <NumberField value={spec.max} onCommit={(v) => set({ max: v })} format={fmt} />
          </label>
        </div>
      ) : null}
      <p class="scale-note">
        Shown range {formatValue(makeTransform(spec).inverse(0))} to {formatValue(makeTransform(spec).inverse(1))}. Applies to {channel} in every plot and sample.
      </p>
    </div>
  );
}

function fmt(v) {
  if (!Number.isFinite(v)) return v;
  if (Math.abs(v) >= 1000) return Math.round(v);
  return Number(v.toPrecision(5));
}
