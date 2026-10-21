// Left panel: samples (with groups) and the population hierarchy.

import { useMemo, useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { setUI, renameSample, removeSamples, toggleSampleGroup, groupByKeyword, setSampleComp, renameGate, samplesInGroup, hasOverride } from '../state/doc.js';
import { addFiles, unloadSamples } from '../state/loader.js';
import { frequency, compChoice, popName } from '../state/derived.js';
import { drillDown, gateMenuItems, exportPopulation } from '../state/gating.js';
import { formatStat } from '../../core/stats.js';
import { ROOT } from '../../core/gates.js';
import { Icon, IconButton, openMenu, rectOf, openDialog, TextField, FitText } from './ui.jsx';
import { pickFiles } from '../util/download.js';
import { setKV } from '../state/persist.js';

const SIDEBAR_DEFAULT = 304;
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;

export function Sidebar() {
  const width = useSel((s) => s.ui.sidebarWidth || SIDEBAR_DEFAULT);
  const setWidth = (w) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
    setUI({ sidebarWidth: clamped });
    return clamped;
  };
  const onResizeStart = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev) => setWidth(startW + (ev.clientX - startX));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setKV('sidebarWidth', store.get().ui.sidebarWidth || startW);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const onResizeKey = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const w = setWidth(width + (e.key === 'ArrowRight' ? 16 : -16));
      setKV('sidebarWidth', w);
    }
  };
  const reset = () => setKV('sidebarWidth', setWidth(SIDEBAR_DEFAULT));
  return (
    <>
      <aside class="sidebar" aria-label="Samples and populations" style={{ '--sidebar-w': `${width}px` }}>
        <SamplesPanel />
        <PopulationTree />
      </aside>
      <div
        class="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuenow={Math.round(width)}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onMouseDown={onResizeStart}
        onDblClick={reset}
        onKeyDown={onResizeKey}
      />
    </>
  );
}

const STATUS_LABEL = { loading: 'Loading', ready: 'Loaded', missing: 'Data file not loaded', error: 'Could not read file' };

export async function chooseFiles() {
  const files = await pickFiles({ accept: '.fcs,.lmd,.csv,.tsv,.txt' });
  if (files.length) addFiles(files);
}

function sampleMenu(anchor, smp) {
  const s = store.get();
  const doc = s.doc;
  const choice = compChoice(doc, smp.id);
  const own = doc.comp.perSample[smp.id] !== undefined;
  openMenu(
    anchor,
    [
      { label: 'Show this sample', icon: 'eye', onClick: () => setUI({ sampleId: smp.id }) },
      { label: 'Rename', icon: 'pencil', onClick: () => setUI({ renamingSample: smp.id }) },
      {
        label: 'Groups',
        icon: 'layers',
        submenu: [
          ...doc.groups.map((g) => ({ label: g.name, checked: (smp.groupIds || []).includes(g.id), onClick: () => toggleSampleGroup(smp.id, g.id) })),
          { label: 'New group with this sample…', onClick: () => openDialog('group', { sampleIds: [smp.id] }) },
        ],
      },
      {
        label: 'Compensation',
        icon: 'matrix',
        submenu: [
          { label: 'Use workspace default', checked: !own, onClick: () => setSampleComp(smp.id, null) },
          { label: 'Acquisition matrix (from file)', checked: own && choice === 'file', onClick: () => setSampleComp(smp.id, 'file') },
          { label: 'None', checked: own && choice === 'none', onClick: () => setSampleComp(smp.id, 'none') },
          ...doc.comp.matrices.map((m) => ({ label: m.name, checked: own && choice === m.id, onClick: () => setSampleComp(smp.id, m.id) })),
        ],
      },
      {
        label: 'Export all events',
        icon: 'download',
        submenu: [
          { label: 'FCS file', onClick: () => exportPopulation(smp.id, ROOT, 'fcs') },
          { label: 'CSV table', onClick: () => exportPopulation(smp.id, ROOT, 'csv') },
        ],
      },
      { divider: true },
      {
        label: 'Remove from workspace',
        icon: 'trash',
        danger: true,
        onClick: () => {
          unloadSamples([smp.id]);
          removeSamples([smp.id]);
        },
      },
    ],
    { title: smp.name },
  );
}

function SamplesPanel() {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const current = useSel((s) => s.ui.sampleId);
  const renaming = useSel((s) => s.ui.renamingSample);
  const [groupId, setGroupId] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const list = samplesInGroup(doc, groupId);
  const missing = doc.samples.filter((x) => (meta[x.id] || {}).status === 'missing');
  const groupName = (id) => (doc.groups.find((g) => g.id === id) || {}).name;

  return (
    <section class={`panel samples ${collapsed ? 'is-collapsed' : ''}`} aria-label="Samples">
      <header class="panel-head">
        <button type="button" class="panel-title" onClick={() => setCollapsed(!collapsed)} aria-expanded={collapsed ? 'false' : 'true'}>
          <Icon name={collapsed ? 'right' : 'down'} size={12} />
          <span>Samples</span>
          <span class="count num">{doc.samples.length}</span>
        </button>
        <div class="panel-tools">
          <IconButton
            icon="layers"
            label="Groups"
            onClick={(e) =>
              openMenu(rectOf(e.currentTarget), [
                { heading: 'Show' },
                { label: 'All samples', checked: !groupId, onClick: () => setGroupId(null) },
                ...doc.groups.map((g) => ({ label: g.name, checked: groupId === g.id, onClick: () => setGroupId(g.id) })),
                { divider: true },
                { label: 'New group…', icon: 'plus', onClick: () => openDialog('group', { sampleIds: [] }) },
                { label: 'Group by keyword…', icon: 'tag', onClick: () => openDialog('groupByKeyword') },
                ...(doc.groups.length ? [{ label: 'Manage groups…', icon: 'gear', onClick: () => openDialog('groups') }] : []),
              ])
            }
          />
          <button type="button" class="btn btn-primary btn-sm" onClick={chooseFiles}>
            <Icon name="plus" size={14} />
            <span>Add files</span>
          </button>
        </div>
      </header>
      {!collapsed ? (
        <>
          {doc.groups.length ? (
            <div class="chips" role="tablist" aria-label="Filter samples by group">
              <button type="button" role="tab" aria-selected={!groupId ? 'true' : 'false'} class={`chip ${!groupId ? 'is-on' : ''}`} onClick={() => setGroupId(null)}>
                All
              </button>
              {doc.groups.map((g) => (
                <button type="button" role="tab" aria-selected={groupId === g.id ? 'true' : 'false'} class={`chip ${groupId === g.id ? 'is-on' : ''}`} onClick={() => setGroupId(g.id)} key={g.id}>
                  {g.name}
                </button>
              ))}
            </div>
          ) : null}
          {missing.length ? (
            <div class="notice">
              <Icon name="warn" size={14} />
              <span>
                {missing.length} data file{missing.length > 1 ? 's are' : ' is'} not loaded. Add {missing.length > 1 ? 'them' : 'it'} to see the data; files are matched by name.
              </span>
              <button type="button" class="link-btn" onClick={chooseFiles}>
                Add files
              </button>
            </div>
          ) : null}
          {doc.samples.length === 0 ? (
            <div class="drop-hint">
              <Icon name="upload" size={18} />
              <p>
                Drop FCS files anywhere, or <button type="button" class="link-btn" onClick={chooseFiles}>choose files</button>.
              </p>
              <p class="muted">FCS 2.0 to 3.2 and CSV tables. Files stay on this computer.</p>
            </div>
          ) : (
            <ul class="sample-list" role="listbox" aria-label="Samples">
              {list.map((smp) => {
                const m = meta[smp.id] || {};
                const st = m.status || 'missing';
                return (
                  <li
                    key={smp.id}
                    role="option"
                    aria-selected={current === smp.id ? 'true' : 'false'}
                    class={`sample-row ${current === smp.id ? 'is-on' : ''} st-${st}`}
                    onClick={() => setUI({ sampleId: smp.id })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      sampleMenu({ x: e.clientX, y: e.clientY, w: 0, h: 0 }, smp);
                    }}
                    title={st === 'error' ? m.error : STATUS_LABEL[st]}
                  >
                    <span class={`st-dot st-${st}`} aria-label={STATUS_LABEL[st]} />
                    {renaming === smp.id ? (
                      <TextField
                        value={smp.name}
                        autoFocus
                        class="row-input"
                        onCommit={(v) => renameSample(smp.id, v)}
                        onBlur={(e) => {
                          renameSample(smp.id, e.currentTarget.value);
                          setUI({ renamingSample: null });
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span class="sample-name" onDblClick={() => setUI({ renamingSample: smp.id })} title={smp.name}>
                        <FitText text={smp.name} minSize={8} />
                      </span>
                    )}
                    <span class="sample-groups">
                      {(smp.groupIds || []).slice(0, 2).map((g) => (
                        <i class="mini-chip" key={g}>
                          {groupName(g)}
                        </i>
                      ))}
                    </span>
                    <span class="num sample-n">{st === 'ready' ? compact(smp.nEvents) : st === 'loading' ? '…' : ''}</span>
                    <button
                      type="button"
                      class="row-more"
                      aria-label={`Options for ${smp.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        sampleMenu(rectOf(e.currentTarget), smp);
                      }}
                    >
                      <Icon name="more" size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function compact(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  return n.toLocaleString('en-US');
}

function PopulationTree() {
  const doc = useSel((s) => s.doc);
  const sampleId = useSel((s) => s.ui.sampleId);
  const selected = useSel((s) => s.ui.selectedGate);
  const editing = useSel((s) => s.ui.editingName);
  const counts = useSel((s) => (s.counts[sampleId] || {}).counts || null);
  const errors = useSel((s) => (s.counts[sampleId] || {}).errors || {});
  const stat = doc.settings.labelStat || 'freqParent';
  const rows = useMemo(() => {
    const kids = new Map();
    for (const g of Object.values(doc.gates)) {
      const p = g.parent || ROOT;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(g);
    }
    const order = new Map(doc.gateOrder.map((id, i) => [id, i]));
    const out = [];
    const walk = (id, depth) => {
      const list = (kids.get(id) || []).slice().sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
      list.forEach((g, i) => {
        out.push({ g, depth, last: i === list.length - 1 });
        walk(g.id, depth + 1);
      });
    };
    walk(ROOT, 1);
    return out;
  }, [doc.gates, doc.gateOrder]);
  const smp = doc.samples.find((x) => x.id === sampleId);
  const statLabel = stat === 'freqTotal' ? '% tot' : '%';
  const statTitle = stat === 'freqTotal' ? 'Percent of all events' : 'Percent of parent population';

  return (
    <section class="panel tree" aria-label="Populations">
      <header class="panel-head">
        <div class="panel-title static">
          <span>Populations</span>
        </div>
        <span class="panel-sub" title={smp ? smp.name : ''}>
          {smp ? smp.name : 'No sample'}
        </span>
      </header>
      <div class="tree-cols">
        <span>Name</span>
        <span class="num">Count</span>
        <span class="num" title={statTitle}>
          {statLabel}
        </span>
      </div>
      <ul class="tree-list" role="tree" aria-label="Gating hierarchy">
        <li role="treeitem" class={`tree-row depth-0 ${selected === null ? '' : ''}`} onClick={() => setUI({ selectedGate: null })}>
          <span class="tree-name">
            <Icon name="layers" size={13} />
            <span>All events</span>
          </span>
          <span class="num">{counts ? formatStat('count', counts.root) : '–'}</span>
          <span class="num muted">100</span>
        </li>
        {rows.map(({ g, depth }) => {
          const c = counts ? counts[g.id] : undefined;
          const v = frequency(doc, counts, g.id, stat === 'count' ? 'freqParent' : stat);
          const err = errors[g.id];
          const own = hasOverride(doc, sampleId, g.id);
          const isEditing = editing && editing.tree && editing.gateId === g.id;
          return (
            <li
              role="treeitem"
              aria-selected={selected === g.id ? 'true' : 'false'}
              class={`tree-row ${selected === g.id ? 'is-on' : ''}`}
              style={{ '--depth': depth }}
              key={g.id}
              onClick={() => setUI({ selectedGate: g.id })}
              onDblClick={() => drillDown(g.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setUI({ selectedGate: g.id });
                openMenu({ x: e.clientX, y: e.clientY, w: 0, h: 0 }, gateMenuItems(g.id), { title: g.name });
              }}
              title={`${g.name}${own ? ' (adjusted for this sample)' : ''}. Double-click to open its plot.`}
            >
              <span class="tree-name">
                <i class="swatch-dot" style={{ background: g.color }} />
                {g.type === 'boolean' ? <span class="bool-tag">{g.boolean && g.boolean.op === 'or' ? 'OR' : g.boolean && g.boolean.refs && g.boolean.refs.length === 1 && g.boolean.refs[0].not ? 'NOT' : 'AND'}</span> : null}
                {isEditing ? (
                  <TextField
                    value={g.name}
                    autoFocus
                    class="row-input"
                    onCommit={(v) => renameGate(g.id, v)}
                    onBlur={(e) => {
                      renameGate(g.id, e.currentTarget.value);
                      setUI({ editingName: null });
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span class="tree-label">{g.name}</span>
                )}
                {own ? <i class="adj-pill" title="Adjusted for this sample">adj</i> : null}
                {err ? (
                  <span class="tree-warn" title={err}>
                    <Icon name="warn" size={12} />
                  </span>
                ) : null}
              </span>
              <span class="num">{c === undefined ? '–' : formatStat('count', c)}</span>
              <span class="num muted">{Number.isFinite(v) ? formatStat('freqParent', v) : '–'}</span>
            </li>
          );
        })}
      </ul>
      {rows.length === 0 ? <p class="tree-empty">Draw a gate on a plot to start the hierarchy. Pick a tool above the plots, then drag on the plot.</p> : null}
    </section>
  );
}

export { popName };
