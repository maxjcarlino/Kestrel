// Top bar: brand, active workspace (click to rename), save status, views, undo.

import { useEffect, useState } from 'preact/hooks';
import { useSel } from '../state/store.js';
import { setUI, renameWorkspace, undo, redo, APP } from '../state/doc.js';
import { saveNow } from '../state/persist.js';
import { newWorkspace, duplicateWorkspace, openDemo } from '../state/loader.js';
import { saveWorkspaceFile, importWorkspaceFile, saveTemplateFile, applyTemplateFile, exportGatingMLFile, importGatingMLFile } from '../state/workspace-actions.js';
import { Icon, IconButton, openMenu, rectOf, openDialog } from './ui.jsx';
import { KESTREL_SVG } from '../assets/kestrel-mark.js';

export const VIEWS = [
  { id: 'gating', label: 'Gating', icon: 'gates' },
  { id: 'comp', label: 'Compensation', icon: 'matrix' },
  { id: 'table', label: 'Statistics', icon: 'table' },
  { id: 'batch', label: 'Batch', icon: 'layers' },
  { id: 'layout', label: 'Layout', icon: 'grid' },
  { id: 'keywords', label: 'Keywords', icon: 'tag' },
];

function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function SaveStatus() {
  const p = useSel((s) => s.persist);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);
  let label;
  let cls;
  let title;
  if (p.available === false) {
    label = 'Autosave off';
    cls = 'is-off';
    title = 'This browser is not letting the page store data, so changes are not saved automatically. Use Workspace → Save workspace file.';
  } else if (p.status === 'saving') {
    label = 'Saving…';
    cls = 'is-saving';
    title = 'Saving to this browser';
  } else if (p.status === 'pending') {
    label = 'Unsaved';
    cls = 'is-pending';
    title = 'Changes will be saved in a moment';
  } else if (p.status === 'error') {
    label = 'Save failed';
    cls = 'is-error';
    title = p.error || 'Autosave failed';
  } else if (p.status === 'saved') {
    label = `Saved ${ago(p.savedAt)}`;
    cls = 'is-saved';
    title = `Saved in this browser at ${new Date(p.savedAt).toLocaleTimeString()}`;
  } else {
    label = 'Autosave on';
    cls = 'is-idle';
    title = 'Workspaces are saved in this browser after every change';
  }
  return (
    <button type="button" class={`save-chip ${cls}`} title={title} onClick={() => saveNow()} aria-label={`${label}. Save now`}>
      <span class="save-dot" />
      <span>{label}</span>
    </button>
  );
}

function WorkspaceName() {
  const name = useSel((s) => s.doc.name);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  useEffect(() => setVal(name), [name]);
  if (editing) {
    return (
      <input
        class="ws-name-input"
        value={val}
        aria-label="Workspace name"
        ref={(el) => {
          if (el && document.activeElement !== el) {
            el.focus();
            el.select();
          }
        }}
        onInput={(e) => setVal(e.currentTarget.value)}
        onBlur={() => {
          renameWorkspace(val);
          setEditing(false);
          saveNow();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setVal(name);
            setEditing(false);
          }
          e.stopPropagation();
        }}
        size={Math.max(8, Math.min(48, val.length + 2))}
      />
    );
  }
  return (
    <button type="button" class="ws-name" onClick={() => setEditing(true)} title="Rename workspace" aria-label={`Workspace: ${name}. Rename`}>
      <span class="ws-name-text">{name}</span>
      <Icon name="pencil" size={13} class="ws-name-pencil" />
    </button>
  );
}

function workspaceMenu(anchor) {
  openMenu(anchor, [
    { heading: 'Workspace' },
    { label: 'New workspace', icon: 'plus', onClick: () => newWorkspace() },
    { label: 'Open saved workspace…', icon: 'folder', onClick: () => openDialog('workspaces') },
    { label: 'Duplicate this workspace', icon: 'copy', onClick: () => duplicateWorkspace() },
    { label: 'Rename', icon: 'pencil', onClick: () => document.querySelector('.ws-name') && document.querySelector('.ws-name').click() },
    { divider: true },
    { label: 'Save workspace file (.json)', icon: 'download', onClick: () => saveWorkspaceFile() },
    { label: 'Open workspace file…', icon: 'upload', onClick: () => importWorkspaceFile() },
    { divider: true },
    { heading: 'Workflow template' },
    { label: 'Save as template (.json)', icon: 'download', onClick: () => saveTemplateFile() },
    { label: 'Apply template to these samples…', icon: 'upload', onClick: () => applyTemplateFile() },
    { divider: true },
    { heading: 'Gating-ML 2.0' },
    { label: 'Export gates (.xml)', icon: 'download', onClick: () => exportGatingMLFile() },
    { label: 'Import gates…', icon: 'upload', onClick: () => importGatingMLFile() },
    { divider: true },
    { label: 'Open the demo experiment', icon: 'flask', onClick: () => openDemo() },
  ]);
}

export function Header() {
  const view = useSel((s) => s.ui.view);
  const canUndo = useSel((s) => s.history.past.length > 0);
  const canRedo = useSel((s) => s.history.future.length > 0);
  const engine = useSel((s) => s.engine);
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand" title={`${APP.name} ${APP.version}`}>
          <span class="brand-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: KESTREL_SVG }} />
          <span class="brand-word">Kestrel</span>
        </div>
        <div class="ws">
          <span class="ws-label">Workspace</span>
          <WorkspaceName />
          <IconButton icon="down" label="Workspace menu" class="ws-menu" onClick={(e) => workspaceMenu(rectOf(e.currentTarget))} />
          <SaveStatus />
        </div>
        <nav class="views" aria-label="Views">
          {VIEWS.map((v) => (
            <button type="button" class={`view-tab ${view === v.id ? 'is-on' : ''}`} aria-current={view === v.id ? 'page' : undefined} onClick={() => setUI({ view: v.id, menu: null })} key={v.id}>
              <Icon name={v.icon} size={15} />
              <span>{v.label}</span>
            </button>
          ))}
        </nav>
        <div class="topbar-tools">
          <IconButton icon="undo" label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo} />
          <IconButton icon="redo" label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo} />
          <span class={`engine-chip ${engine.busy > 0 ? 'is-busy' : ''}`} title={engine.mode === 'workers' ? `Computing on ${engine.workers} background threads` : engine.mode === 'main' ? 'Computing on the main thread (background threads unavailable here)' : 'Starting'}>
            <Icon name="bolt" size={13} />
            <span>{engine.mode === 'workers' ? `${engine.workers}×` : engine.mode === 'main' ? '1×' : '…'}</span>
          </span>
          <IconButton icon="help" label="Help and shortcuts" onClick={() => openDialog('help')} />
        </div>
      </div>
    </header>
  );
}
