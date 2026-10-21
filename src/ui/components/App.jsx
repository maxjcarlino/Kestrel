// Application shell.

import { useEffect, useState } from 'preact/hooks';
import { useSel } from '../state/store.js';
import { setUI, toast } from '../state/doc.js';
import { addFiles, openWorkspaceDoc, applyTemplate, legacyFormat } from '../state/loader.js';
import { saveNow } from '../state/persist.js';
import { applyGatingML } from '../state/workspace-actions.js';
import { Header } from './Header.jsx';
import { Sidebar } from './Sidebar.jsx';
import { GatingView, useGlobalKeys } from './GatingView.jsx';
import { CompView } from './CompView.jsx';
import { TableView } from './TableView.jsx';
import { LayoutView } from './LayoutView.jsx';
import { BatchView } from './BatchView.jsx';
import { KeywordsView } from './KeywordsView.jsx';
import { DialogHost } from './Dialogs.jsx';
import { MenuHost, Toasts, Icon } from './ui.jsx';

function hasFiles(e) {
  return e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
}

/**
 * Handle dropped (or otherwise obtained) files the way the app's own drop
 * zone does: workspace/template JSON, Gating-ML XML, or FCS/CSV data.
 * `files` only needs `.name` and an async `.text()` — a real `File`, or
 * anything shaped like one (see main.jsx's query-string workspace opener).
 */
export async function routeDropped(files) {
  const data = [];
  for (const f of files) {
    if (/\.json$/i.test(f.name)) {
      try {
        const obj = legacyFormat(JSON.parse(await f.text()));
        if (obj.format === 'kestrel-template') {
          applyTemplate(obj);
          toast(`Applied template from ${f.name}`);
        } else if (obj.format === 'kestrel-workspace') {
          await saveNow();
          const { missing } = await openWorkspaceDoc(obj, { fromLibrary: false });
          toast(missing.length ? `Opened workspace. Add its ${missing.length} data file${missing.length > 1 ? 's' : ''} to see the data.` : 'Opened workspace');
        } else toast(`${f.name} is not a Kestrel workspace or template.`, { kind: 'warn' });
      } catch (e) {
        toast(`${f.name}: ${e.message}`, { kind: 'error' });
      }
    } else if (/\.xml$/i.test(f.name)) {
      try {
        applyGatingML(await f.text(), f.name);
      } catch (e) {
        toast(`Could not import ${f.name}: ${e.message}`, { kind: 'error', timeout: 9000 });
      }
    } else data.push(f);
  }
  if (data.length) addFiles(data);
}

export function App() {
  const view = useSel((s) => s.ui.view);
  const [drag, setDrag] = useState(false);
  useGlobalKeys();

  useEffect(() => {
    let depth = 0;
    const enter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDrag(true);
    };
    const over = (e) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDrag(false);
    };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDrag(false);
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) routeDropped(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  useEffect(() => {
    try {
      if (location.hash.replace('#', '') !== view) history.replaceState(null, '', `#${view}`);
    } catch (e) {
      /* some hosts do not allow it */
    }
  }, [view]);

  const withSidebar = view === 'gating' || view === 'keywords';
  return (
    <div class="app">
      <Header />
      <main class={`app-body view-${view}`}>
        {withSidebar ? <Sidebar /> : null}
        <div class="view">
          {view === 'gating' ? <GatingView /> : null}
          {view === 'comp' ? <CompView /> : null}
          {view === 'table' ? <TableView /> : null}
          {view === 'batch' ? <BatchView /> : null}
          {view === 'layout' ? <LayoutView /> : null}
          {view === 'keywords' ? <KeywordsView /> : null}
        </div>
      </main>
      {drag ? (
        <div class="drop-overlay" aria-hidden="true">
          <div class="drop-card">
            <Icon name="upload" size={26} />
            <b>Drop to add</b>
            <span>FCS or CSV data, a workspace or template (.json), or Gating-ML (.xml)</span>
          </div>
        </div>
      ) : null}
      <MenuHost />
      <DialogHost />
      <Toasts />
    </div>
  );
}

export { setUI };
