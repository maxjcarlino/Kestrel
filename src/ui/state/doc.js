// Workspace document model and the actions that change it.
//
// `state.doc` is the persisted workspace (what autosave writes and what a
// workspace file contains). Undo/redo snapshots only the analysis parts of
// the document, so loading or removing data files is never undone by
// accident.

import { store } from './store.js';
import { ROOT, descendants, applyOverride, geometryOf } from '../../core/gates.js';
import { newId, nextColor, toPolygon, quadRect, splitRange, canConvertToPolygon } from '../../core/gate-geometry.js';
import { makeTransform, normalizeSpec } from '../../core/transforms.js';

/* global __APP_VERSION__, __APP_HOMEPAGE__ */
export const APP = {
  name: 'Kestrel',
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.1.0',
  // set "homepage" in package.json to link the app to your repository
  homepage: typeof __APP_HOMEPAGE__ === 'string' ? __APP_HOMEPAGE__ : '',
};
export const SCHEMA = 1;
export const ANALYSIS_KEYS = ['transforms', 'comp', 'derived', 'gates', 'gateOrder', 'overrides', 'plots', 'table', 'layout', 'settings', 'groups'];

export const DEFAULT_SETTINGS = {
  colormap: 'classic',
  smooth: 1,
  labelStat: 'freqParent',
  showLabels: true,
  dotSize: 1,
  plotSize: 290,
  histSmooth: true,
  autoDrill: true,
};

export function emptyDoc(name = 'Untitled workspace') {
  const now = Date.now();
  return {
    id: newId('ws'),
    name,
    created: now,
    modified: now,
    samples: [],
    groups: [],
    transforms: {},
    comp: { matrices: [], default: 'file', perSample: {} },
    derived: [],
    gates: {},
    gateOrder: [],
    overrides: {},
    plots: [],
    table: { columns: [], groupId: null },
    layout: { plotIds: [], groupId: null, size: 220, transpose: false, overlays: [] },
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function initialState() {
  return {
    doc: emptyDoc(),
    meta: {},
    counts: {},
    ui: {
      view: 'gating',
      sampleId: null,
      selectedGate: null,
      tool: 'select',
      scope: 'all',
      focusPlot: null,
      flashPlot: null,
      inspector: true,
      sidebar: true,
      dialog: null,
      menu: null,
      editingName: null,
      compMatrixId: null,
      compCell: null,
    },
    persist: { status: 'idle', savedAt: 0, error: null, available: true },
    engine: { mode: 'starting', workers: 0, busy: 0 },
    history: { past: [], future: [], lastKey: null, lastTime: 0 },
    txn: null,
    toasts: [],
  };
}

// ------------------------------------------------------------------ core updates

export function setUI(patch) {
  store.set((s) => ({ ...s, ui: { ...s.ui, ...(typeof patch === 'function' ? patch(s.ui) : patch) } }));
}

function pickAnalysis(doc) {
  const o = {};
  for (const k of ANALYSIS_KEYS) o[k] = doc[k];
  return o;
}

/**
 * Change the document.
 * @param {(doc:object)=>object} fn returns the new document (or the same one for no change)
 * @param {{transient?:boolean, history?:boolean, coalesce?:string}} opts
 */
export function updateDoc(fn, opts = {}) {
  store.set(
    (s) => {
      const next = fn(s.doc);
      if (!next || next === s.doc) return s;
      const doc = { ...next, modified: Date.now() };
      let history = s.history;
      const record = opts.history !== false && !opts.transient && !s.txn;
      if (record) {
        const now = Date.now();
        if (opts.coalesce && history.lastKey === opts.coalesce && now - history.lastTime < 1500) {
          history = { ...history, lastTime: now, future: [] };
        } else {
          history = { past: [...history.past.slice(-99), pickAnalysis(s.doc)], future: [], lastKey: opts.coalesce || null, lastTime: now };
        }
      }
      return { ...s, doc, history };
    },
    { docChanged: true, transient: !!opts.transient || !!store.get().txn },
  );
}

/** Group a burst of transient updates (a drag) into one undo step. */
export function beginTxn() {
  store.set((s) => (s.txn ? s : { ...s, txn: { base: pickAnalysis(s.doc), doc: s.doc } }));
}

export function commitTxn() {
  store.set(
    (s) => {
      if (!s.txn) return s;
      const changed = s.txn.doc !== s.doc;
      const history = changed ? { past: [...s.history.past.slice(-99), s.txn.base], future: [], lastKey: null, lastTime: 0 } : s.history;
      return { ...s, txn: null, history, doc: changed ? { ...s.doc, modified: Date.now() } : s.doc };
    },
    { docChanged: true },
  );
}

export function cancelTxn() {
  store.set(
    (s) => {
      if (!s.txn) return s;
      return { ...s, txn: null, doc: { ...s.doc, ...s.txn.base } };
    },
    { docChanged: true },
  );
}

export function undo() {
  store.set(
    (s) => {
      const past = s.history.past;
      if (!past.length) return s;
      const prev = past[past.length - 1];
      return {
        ...s,
        doc: { ...s.doc, ...prev, modified: Date.now() },
        history: { past: past.slice(0, -1), future: [...s.history.future, pickAnalysis(s.doc)], lastKey: null, lastTime: 0 },
      };
    },
    { docChanged: true },
  );
}

export function redo() {
  store.set(
    (s) => {
      const fut = s.history.future;
      if (!fut.length) return s;
      const next = fut[fut.length - 1];
      return {
        ...s,
        doc: { ...s.doc, ...next, modified: Date.now() },
        history: { past: [...s.history.past, pickAnalysis(s.doc)], future: fut.slice(0, -1), lastKey: null, lastTime: 0 },
      };
    },
    { docChanged: true },
  );
}

let toastSeq = 0;
export function toast(message, opts = {}) {
  const id = ++toastSeq;
  const t = { id, message, kind: opts.kind || 'info', action: opts.action || null, timeout: opts.timeout ?? 4500 };
  store.set((s) => ({ ...s, toasts: [...s.toasts.slice(-3), t] }));
  if (t.timeout > 0) setTimeout(() => dismissToast(id), t.timeout);
  return id;
}

export function dismissToast(id) {
  store.set((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function setMeta(id, patch) {
  store.set((s) => ({ ...s, meta: { ...s.meta, [id]: { ...(s.meta[id] || {}), ...patch } } }));
}

// ------------------------------------------------------------------ workspace

export function renameWorkspace(name) {
  const n = String(name || '').trim() || 'Untitled workspace';
  updateDoc((d) => (d.name === n ? d : { ...d, name: n }), { history: false });
}

// ------------------------------------------------------------------ transforms

export function setTransform(channel, spec, opts = {}) {
  const s = normalizeSpec(spec);
  updateDoc((d) => ({ ...d, transforms: { ...d.transforms, [channel]: s } }), { coalesce: `t:${channel}`, ...opts });
}

// ------------------------------------------------------------------ gates

export function gateList(doc) {
  const order = doc.gateOrder.filter((id) => doc.gates[id]);
  const rest = Object.keys(doc.gates).filter((id) => !order.includes(id));
  return [...order, ...rest].map((id) => doc.gates[id]);
}

export function addGates(gates, { select = true } = {}) {
  updateDoc((d) => {
    const g2 = { ...d.gates };
    for (const g of gates) g2[g.id] = g;
    return { ...d, gates: g2, gateOrder: [...d.gateOrder, ...gates.map((g) => g.id)] };
  });
  if (select && gates[0]) setUI({ selectedGate: gates[0].id });
  return gates.map((g) => g.id);
}

export function patchGate(id, patch, opts = {}) {
  updateDoc((d) => {
    const g = d.gates[id];
    if (!g) return d;
    return { ...d, gates: { ...d.gates, [id]: { ...g, ...patch } } };
  }, opts);
}

export function renameGate(id, name) {
  const n = String(name || '').trim();
  if (!n) return;
  patchGate(id, { name: n });
}

/** Members of a linked group (quadrant / split), or just the gate itself. */
export function linkedMembers(doc, id) {
  const g = doc.gates[id];
  if (!g) return [];
  if (!g.link || !g.link.group) return [g];
  return Object.values(doc.gates).filter((x) => x.link && x.link.group === g.link.group);
}

/**
 * Write new geometry for a gate. Edits go to the current sample's override
 * when the scope is "this sample" or the sample already has its own version;
 * otherwise they change the shared gate.
 */
export function setGeometry(id, geom, { sampleId, scope, transient = false } = {}) {
  updateDoc(
    (d) => {
      const g = d.gates[id];
      if (!g) return d;
      const own = sampleId && d.overrides[sampleId] && d.overrides[sampleId][id];
      if ((scope === 'sample' && sampleId) || own) {
        const ov = { ...(d.overrides[sampleId] || {}) };
        ov[id] = { ...(ov[id] || {}), ...geom };
        return { ...d, overrides: { ...d.overrides, [sampleId]: ov } };
      }
      return { ...d, gates: { ...d.gates, [id]: { ...g, ...geom } } };
    },
    { transient },
  );
}

/** Move the shared centre of a quadrant group. */
export function setQuadCenter(group, center, ctx) {
  const d = store.get().doc;
  const members = Object.values(d.gates).filter((x) => x.link && x.link.group === group && x.link.kind === 'quad');
  updateDoc(
    (doc) => {
      let gates = doc.gates;
      let overrides = doc.overrides;
      for (const m of members) {
        const rect = quadRect(m.link.role, center[0], center[1]);
        const own = ctx.sampleId && overrides[ctx.sampleId] && overrides[ctx.sampleId][m.id];
        if ((ctx.scope === 'sample' && ctx.sampleId) || own) {
          const ov = { ...(overrides[ctx.sampleId] || {}) };
          ov[m.id] = { ...(ov[m.id] || {}), rect };
          overrides = { ...overrides, [ctx.sampleId]: ov };
        } else {
          gates = { ...gates, [m.id]: { ...gates[m.id], rect } };
        }
      }
      return { ...doc, gates, overrides };
    },
    { transient: !!ctx.transient },
  );
}

export function setSplitThreshold(group, t, ctx) {
  const d = store.get().doc;
  const members = Object.values(d.gates).filter((x) => x.link && x.link.group === group && x.link.kind === 'split');
  updateDoc(
    (doc) => {
      let gates = doc.gates;
      let overrides = doc.overrides;
      for (const m of members) {
        const range = splitRange(m.link.role, t);
        const own = ctx.sampleId && overrides[ctx.sampleId] && overrides[ctx.sampleId][m.id];
        if ((ctx.scope === 'sample' && ctx.sampleId) || own) {
          const ov = { ...(overrides[ctx.sampleId] || {}) };
          ov[m.id] = { ...(ov[m.id] || {}), range };
          overrides = { ...overrides, [ctx.sampleId]: ov };
        } else {
          gates = { ...gates, [m.id]: { ...gates[m.id], range } };
        }
      }
      return { ...doc, gates, overrides };
    },
    { transient: !!ctx.transient },
  );
}

/** Delete a gate, its descendants and boolean gates that depend on them. */
export function deleteGate(id) {
  const d = store.get().doc;
  if (!d.gates[id]) return 0;
  const doomed = new Set([id, ...descendants(d.gates, id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of Object.values(d.gates)) {
      if (doomed.has(g.id)) continue;
      if (g.type === 'boolean' && (g.boolean.refs || []).some((r) => doomed.has(r.id))) {
        doomed.add(g.id);
        for (const x of descendants(d.gates, g.id)) doomed.add(x);
        grew = true;
      }
    }
  }
  updateDoc((doc) => {
    const gates = { ...doc.gates };
    for (const x of doomed) delete gates[x];
    const overrides = {};
    for (const [sid, ov] of Object.entries(doc.overrides)) {
      const o = { ...ov };
      for (const x of doomed) delete o[x];
      if (Object.keys(o).length) overrides[sid] = o;
    }
    const plots = doc.plots.filter((p) => !doomed.has(p.pop)).map((p) => (p.overlay && doomed.has(p.overlay) ? { ...p, overlay: 'none' } : p));
    const table = { ...doc.table, columns: doc.table.columns.filter((c) => !doomed.has(c.pop)) };
    const layout = { ...doc.layout, plotIds: doc.layout.plotIds.filter((pid) => plots.some((p) => p.id === pid)), overlays: (doc.layout.overlays || []).filter((o) => !doomed.has(o.pop)) };
    return { ...doc, gates, overrides, plots, table, layout, gateOrder: doc.gateOrder.filter((x) => !doomed.has(x)) };
  });
  const ui = store.get().ui;
  if (doomed.has(ui.selectedGate)) setUI({ selectedGate: null });
  return doomed.size;
}

/** Effective (override-applied) gate for a sample. */
export function effectiveGate(doc, sampleId, id) {
  const g = doc.gates[id];
  if (!g) return null;
  const ov = sampleId && doc.overrides[sampleId] && doc.overrides[sampleId][id];
  return ov ? applyOverride(g, ov) : g;
}

export function hasOverride(doc, sampleId, id) {
  return !!(sampleId && doc.overrides[sampleId] && doc.overrides[sampleId][id]);
}

export function convertToPolygon(id, sampleId) {
  const d = store.get().doc;
  const g = d.gates[id];
  if (!canConvertToPolygon(g)) return false;
  // an ellipse that carries its own scales is sampled in that space (and keeps it), so the region is unchanged
  const own = g.scale && g.scale.x && g.scale.y;
  const tx = makeTransform(own ? g.scale.x : d.transforms[g.x]);
  const ty = makeTransform(own ? g.scale.y : d.transforms[g.y]);
  const conv = (gate) => toPolygon(gate, tx, ty);
  updateDoc((doc) => {
    const base = conv(doc.gates[id]);
    const gates = { ...doc.gates, [id]: base };
    const overrides = {};
    for (const [sid, ov] of Object.entries(doc.overrides)) {
      if (!ov[id]) {
        overrides[sid] = ov;
        continue;
      }
      const eff = applyOverride(doc.gates[id], ov[id]);
      const poly = conv(eff);
      overrides[sid] = { ...ov, [id]: { polygon: poly.polygon } };
    }
    return { ...doc, gates, overrides };
  });
  void sampleId;
  return true;
}

/** Evaluate an imported gate on the channel display scales from now on. */
export function useDisplayScale(id) {
  updateDoc((doc) => {
    const g = doc.gates[id];
    if (!g || !g.scale) return doc;
    const next = { ...g };
    delete next.scale;
    return { ...doc, gates: { ...doc.gates, [id]: next } };
  });
}

export function clearOverride(id, sampleId) {
  const d = store.get().doc;
  const members = linkedMembers(d, id).map((g) => g.id);
  updateDoc((doc) => {
    const ov = { ...(doc.overrides[sampleId] || {}) };
    for (const m of members) delete ov[m];
    const overrides = { ...doc.overrides };
    if (Object.keys(ov).length) overrides[sampleId] = ov;
    else delete overrides[sampleId];
    return { ...doc, overrides };
  });
}

export function makeOverride(id, sampleId) {
  const d = store.get().doc;
  const members = linkedMembers(d, id);
  updateDoc((doc) => {
    const ov = { ...(doc.overrides[sampleId] || {}) };
    for (const m of members) ov[m.id] = geometryOf(effectiveGate(doc, sampleId, m.id));
    return { ...doc, overrides: { ...doc.overrides, [sampleId]: ov } };
  });
}

/** Promote this sample's version of a gate to the shared definition. */
export function applyOverrideToAll(id, sampleId) {
  const d = store.get().doc;
  const members = linkedMembers(d, id);
  updateDoc((doc) => {
    const gates = { ...doc.gates };
    const ov = { ...(doc.overrides[sampleId] || {}) };
    for (const m of members) {
      gates[m.id] = effectiveGate(doc, sampleId, m.id);
      delete ov[m.id];
    }
    const overrides = { ...doc.overrides };
    if (Object.keys(ov).length) overrides[sampleId] = ov;
    else delete overrides[sampleId];
    return { ...doc, gates, overrides };
  });
}

export function newGateBase(doc, { parent, x, y, type, name }) {
  return { id: newId('g'), name, parent: parent || ROOT, type, x, y: y || null, color: nextColor(doc.gates) };
}

export function defaultGateName(doc) {
  const names = new Set(Object.values(doc.gates).map((g) => g.name));
  let k = Object.keys(doc.gates).length + 1;
  let n = `Gate ${k}`;
  while (names.has(n)) n = `Gate ${++k}`;
  return n;
}

// ------------------------------------------------------------------ derived parameters

/** Add a ratio parameter: A·(x − B) / (y − C). */
/** Ratio parameters start on a linear 0–4 scale until a better range is known. */
export const RATIO_SPEC = { type: 'linear', min: 0, max: 4 };

export function addDerived(def, { transform = null } = {}) {
  const name = String(def.name || `${def.x}/${def.y}`).trim();
  const d = { name, kind: 'ratio', x: def.x, y: def.y, A: Number.isFinite(def.A) ? def.A : 1, B: Number.isFinite(def.B) ? def.B : 0, C: Number.isFinite(def.C) ? def.C : 0 };
  updateDoc((doc) => {
    const transforms = transform || !doc.transforms[name] ? { ...doc.transforms, [name]: normalizeSpec(transform || RATIO_SPEC) } : doc.transforms;
    return { ...doc, transforms, derived: [...(doc.derived || []).filter((x) => x.name !== name), d] };
  });
  return name;
}

export function removeDerived(name) {
  updateDoc((doc) => ({ ...doc, derived: (doc.derived || []).filter((x) => x.name !== name) }));
}

// ------------------------------------------------------------------ plots

export function addPlot(spec, { after = null, focus = true } = {}) {
  const p = { id: newId('p'), type: 'pseudo', overlay: 'none', ...spec };
  updateDoc((d) => {
    const plots = d.plots.slice();
    const i = after ? plots.findIndex((x) => x.id === after) : -1;
    if (i >= 0) plots.splice(i + 1, 0, p);
    else plots.push(p);
    return { ...d, plots };
  });
  if (focus) setUI({ focusPlot: p.id, flashPlot: p.id });
  return p.id;
}

export function updatePlot(id, patch) {
  updateDoc((d) => ({ ...d, plots: d.plots.map((p) => (p.id === id ? { ...p, ...patch } : p)) }), { coalesce: `p:${id}:${Object.keys(patch).join(',')}` });
}

export function removePlot(id) {
  updateDoc((d) => ({ ...d, plots: d.plots.filter((p) => p.id !== id), layout: { ...d.layout, plotIds: d.layout.plotIds.filter((x) => x !== id) } }));
}

export function movePlot(id, dir) {
  updateDoc((d) => {
    const plots = d.plots.slice();
    const i = plots.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= plots.length) return d;
    [plots[i], plots[j]] = [plots[j], plots[i]];
    return { ...d, plots };
  });
}

export function updateSettings(patch) {
  updateDoc((d) => ({ ...d, settings: { ...d.settings, ...patch } }), { coalesce: `s:${Object.keys(patch).join(',')}` });
}

// ------------------------------------------------------------------ compensation

export function addMatrix(m, { assign = false } = {}) {
  const mat = { id: newId('m'), name: m.name || 'Matrix', names: m.names.slice(), matrix: m.matrix.map((r) => r.slice()), source: m.source || 'manual', created: Date.now() };
  updateDoc((d) => ({ ...d, comp: { ...d.comp, matrices: [...d.comp.matrices, mat], default: assign ? mat.id : d.comp.default } }));
  return mat.id;
}

export function updateMatrix(id, patch, opts = {}) {
  updateDoc((d) => ({ ...d, comp: { ...d.comp, matrices: d.comp.matrices.map((m) => (m.id === id ? { ...m, ...patch } : m)) } }), opts);
}

export function deleteMatrix(id) {
  updateDoc((d) => {
    const perSample = {};
    for (const [k, v] of Object.entries(d.comp.perSample)) if (v !== id) perSample[k] = v;
    return { ...d, comp: { matrices: d.comp.matrices.filter((m) => m.id !== id), default: d.comp.default === id ? 'file' : d.comp.default, perSample } };
  });
}

export function setDefaultComp(value) {
  updateDoc((d) => ({ ...d, comp: { ...d.comp, default: value } }));
}

export function setSampleComp(sampleId, value) {
  updateDoc((d) => {
    const perSample = { ...d.comp.perSample };
    if (value === null || value === undefined || value === 'default') delete perSample[sampleId];
    else perSample[sampleId] = value;
    return { ...d, comp: { ...d.comp, perSample } };
  });
}

// ------------------------------------------------------------------ table

export function addTableColumns(cols) {
  updateDoc((d) => {
    const existing = new Set(d.table.columns.map((c) => colKey(c)));
    const add = cols.filter((c) => !existing.has(colKey(c))).map((c) => ({ id: newId('c'), ...c }));
    if (!add.length) return d;
    return { ...d, table: { ...d.table, columns: [...d.table.columns, ...add] } };
  });
}

export function colKey(c) {
  return [c.kind || 'stat', c.pop || '', c.stat || '', c.channel || '', c.arg ?? '', c.keyword || ''].join('|');
}

export function removeTableColumn(id) {
  updateDoc((d) => ({ ...d, table: { ...d.table, columns: d.table.columns.filter((c) => c.id !== id) } }));
}

export function moveTableColumn(id, dir) {
  updateDoc((d) => {
    const cols = d.table.columns.slice();
    const i = cols.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cols.length) return d;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    return { ...d, table: { ...d.table, columns: cols } };
  });
}

export function setTable(patch) {
  updateDoc((d) => ({ ...d, table: { ...d.table, ...patch } }));
}

export function setLayout(patch) {
  updateDoc((d) => ({ ...d, layout: { ...d.layout, ...patch } }));
}

// ------------------------------------------------------------------ samples & groups

export function removeSamples(ids) {
  const set = new Set(ids);
  updateDoc(
    (d) => {
      const overrides = { ...d.overrides };
      for (const id of ids) delete overrides[id];
      const perSample = { ...d.comp.perSample };
      for (const id of ids) delete perSample[id];
      return { ...d, samples: d.samples.filter((s) => !set.has(s.id)), overrides, comp: { ...d.comp, perSample } };
    },
    { history: false },
  );
  store.set((s) => {
    const meta = { ...s.meta };
    const counts = { ...s.counts };
    for (const id of ids) {
      delete meta[id];
      delete counts[id];
    }
    const remaining = s.doc.samples;
    const ui = set.has(s.ui.sampleId) ? { ...s.ui, sampleId: remaining[0] ? remaining[0].id : null } : s.ui;
    return { ...s, meta, counts, ui };
  });
}

export function renameSample(id, name) {
  const n = String(name || '').trim();
  if (!n) return;
  updateDoc((d) => ({ ...d, samples: d.samples.map((s) => (s.id === id ? { ...s, name: n } : s)) }), { history: false });
}

export function addGroup(name, sampleIds = []) {
  const g = { id: newId('grp'), name: String(name || 'Group').trim() || 'Group' };
  updateDoc((d) => ({
    ...d,
    groups: [...d.groups, g],
    samples: d.samples.map((s) => (sampleIds.includes(s.id) ? { ...s, groupIds: [...new Set([...(s.groupIds || []), g.id])] } : s)),
  }));
  return g.id;
}

export function removeGroup(id) {
  updateDoc((d) => ({
    ...d,
    groups: d.groups.filter((g) => g.id !== id),
    samples: d.samples.map((s) => ({ ...s, groupIds: (s.groupIds || []).filter((x) => x !== id) })),
    table: d.table.groupId === id ? { ...d.table, groupId: null } : d.table,
    layout: d.layout.groupId === id ? { ...d.layout, groupId: null } : d.layout,
  }));
}

export function toggleSampleGroup(sampleId, groupId) {
  updateDoc((d) => ({
    ...d,
    samples: d.samples.map((s) => {
      if (s.id !== sampleId) return s;
      const has = (s.groupIds || []).includes(groupId);
      return { ...s, groupIds: has ? s.groupIds.filter((x) => x !== groupId) : [...(s.groupIds || []), groupId] };
    }),
  }));
}

/** Create one group per distinct value of a keyword. */
export function groupByKeyword(keyword) {
  const s = store.get();
  const byVal = new Map();
  for (const smp of s.doc.samples) {
    const m = s.meta[smp.id];
    const kw = m && m.keywords ? findKeyword(m.keywords, keyword) : undefined;
    const v = kw === undefined || String(kw).trim() === '' ? '(none)' : String(kw).trim();
    if (!byVal.has(v)) byVal.set(v, []);
    byVal.get(v).push(smp.id);
  }
  const created = [];
  updateDoc((d) => {
    let groups = d.groups.slice();
    let samples = d.samples;
    for (const [v, ids] of byVal) {
      let g = groups.find((x) => x.name === v);
      if (!g) {
        g = { id: newId('grp'), name: v };
        groups.push(g);
        created.push(g.id);
      }
      const gid = g.id;
      samples = samples.map((smp) => (ids.includes(smp.id) ? { ...smp, groupIds: [...new Set([...(smp.groupIds || []), gid])] } : smp));
    }
    return { ...d, groups, samples };
  });
  return created.length;
}

export function findKeyword(keywords, name) {
  if (keywords[name] !== undefined) return keywords[name];
  const up = name.toUpperCase();
  for (const k of Object.keys(keywords)) if (k.toUpperCase() === up) return keywords[k];
  return undefined;
}

export function samplesInGroup(doc, groupId) {
  if (!groupId) return doc.samples;
  return doc.samples.filter((s) => (s.groupIds || []).includes(groupId));
}
