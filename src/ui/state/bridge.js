// Keeps the compute engine in step with the document and fetches results.
//
// Every request first flushes pending state (transforms, gates, overrides,
// compensation) so the engine never answers from stale definitions: messages
// to a worker are processed in order.

import { EngineClient } from '../../engine/client.js';
import { store } from './store.js';
import { effectiveComp, compKey, countsVersion } from './derived.js';

let client = null;
const sent = { transforms: undefined, gates: undefined, overrides: undefined, derived: undefined, comp: new Map() };
let scheduled = false;
const loaded = new Set();

export function initEngine(workerSource) {
  client = new EngineClient({ workerSource });
  client.onBusy((n) => {
    const s = store.get();
    if (s && s.engine.busy !== n) store.set((st) => ({ ...st, engine: { ...st.engine, busy: n } }));
  });
  return client.ready().then((info) => {
    store.set((s) => ({ ...s, engine: { ...s.engine, ...info } }));
    return info;
  });
}

export function engine() {
  return client;
}

export function markLoaded(id, on = true) {
  if (on) loaded.add(id);
  else {
    loaded.delete(id);
    sent.comp.delete(id);
  }
}

export function isLoaded(id) {
  return loaded.has(id);
}

export function scheduleSync() {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    flush();
    refreshCounts();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** Push changed definitions to the engine. Returns true if anything was sent. */
export function flush() {
  if (!client) return false;
  const s = store.get();
  const doc = s.doc;
  let changed = false;
  if ((doc.derived || null) !== sent.derived) {
    sent.derived = doc.derived || null;
    client.broadcast('setDerived', { derived: doc.derived || [] }).catch(() => {});
    changed = true;
  }
  if (doc.transforms !== sent.transforms) {
    sent.transforms = doc.transforms;
    client.broadcast('setTransforms', { transforms: doc.transforms }).catch(() => {});
    changed = true;
  }
  if (doc.gates !== sent.gates) {
    sent.gates = doc.gates;
    sent.overrides = doc.overrides;
    client.broadcast('setGates', { gates: Object.values(doc.gates), overrides: doc.overrides }).catch(() => {});
    changed = true;
  } else if (doc.overrides !== sent.overrides) {
    sent.overrides = doc.overrides;
    client.broadcast('setOverrides', { overrides: doc.overrides }).catch(() => {});
    changed = true;
  }
  for (const smp of doc.samples) {
    if (!loaded.has(smp.id)) continue;
    const key = compKey(s, smp.id);
    if (sent.comp.get(smp.id) === key) continue;
    sent.comp.set(smp.id, key);
    const comp = effectiveComp(s, smp.id);
    client.call(smp.id, 'setComp', { comp: comp ? { names: comp.names, matrix: comp.matrix } : null }).then(
      (r) => {
        store.set((st) => ({ ...st, meta: { ...st.meta, [smp.id]: { ...(st.meta[smp.id] || {}), compMissing: (r && r.missing) || [], compError: null } } }));
      },
      (err) => {
        store.set((st) => ({ ...st, meta: { ...st.meta, [smp.id]: { ...(st.meta[smp.id] || {}), compError: err.message } } }));
      },
    );
    changed = true;
  }
  return changed;
}

/** Call the engine for a sample after syncing state. */
export function request(sampleId, type, payload = {}, transfer = []) {
  if (!client) return Promise.reject(new Error('Engine not ready'));
  flush();
  return client.call(sampleId, type, payload, transfer);
}

// ------------------------------------------------------------------ counts

const countsInflight = new Map();
const countsWanted = new Set();
const countsWatch = new Set();

/** Ask for population counts of these samples to be kept current. */
export function watchCounts(ids) {
  countsWatch.clear();
  for (const id of ids) countsWatch.add(id);
  refreshCounts();
}

export function ensureCounts(sampleId) {
  if (!sampleId || !loaded.has(sampleId)) return;
  const s = store.get();
  const version = countsVersion(s, sampleId);
  const cur = s.counts[sampleId];
  if (cur && cur.version === version) return;
  if (countsInflight.has(sampleId)) {
    countsWanted.add(sampleId);
    return;
  }
  countsInflight.set(sampleId, version);
  request(sampleId, 'counts', {})
    .then((res) => {
      store.set((st) => ({ ...st, counts: { ...st.counts, [sampleId]: { version, counts: res.counts, errors: res.errors } } }));
    })
    .catch(() => {})
    .finally(() => {
      countsInflight.delete(sampleId);
      if (countsWanted.has(sampleId)) {
        countsWanted.delete(sampleId);
        ensureCounts(sampleId);
      }
    });
}

export function refreshCounts() {
  const s = store.get();
  if (!s) return;
  if (s.ui.sampleId) ensureCounts(s.ui.sampleId);
  for (const id of countsWatch) ensureCounts(id);
}

/** Counts for a sample, fetched if missing or stale. */
export async function getCounts(sampleId) {
  const s = store.get();
  const version = countsVersion(s, sampleId);
  const cur = s.counts[sampleId];
  if (cur && cur.version === version) return cur.counts;
  const res = await request(sampleId, 'counts', {});
  store.set((st) => ({ ...st, counts: { ...st.counts, [sampleId]: { version, counts: res.counts, errors: res.errors } } }));
  return res.counts;
}

/** Re-sync and refresh whenever the document changes. */
export function installSync() {
  store.subscribe((s, prev) => {
    if (!prev) return;
    if (s.doc !== prev.doc || s.meta !== prev.meta || s.ui.sampleId !== prev.ui.sampleId) scheduleSync();
  });
}
