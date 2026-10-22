// Modal dialogs: workspaces, boolean gates, compensation from controls, groups, help.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { useSel } from '../state/store.js';
import { setUI, addGates, newGateBase, addGroup, removeGroup, groupByKeyword, updateDoc, addMatrix, toast, APP, applyGateToSamples } from '../state/doc.js';
import { openSavedWorkspace, newWorkspace, openDemo } from '../state/loader.js';
import { listWorkspaces, deleteWorkspace, saveNow, storageEstimate } from '../state/persist.js';
import { request } from '../state/bridge.js';
import { allChannels, popName } from '../state/derived.js';
import { spilloverFromMedians } from '../../core/compensation.js';
import { missingSamples, loadMatching, pickFolderMatches } from '../state/locate.js';
import { pickFiles } from '../util/download.js';
import { ROOT } from '../../core/gates.js';
import { GATE_COLORS } from '../../core/gate-geometry.js';
import { Dialog, Button, Icon, closeDialog, Segmented } from './ui.jsx';
import { popOptions } from '../plot/PlotCard.jsx';
import { TOOLS } from './GatingView.jsx';

export function DialogHost() {
  const d = useSel((s) => s.ui.dialog);
  if (!d) return null;
  const C = { workspaces: WorkspacesDialog, boolean: BooleanDialog, computeComp: ComputeCompDialog, group: GroupDialog, groupByKeyword: GroupByKeywordDialog, groups: GroupsDialog, applyGate: ApplyGateDialog, locateFiles: LocateFilesDialog, help: HelpDialog }[d.name];
  return C ? <C {...(d.props || {})} /> : null;
}

// ------------------------------------------------------------------ workspaces

function when(t) {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function WorkspacesDialog() {
  const currentId = useSel((s) => s.doc.id);
  const [list, setList] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [usage, setUsage] = useState(null);
  const refresh = async () => {
    await saveNow();
    setList(await listWorkspaces());
    const est = await storageEstimate();
    if (est && est.usage !== undefined) setUsage(est);
  };
  useEffect(() => {
    refresh();
  }, []);
  return (
    <Dialog title="Workspaces in this browser" onClose={closeDialog} width={620} footer={<><Button icon="flask" onClick={() => { closeDialog(); openDemo(); }}>Open demo</Button><Button variant="primary" icon="plus" onClick={() => { closeDialog(); newWorkspace(); }}>New workspace</Button></>}>
      <p class="muted small">Workspaces save themselves after every change. They live in this browser only; use “Save workspace file” to move one to another computer.</p>
      {list === null ? (
        <p class="muted">Loading…</p>
      ) : list.length === 0 ? (
        <p class="muted">No saved workspaces yet.</p>
      ) : (
        <ul class="ws-list">
          {list.map((w) => (
            <li class={`ws-row ${w.id === currentId ? 'is-current' : ''}`} key={w.id}>
              <div class="ws-row-main">
                <b>{w.name}</b>
                <span class="muted small">
                  {when(w.modified)} · {w.nSamples} sample{w.nSamples === 1 ? '' : 's'} · {w.nGates} gate{w.nGates === 1 ? '' : 's'}
                </span>
              </div>
              {confirm === w.id ? (
                <div class="ws-row-actions">
                  <span class="small">Delete for good?</span>
                  <Button size="sm" variant="danger" onClick={async () => { await deleteWorkspace(w.id); setConfirm(null); if (w.id === currentId) { closeDialog(); newWorkspace(); } else refresh(); }}>Delete</Button>
                  <Button size="sm" onClick={() => setConfirm(null)}>Keep</Button>
                </div>
              ) : (
                <div class="ws-row-actions">
                  {w.id === currentId ? <span class="pill">Open now</span> : <Button size="sm" variant="primary" onClick={async () => { closeDialog(); await saveNow(); try { await openSavedWorkspace(w.id); } catch (e) { toast(e.message, { kind: 'error' }); } }}>Open</Button>}
                  <Button size="sm" icon="trash" aria-label={`Delete ${w.name}`} onClick={() => setConfirm(w.id)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {usage ? <p class="muted small">Browser storage used: {(usage.usage / 1e6).toFixed(1)} MB{usage.quota ? ` of ${(usage.quota / 1e9).toFixed(1)} GB available` : ''}. Data files are kept with their workspace so it reopens with its data.</p> : null}
    </Dialog>
  );
}

// ------------------------------------------------------------------ boolean gates

function BooleanDialog({ parent = ROOT, seed }) {
  const doc = useSel((s) => s.doc);
  const [par, setPar] = useState(parent);
  const [op, setOp] = useState('and');
  const sibs = Object.values(doc.gates).filter((g) => (g.parent || ROOT) === par && g.type !== 'boolean');
  const [refs, setRefs] = useState(() => (seed ? [{ id: seed, not: false }] : []));
  const [name, setName] = useState('');
  const toggle = (id) => {
    const has = refs.some((r) => r.id === id);
    if (op === 'not') setRefs(has ? [] : [{ id, not: false }]);
    else setRefs(has ? refs.filter((r) => r.id !== id) : [...refs, { id, not: false }]);
  };
  const changeOp = (v) => {
    setOp(v);
    if (v === 'not' && refs.length > 1) setRefs(refs.slice(0, 1));
  };
  const flip = (id) => setRefs(refs.map((r) => (r.id === id ? { ...r, not: !r.not } : r)));
  const auto = refs.map((r) => `${r.not || op === 'not' ? 'not ' : ''}${doc.gates[r.id] ? doc.gates[r.id].name : '?'}`).join(op === 'or' ? ' or ' : ' and ');
  const valid = op === 'not' ? refs.length === 1 : refs.length >= 2 || (refs.length === 1 && refs[0].not);
  const create = () => {
    const finalRefs = op === 'not' ? refs.map((r) => ({ ...r, not: true })) : refs;
    const base = newGateBase(doc, { parent: par, type: 'boolean', name: name.trim() || auto });
    addGates([{ ...base, x: null, y: null, boolean: { op: op === 'or' ? 'or' : 'and', refs: finalRefs } }]);
    closeDialog();
  };
  return (
    <Dialog title="New boolean gate" onClose={closeDialog} width={520} footer={<><Button onClick={closeDialog}>Cancel</Button><Button variant="primary" disabled={!valid} onClick={create}>Create gate</Button></>}>
      <label class="field-row">
        <span>Within</span>
        <select class="field" value={par} onChange={(e) => { setPar(e.currentTarget.value); setRefs([]); }}>
          {popOptions(doc).map((p) => (
            <option value={p.id} key={p.id}>
              {' '.repeat(p.depth)}
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div class="field-row">
        <span>Combine with</span>
        <Segmented value={op} onChange={changeOp} options={[{ value: 'and', label: 'AND' }, { value: 'or', label: 'OR' }, { value: 'not', label: 'NOT' }]} label="Operator" />
      </div>
      <p class="muted small">
        {op === 'not'
          ? 'Events in the parent that are outside the chosen population.'
          : op === 'or'
            ? 'Events in any of the chosen populations. Use “not” to take events outside one.'
            : 'Events in all of the chosen populations. Use “not” to take events outside one.'}
      </p>
      <div class="eyebrow">Populations in {popName(doc, par)}</div>
      {sibs.length === 0 ? <p class="muted small">This population has no child gates to combine.</p> : null}
      <div class="check-list">
        {sibs.map((g) => {
          const r = refs.find((x) => x.id === g.id);
          return (
            <div class="check-row" key={g.id}>
              <label class="grow">
                <input type="checkbox" checked={!!r} onChange={() => toggle(g.id)} />
                <i class="swatch-dot" style={{ background: g.color }} />
                <span>{g.name}</span>
              </label>
              {r && op !== 'not' ? (
                <button type="button" class={`chip ${r.not ? 'is-on' : ''}`} onClick={() => flip(g.id)} title="Use events outside this gate">
                  not
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <label class="field-row">
        <span>Name</span>
        <input class="field" value={name} placeholder={auto || 'Name'} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
    </Dialog>
  );
}

// ------------------------------------------------------------------ apply gate to samples

function ApplyGateDialog({ gateId, sourceSampleId }) {
  const doc = useSel((s) => s.doc);
  const g = doc.gates[gateId];
  const sourceName = (doc.samples.find((x) => x.id === sourceSampleId) || {}).name || 'This sample';
  const candidates = doc.samples.filter((s) => s.id !== sourceSampleId);
  const [sel, setSel] = useState(() => new Set());
  const toggle = (id) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  const allChecked = candidates.length > 0 && candidates.every((s) => sel.has(s.id));
  const apply = () => {
    applyGateToSamples(gateId, sourceSampleId, [...sel]);
    closeDialog();
    toast(`Applied ${sourceName}'s "${g ? g.name : 'gate'}" to ${sel.size} sample${sel.size === 1 ? '' : 's'}.`);
  };
  if (!g) return null;
  return (
    <Dialog
      title={`Apply "${g.name}" to other samples`}
      onClose={closeDialog}
      width={460}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!sel.size} onClick={apply}>
            Apply to {sel.size || 0} sample{sel.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <p class="muted small">
        Copies {sourceName}'s position and shape for “{g.name}” (and any gates linked to it, such as quadrant parts) onto each sample checked below, as that sample's own adjustment — the same as “Adjust for {sourceName} only”, applied in bulk. Each one keeps its own copy and can be reset to the shared gate individually afterward.
      </p>
      <div class="eyebrow-row">
        <div class="eyebrow">Samples</div>
        {candidates.length ? (
          <button type="button" class="link-btn" onClick={() => setSel(allChecked ? new Set() : new Set(candidates.map((s) => s.id)))}>
            {allChecked ? 'Deselect all' : 'Select all'}
          </button>
        ) : null}
      </div>
      {candidates.length ? (
        <div class="check-list">
          {candidates.map((s) => (
            <label class="check-row" key={s.id}>
              <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggle(s.id)} />
              <span>{s.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <p class="muted small">No other samples in this workspace.</p>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ locate data files

/**
 * A workspace opened from a file lists its samples' data files by name but
 * doesn't carry them. Ask for the folder they're in (subfolders are searched
 * too) and load whatever matches. Closes itself once nothing is missing,
 * however the files arrived (this dialog, a drop, or "Add files").
 */
function LocateFilesDialog({ dir = null }) {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [initial] = useState(() => missingSamples().length);
  const missing = doc.samples.filter((x) => (meta[x.id] || {}).status === 'missing' && !(x.source && x.source.type === 'demo'));

  useEffect(() => {
    if (missing.length === 0) {
      closeDialog();
      if (initial > 0) toast(initial > 1 ? `All ${initial} data files found.` : 'Data file found.');
    }
  }, [missing.length]);

  const run = async (getFiles) => {
    setNote('');
    const before = missingSamples().length;
    const files = await getFiles();
    if (files === null) return; // cancelled
    setBusy(true);
    try {
      const n = await loadMatching(files);
      const left = before - n;
      if (n === 0) setNote('None of the missing files are in that folder. Try another one.');
      else if (left > 0) setNote(`Found ${n}. ${left} still missing — choose another folder for ${left > 1 ? 'those' : 'that one'}.`);
    } catch (e) {
      setNote(`Could not read that folder: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!missing.length) return null;
  return (
    <Dialog
      title="Find this workspace's data files"
      onClose={closeDialog}
      width={520}
      class="locate-dialog"
      footer={
        <>
          <Button onClick={closeDialog}>Not now</Button>
          <Button disabled={busy} onClick={() => run(() => pickFiles({ accept: '.fcs,.lmd,.csv,.tsv,.txt' }).then((f) => (f.length ? f : null)))}>
            Choose files…
          </Button>
          <Button variant="primary" icon="folder" disabled={busy} onClick={() => run(() => pickFolderMatches())}>
            {busy ? 'Loading…' : 'Choose folder…'}
          </Button>
        </>
      }
    >
      <p class="small">
        {dir ? (
          <>
            {missing.length === 1 ? 'One data file wasn’t' : `${missing.length} data files weren’t`} found next to the workspace, in <code class="locate-dir">{dir}</code>.
          </>
        ) : (
          <>{missing.length === 1 ? 'One data file isn’t' : `${missing.length} data files aren’t`} loaded: a workspace file lists its samples’ data files but doesn’t contain them.</>
        )}{' '}
        Choose the folder they’re in — files are matched by name, and its subfolders are searched too.
      </p>
      <ul class="locate-list">
        {missing.map((smp) => (
          <li key={smp.id}>
            <Icon name="warn" size={13} />
            <span>{smp.fileName}</span>
          </li>
        ))}
      </ul>
      {note ? <p class="muted small locate-note">{note}</p> : null}
    </Dialog>
  );
}

// ------------------------------------------------------------------ compensation from controls

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function guessDetector(name, detectors, labels) {
  const n = norm(name);
  let best = null;
  for (const d of detectors) {
    const k = norm(d);
    const k2 = norm(d.replace(/-[AHW]$/i, ''));
    for (const key of [k, k2]) if (key.length >= 2 && n.includes(key) && (!best || key.length > best.len)) best = { d, len: key.length };
    const lab = labels[d];
    if (lab && norm(lab).length >= 3 && n.includes(norm(lab)) && (!best || norm(lab).length > best.len)) best = { d, len: norm(lab).length };
  }
  return best ? best.d : '';
}

function ComputeCompDialog() {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const chans = allChannels(doc).filter((c) => c.kind === 'fluor' || c.kind === 'mass');
  const detectors = chans.map((c) => c.name);
  const labels = Object.fromEntries(chans.map((c) => [c.name, c.label]));
  const ready = doc.samples.filter((s) => (meta[s.id] || {}).status === 'ready');
  const [assign, setAssign] = useState(() => {
    const a = {};
    for (const s of ready) {
      if (/unstain|unst\b|blank|negative|\bneg\b/i.test(s.name)) a[s.id] = 'unstained';
      else a[s.id] = guessDetector(s.name, detectors, labels);
    }
    return a;
  });
  const [pop, setPop] = useState(ROOT);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('Computed from single stains');
  const controls = ready.filter((s) => assign[s.id] && assign[s.id] !== 'unstained');
  const unstained = ready.find((s) => assign[s.id] === 'unstained');
  const used = [...new Set(controls.map((s) => assign[s.id]))];
  const names = detectors.filter((d) => used.includes(d));

  const compute = async () => {
    setBusy(true);
    setResult(null);
    try {
      let negRef = null;
      const thresholds = {};
      if (unstained) {
        const r = await request(unstained.id, 'medians', { pop, channels: names });
        negRef = r.medians;
        for (const d of names) {
          const q = await request(unstained.id, 'quantiles', { channel: d, pop, ps: [99.5], raw: true });
          thresholds[d] = q ? q[0] : null;
        }
      }
      const entries = [];
      const notes = [];
      for (const s of controls) {
        const d = assign[s.id];
        const r = await request(s.id, 'controlMedians', { pop, primary: d, channels: names, threshold: unstained ? thresholds[d] : null, internalNeg: !unstained });
        if (r.error) {
          notes.push(r.error);
          continue;
        }
        if (r.nPos < 50) notes.push(`${s.name}: only ${r.nPos} positive events; the ${d} row may be unreliable.`);
        entries.push({ primary: d, pos: r.pos, neg: unstained ? negRef : r.neg });
      }
      const m = spilloverFromMedians(names, entries);
      setResult({ ...m, notes: [...notes, ...m.notes] });
    } catch (e) {
      toast(`Could not compute the matrix: ${e.message}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const save = (assignIt) => {
    const id = addMatrix({ name: name.trim() || 'Computed matrix', names: result.names, matrix: result.matrix, source: 'controls' }, { assign: assignIt });
    setUI({ compMatrixId: id });
    closeDialog();
    toast(assignIt ? 'Matrix saved and applied to all samples that use the workspace default.' : 'Matrix saved.');
  };

  return (
    <Dialog
      title="Compute compensation from single-stain controls"
      onClose={closeDialog}
      width={760}
      footer={
        result ? (
          <>
            <Button onClick={() => setResult(null)}>Back</Button>
            <Button onClick={() => save(false)}>Save matrix</Button>
            <Button variant="primary" onClick={() => save(true)}>Save and use as default</Button>
          </>
        ) : (
          <>
            <Button onClick={closeDialog}>Cancel</Button>
            <Button variant="primary" disabled={busy || controls.length === 0} onClick={compute}>
              {busy ? 'Computing…' : `Compute from ${controls.length} control${controls.length === 1 ? '' : 's'}`}
            </Button>
          </>
        )
      }
    >
      {!result ? (
        <>
          <p class="muted small">
            Mark each single-stained control with the detector its dye is read in. Spillover is the ratio of median signals in every other detector between positive and negative events, using uncompensated data. With an unstained control, positives are events above its 99.5th percentile; without one, each control's own dimmest events serve as the negative.
          </p>
          <label class="field-row">
            <span>Use events in</span>
            <select class="field" value={pop} onChange={(e) => setPop(e.currentTarget.value)}>
              {popOptions(doc).map((p) => (
                <option value={p.id} key={p.id}>
                  {' '.repeat(p.depth)}
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div class="ctl-table">
            {ready.map((s) => (
              <label class="ctl-row" key={s.id}>
                <span class="ctl-name" title={s.name}>
                  {s.name}
                </span>
                <select class="field field-sm" value={assign[s.id] || ''} onChange={(e) => setAssign({ ...assign, [s.id]: e.currentTarget.value })}>
                  <option value="">Not a control</option>
                  <option value="unstained">Unstained (negative)</option>
                  {detectors.map((d) => (
                    <option value={d} key={d}>
                      Stained for {labels[d] ? `${labels[d]} · ${d}` : d}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          <label class="field-row">
            <span>Matrix name</span>
            <input class="field" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          {result.notes.length ? (
            <ul class="note-list">
              {result.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
          <div class="mat-scroll">
            <table class="mat-table compact">
              <thead>
                <tr>
                  <th class="corner" />
                  {result.names.map((c) => (
                    <th key={c}>
                      <span class="mat-det">{c}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.names.map((r, i) => (
                  <tr key={r}>
                    <th scope="row">
                      <span class="mat-det">{r}</span>
                    </th>
                    {result.matrix[i].map((v, j) => (
                      <td class={`num ${i === j ? 'is-diag' : ''}`} key={j}>
                        {i === j ? '100' : Math.abs(v * 100) < 0.005 ? '0.00' : (v * 100).toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ groups

function GroupDialog({ sampleIds = [] }) {
  const doc = useSel((s) => s.doc);
  const [name, setName] = useState('');
  const [sel, setSel] = useState(() => new Set(sampleIds));
  const toggle = (id) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  return (
    <Dialog title="New group" onClose={closeDialog} width={460} footer={<><Button onClick={closeDialog}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => { addGroup(name, [...sel]); closeDialog(); }}>Create group</Button></>}>
      <label class="field-row">
        <span>Name</span>
        <input class="field" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="e.g. Stimulated" />
      </label>
      <div class="eyebrow">Samples</div>
      <div class="check-list">
        {doc.samples.map((s) => (
          <label class="check-row" key={s.id}>
            <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggle(s.id)} />
            <span>{s.name}</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

function GroupByKeywordDialog() {
  const meta = useSel((s) => s.meta);
  const doc = useSel((s) => s.doc);
  const keys = useMemo(() => {
    const set = new Set();
    for (const smp of doc.samples) for (const k of Object.keys((meta[smp.id] || {}).keywords || {})) if (!/^\$?P\d+[A-Z]$/i.test(k)) set.add(k);
    return [...set].sort();
  }, [doc.samples, meta]);
  const [k, setK] = useState(keys.includes('$SRC') ? '$SRC' : keys.includes('TUBE NAME') ? 'TUBE NAME' : keys[0] || '');
  return (
    <Dialog title="Group samples by keyword" onClose={closeDialog} width={460} footer={<><Button onClick={closeDialog}>Cancel</Button><Button variant="primary" disabled={!k} onClick={() => { const n = groupByKeyword(k); closeDialog(); toast(n ? `Created ${n} group${n > 1 ? 's' : ''} from ${k}` : `Samples were added to existing groups for ${k}`); }}>Create groups</Button></>}>
      <p class="muted small">One group is made for each distinct value of the keyword.</p>
      <label class="field-row">
        <span>Keyword</span>
        <select class="field" value={k} onChange={(e) => setK(e.currentTarget.value)}>
          {keys.map((x) => (
            <option value={x} key={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}

function GroupsDialog() {
  const doc = useSel((s) => s.doc);
  return (
    <Dialog title="Groups" onClose={closeDialog} width={460} footer={<Button variant="primary" onClick={closeDialog}>Done</Button>}>
      <ul class="ws-list">
        {doc.groups.map((g) => {
          const n = doc.samples.filter((s) => (s.groupIds || []).includes(g.id)).length;
          return (
            <li class="ws-row" key={g.id}>
              <div class="ws-row-main">
                <input class="field" value={g.name} onChange={(e) => updateDoc((d) => ({ ...d, groups: d.groups.map((x) => (x.id === g.id ? { ...x, name: e.currentTarget.value } : x)) }))} aria-label="Group name" />
                <span class="muted small">
                  {n} sample{n === 1 ? '' : 's'}
                </span>
              </div>
              <Button size="sm" icon="trash" onClick={() => removeGroup(g.id)}>
                Remove
              </Button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

// ------------------------------------------------------------------ help

function HelpDialog() {
  const engine = useSel((s) => s.engine);
  return (
    <Dialog title="Using Kestrel" onClose={closeDialog} width={680} footer={<Button variant="primary" onClick={closeDialog}>Close</Button>}>
      <div class="help">
        <section>
          <h3>Workflow</h3>
          <ol>
            <li>Drop FCS files onto the window (FCS 2.0 to 3.2, or CSV tables). They are read on this computer and never uploaded.</li>
            <li>Check compensation in the Compensation view. The acquisition matrix from each file is used by default; you can compute one from single-stain controls or edit values directly.</li>
            <li>Click an axis title to choose its parameter and adjust its scale (linear, log, Logicle, Hyperlog or arcsinh). The same menu creates ratio parameters such as FSC-A / FSC-H.</li>
            <li>Pick a gate tool and draw on a plot. Double-click a gate to drill down into a new plot of that population. Right-click a gate to convert it to a polygon, recolour it, adjust it for one sample or export its events.</li>
            <li>Build a statistics table and batch figures. Everything is saved automatically and can be saved as a reusable workflow template.</li>
          </ol>
        </section>
        <section>
          <h3>Shortcuts</h3>
          <dl class="keys">
            {TOOLS.map((t) => (
              <>
                <dt>
                  <kbd>{t.key}</kbd>
                </dt>
                <dd>{t.label}</dd>
              </>
            ))}
            <dt>
              <kbd>[</kbd> <kbd>]</kbd>
            </dt>
            <dd>Previous or next sample</dd>
            <dt>
              <kbd>Del</kbd>
            </dt>
            <dd>Delete the selected gate</dd>
            <dt>
              <kbd>Ctrl</kbd> <kbd>Z</kbd>
            </dt>
            <dd>Undo (add Shift to redo)</dd>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Cancel drawing, or clear the selection</dd>
          </dl>
        </section>
        <section>
          <h3>About</h3>
          <p>
            {APP.name} {APP.version} is free, open-source software under the MIT licence. It runs entirely in your browser; computation uses {engine.mode === 'workers' ? `${engine.workers} background threads` : 'the main thread'} on this computer. Workspaces are saved in this browser, and can be saved as files to share or move.
          </p>
          {APP.homepage ? (
            <p>
              Source code, documentation and issues:{' '}
              <a href={APP.homepage} target="_blank" rel="noopener noreferrer">
                {APP.homepage.replace(/^https?:\/\//, '')}
              </a>
            </p>
          ) : null}
          <p class="muted small">Not for clinical diagnostic use. Logicle scaling follows Parks et al. (2006) and Moore and Parks (2012); gate exchange follows the ISAC Gating-ML 2.0 standard.</p>
        </section>
      </div>
    </Dialog>
  );
}

export { Icon, GATE_COLORS };
