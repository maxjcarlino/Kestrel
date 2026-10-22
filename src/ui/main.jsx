// Entry point.

import { render } from 'preact';
import { store } from './state/store.js';
import { initialState, setUI, toast, APP } from './state/doc.js';
import { countsVersion } from './state/derived.js';
import { initEngine, installSync, scheduleSync } from './state/bridge.js';
import { installAutosave, storageAvailable, getKV } from './state/persist.js';
import { restoreLast, addFiles, migrateDoc } from './state/loader.js';
import { installThemeWatch } from './theme.js';
import { prewarmDownloads } from './util/download.js';
import { App, routeDropped } from './components/App.jsx';
import { openDialog } from './components/ui.jsx';
import { loadFromLauncher, missingSamples } from './state/locate.js';

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
  // A local "open with Kestrel" launcher (see scripts/open-workspace.mjs) serves
  // this page, the double-clicked file at /__workspace, and any of its data
  // files it found next to it, and points the browser here with
  // ?openWorkspace=1. A workspace opens straight away (without first loading
  // the last one); a template is applied to the last workspace, as a drop
  // would be. The query string is then dropped so a reload doesn't reopen it.
  let launched = null;
  if (new URLSearchParams(location.search).get('openWorkspace') === '1') {
    try {
      const res = await fetch('/__workspace', { cache: 'no-store' });
      if (!res.ok) throw new Error(`the launcher's local server returned ${res.status}`);
      const text = await res.text();
      const name = decodeURIComponent(res.headers.get('X-Kestrel-Filename') || 'workspace.kestrel.json');
      // Only skip loading the last workspace when this one will open; a
      // template, or a file that isn't valid, goes through the usual drop path.
      let isWorkspace = false;
      try {
        const obj = JSON.parse(text);
        if (obj.format !== 'kestrel-template') {
          migrateDoc(obj);
          isWorkspace = true;
        }
      } catch (e) {
        isWorkspace = false;
      }
      launched = { name, text, isWorkspace };
    } catch (e) {
      toast(`Could not open the file: ${e.message}`, { kind: 'error' });
    }
    history.replaceState(null, '', location.pathname + location.hash);
  }
  if (!launched || !launched.isWorkspace) {
    try {
      await restoreLast();
    } catch (e) {
      toast(`Could not open the last workspace: ${e.message}`, { kind: 'error' });
    }
  }
  if (launched) {
    await routeDropped([{ name: launched.name, text: async () => launched.text }], { locate: false });
    const manifest = launched.isWorkspace ? await loadFromLauncher() : (fetch('/__done').catch(() => {}), null);
    if (launched.isWorkspace && missingSamples().length) openDialog('locateFiles', { dir: manifest ? manifest.dir : null });
  }
  scheduleSync();
  if (info.mode === 'main') toast('Background threads are not available here, so large files will be slower.', { kind: 'warn' });
})();
