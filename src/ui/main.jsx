// Entry point.

import { render } from 'preact';
import { store } from './state/store.js';
import { initialState, setUI, toast, APP } from './state/doc.js';
import { countsVersion } from './state/derived.js';
import { initEngine, installSync, scheduleSync } from './state/bridge.js';
import { installAutosave, storageAvailable, getKV } from './state/persist.js';
import { restoreLast, addFiles } from './state/loader.js';
import { installThemeWatch } from './theme.js';
import { prewarmDownloads } from './util/download.js';
import { App, routeDropped } from './components/App.jsx';

/* global __WORKER_SOURCE__ */
const WORKER_SOURCE = typeof __WORKER_SOURCE__ === 'string' ? __WORKER_SOURCE__ : '';

store.set(initialState());
const hash = (location.hash || '').replace('#', '');
if (['gating', 'comp', 'table', 'batch', 'layout', 'keywords'].includes(hash)) setUI({ view: hash });
installThemeWatch();
render(<App />, document.getElementById('app'));

// Small scripting surface for power users and automated tests (browser console: kestrel.state()).
window.kestrel = {
  version: APP.version,
  state: () => store.get(),
  addFiles: (files) => addFiles(files),
  countsVersion: (state, sampleId) => countsVersion(state, sampleId),
};

(async () => {
  const savedWidth = await getKV('sidebarWidth');
  if (Number.isFinite(savedWidth)) setUI({ sidebarWidth: savedWidth });
  prewarmDownloads();
  const info = await initEngine(WORKER_SOURCE);
  installSync();
  const ok = await storageAvailable();
  if (!ok) store.set((s) => ({ ...s, persist: { ...s.persist, available: false, status: 'off' } }));
  installAutosave();
  try {
    await restoreLast();
  } catch (e) {
    toast(`Could not open the last workspace: ${e.message}`, { kind: 'error' });
  }
  // A local "open with Kestrel" launcher (see scripts/open-workspace.mjs) serves
  // this page plus the double-clicked file at /__workspace and points the
  // browser here with ?openWorkspace=1, so the file opens the way a drag-drop
  // would, then the query string is dropped so a reload doesn't reopen it.
  if (new URLSearchParams(location.search).get('openWorkspace') === '1') {
    try {
      const res = await fetch('/__workspace');
      if (!res.ok) throw new Error(`the launcher's local server returned ${res.status}`);
      const text = await res.text();
      const name = res.headers.get('X-Kestrel-Filename') || 'workspace.kestrel.json';
      await routeDropped([{ name, text: async () => text }]);
    } catch (e) {
      toast(`Could not open the file: ${e.message}`, { kind: 'error' });
    }
    history.replaceState(null, '', location.pathname + location.hash);
  }
  scheduleSync();
  if (info.mode === 'main') toast('Background threads are not available here, so large files will be slower.', { kind: 'warn' });
})();
