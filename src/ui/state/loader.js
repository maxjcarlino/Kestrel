// Loading data files, the demo experiment and saved workspaces.

import { store } from './store.js';
import { initialState, emptyDoc, setUI, setMeta, updateDoc, toast, addPlot, ANALYSIS_KEYS, SCHEMA, APP, DEFAULT_SETTINGS } from './doc.js';
import { engine, markLoaded, scheduleSync, ensureCounts } from './bridge.js';
import { defaultSpec, allChannels } from './derived.js';
import { putFile, getFile, loadWorkspaceRecord, saveNow, markSaved, getKV, copyFiles, deleteFile } from './persist.js';
import { newId } from '../../core/gate-geometry.js';
import { demoManifest } from '../../core/demo-data.js';
import { buildDemoTemplate } from './demo-template.js';
import { normalizeSpec } from '../../core/transforms.js';
import { orderGates } from '../../core/gates.js';

const DATA_EXT = /\.(fcs|lmd|csv|tsv|txt)$/i;

function baseName(fileName) {
  return fileName.replace(/\.(fcs|lmd|csv|tsv|txt)$/i, '');
}

async function sniffFormat(file) {
  if (/\.(csv|tsv|txt)$/i.test(file.name)) return 'csv';
  const head = new Uint8Array(await file.slice(0, 6).arrayBuffer());
  const s = String.fromCharCode(...head);
  if (s.startsWith('FCS')) return 'fcs';
  return null;
}

/** Called once a sample's data is in the engine. */
function onLoaded(id, meta, opts = {}) {
  markLoaded(id, true);
  const channels = meta.channels.map((c) => ({ name: c.name, label: c.label, kind: c.kind, range: c.range }));
  updateDoc(
    (d) => {
      const transforms = { ...d.transforms };
      for (const c of meta.channels) if (!transforms[c.name]) transforms[c.name] = normalizeSpec(defaultSpec(c));
      return {
        ...d,
        transforms,
        samples: d.samples.map((s) => (s.id === id ? { ...s, nEvents: meta.nEvents, channels, version: meta.version, size: s.size || meta.size || 0 } : s)),
      };
    },
    { history: false },
  );
  setMeta(id, { status: 'ready', error: null, keywords: meta.keywords, summary: meta.summary, spillover: meta.spillover, warnings: meta.warnings, channels: meta.channels, datasetCount: meta.datasetCount, version: meta.version });
  const s = store.get();
  if (!s.ui.sampleId || !s.doc.samples.some((x) => x.id === s.ui.sampleId) || (s.meta[s.ui.sampleId] || {}).status !== 'ready') {
    if (!opts.keepCurrent || !s.ui.sampleId) setUI({ sampleId: id });
  }
  ensureDefaultPlot();
  scheduleSync();
  ensureCounts(id);
  if (meta.warnings && meta.warnings.length && !opts.quiet) toast(`${meta.name}: ${meta.warnings[0]}`, { kind: 'warn' });
}

function ensureDefaultPlot() {
  const s = store.get();
  if (s.doc.plots.length > 0) return;
  const chans = allChannels(s.doc);
  if (!chans.length) return;
  const fsc = chans.find((c) => /^fsc-a$/i.test(c.name)) || chans.find((c) => c.kind === 'scatter');
  const ssc = chans.find((c) => /^ssc-a$/i.test(c.name)) || chans.find((c) => c.kind === 'scatter' && c !== fsc);
  const x = fsc ? fsc.name : chans[0].name;
  const y = ssc ? ssc.name : chans[1] ? chans[1].name : null;
  addPlot({ pop: 'root', x, y, type: y ? 'pseudo' : 'hist' }, { focus: false });
}

/** Add data files (FCS or CSV) to the current workspace. */
export async function addFiles(fileList) {
  const files = [...fileList];
  const client = engine();
  if (!client) return;
  if (store.get().doc.isDemo && files.length) {
    // keep the demo intact: the user's own data starts a new workspace
    await newWorkspace();
    toast('Started a new workspace for your files. The demo stays available under Workspace → Open saved workspace.', { timeout: 7000 });
  }
  let added = 0;
  const skipped = [];
  const jobs = [];
  for (const file of files) {
    let fmt = null;
    try {
      fmt = await sniffFormat(file);
    } catch (e) {
      fmt = null;
    }
    if (!fmt) {
      if (!DATA_EXT.test(file.name)) skipped.push(file.name);
      else skipped.push(file.name);
      continue;
    }
    const s = store.get();
    const existing = s.doc.samples.find((x) => x.fileName === file.name && (s.meta[x.id] || {}).status !== 'ready');
    const dup = s.doc.samples.find((x) => x.fileName === file.name && (s.meta[x.id] || {}).status === 'ready');
    if (dup) {
      skipped.push(`${file.name} (already loaded)`);
      continue;
    }
    const id = existing ? existing.id : newId('s');
    if (!existing) {
      updateDoc(
        (d) => ({ ...d, samples: [...d.samples, { id, name: baseName(file.name), fileName: file.name, size: file.size, nEvents: 0, channels: [], groupIds: [], source: { type: 'file' } }] }),
        { history: false },
      );
    }
    setMeta(id, { status: 'loading', error: null });
    client.assign(id, Math.max(1, file.size));
    added++;
    jobs.push(
      (async () => {
        try {
          const buffer = await file.arrayBuffer();
          const wsId = store.get().doc.id;
          putFile(wsId, id, file, file.name).catch(() => {});
          const meta = await client.call(id, 'load', { name: baseName(file.name), buffer, format: fmt }, [buffer]);
          onLoaded(id, meta);
        } catch (e) {
          client.release(id, Math.max(1, file.size));
          setMeta(id, { status: 'error', error: e.message || String(e) });
          toast(`${file.name}: ${e.message || e}`, { kind: 'error', timeout: 8000 });
        }
      })(),
    );
  }
  if (skipped.length) toast(`Skipped ${skipped.length} file${skipped.length > 1 ? 's' : ''}: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}`, { kind: 'warn' });
  await Promise.all(jobs);
  if (added) saveNow();
  return added;
}

/** Load (or reload) one demo sample into the engine. */
async function loadDemoSample(entry) {
  const client = engine();
  setMeta(entry.id, { status: 'loading', error: null });
  client.assign(entry.id, entry.source.spec.events * 50);
  try {
    const meta = await client.call(entry.id, 'loadDemo', { name: entry.name, spec: entry.source.spec });
    onLoaded(entry.id, meta, { keepCurrent: true, quiet: true });
  } catch (e) {
    setMeta(entry.id, { status: 'error', error: e.message || String(e) });
  }
}

/** Replace the state with a fresh workspace. */
export function resetState(doc) {
  const client = engine();
  const old = store.get();
  if (client && old) {
    for (const smp of old.doc.samples) {
      client.call(smp.id, 'unload', {}).catch(() => {});
      client.release(smp.id);
      markLoaded(smp.id, false);
    }
  }
  const base = initialState();
  // View preferences (which tab is open, how wide the sidebar is) are the
  // person's own setting, not part of any one workspace, so they survive
  // opening a different workspace or template.
  store.set({
    ...base,
    engine: old ? old.engine : base.engine,
    persist: old ? { ...old.persist, status: 'idle' } : base.persist,
    doc,
    ui: { ...base.ui, view: old ? old.ui.view : 'gating', sidebarWidth: old ? old.ui.sidebarWidth : base.ui.sidebarWidth },
  });
}

/** Build the demo workspace: simulated PBMC panel with a full gating template. */
export async function openDemo({ name = 'Demo · 7-colour PBMC panel' } = {}) {
  const doc = emptyDoc(name);
  doc.isDemo = true;
  const manifest = demoManifest();
  const groups = [
    { id: newId('grp'), name: 'Samples' },
    { id: newId('grp'), name: 'Compensation' },
  ];
  doc.groups = groups;
  doc.samples = manifest.map((m) => ({
    id: newId('s'),
    name: m.name,
    fileName: `${m.name}.fcs`,
    size: 0,
    nEvents: m.events,
    channels: [],
    groupIds: [m.group === 'Samples' ? groups[0].id : groups[1].id],
    source: { type: 'demo', spec: { kind: m.kind, donor: m.donor, dye: m.dye, seed: m.seed, events: m.events, name: m.name } },
  }));
  const tpl = buildDemoTemplate(doc);
  Object.assign(doc, tpl);
  resetState(doc);
  setUI({ sampleId: doc.samples[0].id });
  markSaved(null);
  const first = doc.samples[0];
  await loadDemoSample(first);
  await Promise.all(doc.samples.slice(1).map((s) => loadDemoSample(s)));
  saveNow();
}

/** Open a workspace saved in this browser. */
export async function openSavedWorkspace(id) {
  const rec = await loadWorkspaceRecord(id);
  if (!rec) throw new Error('That workspace is no longer saved in this browser.');
  await openWorkspaceDoc(rec.doc, { fromLibrary: true });
}

/** Open a workspace document (from the library or a file). */
export async function openWorkspaceDoc(raw, { fromLibrary = false } = {}) {
  const doc = migrateDoc(raw);
  if (!fromLibrary) {
    // A file import becomes a new copy in the library.
    doc.id = newId('ws');
  }
  resetState(doc);
  markSaved(fromLibrary ? doc : null);
  const s = store.get();
  setUI({ sampleId: s.doc.samples[0] ? s.doc.samples[0].id : null });
  const missing = [];
  await Promise.all(
    doc.samples.map(async (smp) => {
      if (smp.source && smp.source.type === 'demo') return loadDemoSample(smp);
      const blob = fromLibrary ? await getFile(doc.id, smp.id) : null;
      if (!blob) {
        setMeta(smp.id, { status: 'missing' });
        missing.push(smp.fileName);
        return;
      }
      const client = engine();
      setMeta(smp.id, { status: 'loading' });
      client.assign(smp.id, Math.max(1, blob.size));
      try {
        const buffer = await blob.arrayBuffer();
        const fmt = /\.(csv|tsv|txt)$/i.test(smp.fileName) ? 'csv' : 'fcs';
        const meta = await client.call(smp.id, 'load', { name: smp.name, buffer, format: fmt }, [buffer]);
        onLoaded(smp.id, meta, { keepCurrent: true, quiet: true });
      } catch (e) {
        setMeta(smp.id, { status: 'error', error: e.message || String(e) });
      }
    }),
  );
  if (!fromLibrary) saveNow();
  return { missing };
}

/** Restore the last workspace on startup, or open the demo the first time. */
export async function restoreLast() {
  const id = await getKV('lastWorkspace');
  if (id) {
    try {
      await openSavedWorkspace(id);
      return 'restored';
    } catch (e) {
      /* fall through */
    }
  }
  await openDemo();
  return 'demo';
}

export async function newWorkspace() {
  await saveNow();
  const doc = emptyDoc('Untitled workspace');
  resetState(doc);
  markSaved(null);
  saveNow();
}

export async function duplicateWorkspace() {
  await saveNow();
  const s = store.get();
  const copy = JSON.parse(JSON.stringify(s.doc));
  const oldId = copy.id;
  copy.id = newId('ws');
  copy.name = `${s.doc.name} (copy)`;
  delete copy.isDemo;
  copy.created = Date.now();
  await copyFiles(oldId, copy.id, copy.samples.map((x) => x.id));
  await openWorkspaceDoc(copy, { fromLibrary: true });
  saveNow();
}

/** Remove samples from the workspace and the engine. */
export function unloadSamples(ids) {
  const client = engine();
  const s = store.get();
  for (const id of ids) {
    if (client) {
      client.call(id, 'unload', {}).catch(() => {});
      client.release(id);
    }
    markLoaded(id, false);
    deleteFile(s.doc.id, id);
  }
}

// ------------------------------------------------------------------ templates

/** The reusable part of a workspace: no samples, no per-sample adjustments. */
/** Files saved before the project was renamed used "laminar-*" formats. */
export function legacyFormat(obj) {
  if (obj && typeof obj.format === 'string' && obj.format.startsWith('laminar-')) return { ...obj, format: obj.format.replace(/^laminar-/, 'kestrel-') };
  return obj;
}

export function makeTemplate(doc, name) {
  return {
    format: 'kestrel-template',
    schema: SCHEMA,
    app: { name: APP.name, version: APP.version },
    name: name || `${doc.name} template`,
    created: new Date().toISOString(),
    transforms: doc.transforms,
    comp: { matrices: doc.comp.matrices, default: doc.comp.default },
    derived: doc.derived || [],
    gates: orderGates(doc.gates).ordered,
    plots: doc.plots,
    table: { columns: doc.table.columns },
    layout: { plotIds: doc.layout.plotIds, size: doc.layout.size, transpose: doc.layout.transpose, overlays: doc.layout.overlays || [] },
    settings: doc.settings,
    groups: doc.groups.map((g) => ({ id: g.id, name: g.name })),
    channelLabels: doc.channelLabels || {},
  };
}

export function workspaceFile(doc) {
  return {
    format: 'kestrel-workspace',
    schema: SCHEMA,
    app: { name: APP.name, version: APP.version },
    savedAt: new Date().toISOString(),
    ...JSON.parse(JSON.stringify(doc)),
  };
}

/** Apply a template to the current workspace (keeps samples). */
export function applyTemplate(tpl) {
  const t = migrateTemplate(tpl);
  updateDoc((d) => {
    const next = { ...d };
    const gates = {};
    for (const g of t.gates) gates[g.id] = g;
    next.gates = gates;
    next.gateOrder = t.gates.map((g) => g.id);
    next.overrides = {};
    next.transforms = { ...d.transforms, ...t.transforms };
    next.derived = t.derived || [];
    next.comp = { matrices: t.comp.matrices || [], default: t.comp.default || 'file', perSample: {} };
    if (next.comp.default !== 'file' && next.comp.default !== 'none' && !next.comp.matrices.some((m) => m.id === next.comp.default)) next.comp.default = 'file';
    next.plots = t.plots || [];
    next.table = { ...d.table, columns: (t.table && t.table.columns) || [] };
    next.layout = { ...d.layout, ...(t.layout || {}) };
    next.settings = { ...DEFAULT_SETTINGS, ...(t.settings || {}) };
    next.channelLabels = { ...d.channelLabels, ...(t.channelLabels || {}) };
    const groups = d.groups.slice();
    for (const g of t.groups || []) if (!groups.some((x) => x.name === g.name)) groups.push({ id: g.id || newId('grp'), name: g.name });
    next.groups = groups;
    return next;
  });
  setUI({ selectedGate: null });
}

export function migrateTemplate(raw) {
  raw = legacyFormat(raw);
  if (!raw || typeof raw !== 'object') throw new Error('This file is not a Kestrel template.');
  if (raw.format === 'kestrel-workspace') return { ...raw, gates: Object.values(raw.gates || {}) };
  if (raw.format !== 'kestrel-template') throw new Error('This file is not a Kestrel template.');
  if ((raw.schema || 1) > SCHEMA) throw new Error('This template was made by a newer version of Kestrel.');
  return {
    transforms: raw.transforms || {},
    comp: raw.comp || { matrices: [], default: 'file' },
    derived: Array.isArray(raw.derived) ? raw.derived : [],
    gates: Array.isArray(raw.gates) ? raw.gates : Object.values(raw.gates || {}),
    plots: raw.plots || [],
    table: raw.table || { columns: [] },
    layout: raw.layout || {},
    settings: raw.settings || {},
    groups: raw.groups || [],
    channelLabels: raw.channelLabels || {},
  };
}

export function migrateDoc(raw) {
  raw = legacyFormat(raw);
  if (!raw || typeof raw !== 'object') throw new Error('This file is not a Kestrel workspace.');
  if (raw.format && raw.format !== 'kestrel-workspace') {
    if (raw.format === 'kestrel-template') throw new Error('This is a template. Use "Apply template" instead.');
    throw new Error('This file is not a Kestrel workspace.');
  }
  if ((raw.schema || 1) > SCHEMA) throw new Error('This workspace was made by a newer version of Kestrel.');
  const base = emptyDoc(raw.name || 'Workspace');
  const doc = { ...base };
  for (const k of ['id', 'name', 'created', 'modified', 'samples', 'isDemo', ...ANALYSIS_KEYS]) if (raw[k] !== undefined) doc[k] = raw[k];
  doc.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  doc.layout = { ...base.layout, ...(raw.layout || {}) };
  doc.table = { ...base.table, ...(raw.table || {}) };
  doc.comp = { ...base.comp, ...(raw.comp || {}) };
  doc.samples = (doc.samples || []).map((s) => ({ groupIds: [], channels: [], ...s }));
  doc.derived = Array.isArray(doc.derived) ? doc.derived : [];
  if (!doc.id) doc.id = newId('ws');
  return doc;
}
