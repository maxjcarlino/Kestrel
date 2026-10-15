// Entry point.

import { render } from 'preact';
import { store } from './state/store.js';
import { initialState, setUI, toast, APP } from './state/doc.js';
import { initEngine, installSync, scheduleSync } from './state/bridge.js';
import { installAutosave, storageAvailable } from './state/persist.js';
import { restoreLast, addFiles } from './state/loader.js';
import { installThemeWatch } from './theme.js';
import { prewarmDownloads } from './util/download.js';
import { App } from './components/App.jsx';

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
};

(async () => {
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
  scheduleSync();
  if (info.mode === 'main') toast('Background threads are not available here, so large files will be slower.', { kind: 'warn' });
})();
