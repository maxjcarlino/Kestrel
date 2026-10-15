// Autosave and the local workspace library (IndexedDB, per browser).
//
// Workspaces (gates, scales, compensation, layouts) are saved after every
// change and whenever the view changes. Copies of the data files are kept
// alongside so a workspace reopens with its data; nothing leaves the device.

import { store } from './store.js';

const DB_NAME = 'kestrel';
const DB_VERSION = 1;
let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
      setTimeout(() => resolve(null), 5000);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  if (!db) throw new Error('Browser storage is not available.');
  return new Promise((resolve, reject) => {
    let result;
    const t = db.transaction(storeName, mode);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
    Promise.resolve(fn(t.objectStore(storeName))).then((r) => (result = r), reject);
  });
}

export async function storageAvailable() {
  return !!(await openDB());
}

/** Serialise the document for storage (plain JSON). */
export function serializeDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

export async function saveWorkspace(doc) {
  const record = {
    id: doc.id,
    name: doc.name,
    modified: doc.modified,
    created: doc.created,
    nSamples: doc.samples.length,
    nGates: Object.keys(doc.gates).length,
    doc: serializeDoc(doc),
  };
  await tx('workspaces', 'readwrite', (st) => st.put(record));
  await setKV('lastWorkspace', doc.id);
  return record;
}

export async function listWorkspaces() {
  try {
    const all = await tx('workspaces', 'readonly', (st) => req(st.getAll()));
    return (all || []).map((r) => ({ id: r.id, name: r.name, modified: r.modified, created: r.created, nSamples: r.nSamples, nGates: r.nGates })).sort((a, b) => b.modified - a.modified);
  } catch (e) {
    return [];
  }
}

export async function loadWorkspaceRecord(id) {
  return tx('workspaces', 'readonly', (st) => req(st.get(id)));
}

export async function deleteWorkspace(id) {
  await tx('workspaces', 'readwrite', (st) => st.delete(id));
  await tx('files', 'readwrite', (st) => {
    const range = IDBKeyRange.bound(id + '/', id + '/￿');
    return req(st.delete(range));
  });
}

export async function putFile(wsId, sampleId, blob, name) {
  return tx('files', 'readwrite', (st) => st.put({ key: `${wsId}/${sampleId}`, name, size: blob.size, blob }));
}

export async function getFile(wsId, sampleId) {
  try {
    const r = await tx('files', 'readonly', (st) => req(st.get(`${wsId}/${sampleId}`)));
    return r ? r.blob : null;
  } catch (e) {
    return null;
  }
}

export async function deleteFile(wsId, sampleId) {
  try {
    await tx('files', 'readwrite', (st) => st.delete(`${wsId}/${sampleId}`));
  } catch (e) {
    /* ignore */
  }
}

export async function copyFiles(fromWs, toWs, ids) {
  for (const id of ids) {
    const b = await getFile(fromWs, id);
    if (b) await putFile(toWs, id, b, '');
  }
}

export async function setKV(k, v) {
  try {
    await tx('kv', 'readwrite', (st) => st.put({ k, v }));
  } catch (e) {
    /* ignore */
  }
}

export async function getKV(k) {
  try {
    const r = await tx('kv', 'readonly', (st) => req(st.get(k)));
    return r ? r.v : undefined;
  } catch (e) {
    return undefined;
  }
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (e) {
    /* ignore */
  }
  return null;
}

// ------------------------------------------------------------------ autosave

let timer = null;
let saving = false;
let pending = false;
let lastSavedDoc = null;

function setPersist(patch) {
  store.set((s) => ({ ...s, persist: { ...s.persist, ...patch } }));
}

export async function saveNow() {
  clearTimeout(timer);
  timer = null;
  const s = store.get();
  if (!s || s.persist.available === false) return;
  if (s.doc === lastSavedDoc) return;
  if (saving) {
    pending = true;
    return;
  }
  saving = true;
  const doc = s.doc;
  setPersist({ status: 'saving' });
  try {
    await saveWorkspace(doc);
    lastSavedDoc = doc;
    setPersist({ status: 'saved', savedAt: Date.now(), error: null });
  } catch (e) {
    setPersist({ status: 'error', error: e.message || String(e) });
  } finally {
    saving = false;
    if (pending) {
      pending = false;
      saveNow();
    }
  }
}

export function markSaved(doc) {
  lastSavedDoc = doc;
}

export function scheduleSave(delay = 700) {
  clearTimeout(timer);
  timer = setTimeout(saveNow, delay);
  const s = store.get();
  if (s.persist.status !== 'saving' && s.persist.available !== false) setPersist({ status: 'pending' });
}

export function installAutosave() {
  store.subscribe((s, prev, meta) => {
    if (!prev || s.persist.available === false) return;
    if (s.doc !== prev.doc) {
      if (meta.transient || s.txn) return;
      scheduleSave();
    }
    if (s.ui.view !== prev.ui.view) saveNow();
  });
  const flushOnHide = () => {
    if (document.visibilityState === 'hidden') saveNow();
  };
  document.addEventListener('visibilitychange', flushOnHide);
  window.addEventListener('pagehide', () => saveNow());
}
