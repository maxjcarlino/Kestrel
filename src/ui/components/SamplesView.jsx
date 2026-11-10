// Samples: one row per sample, with your own columns of information about
// each one (treatment, donor, time point...). Type into the cells, paste a
// block from a spreadsheet, or import a sheet. The columns behave like FCS
// keywords everywhere else: make groups from them, sort by them, add them to
// the Statistics table.

import { useState, useRef, useEffect } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import {
  setUI, renameSample, toggleSampleGroup, groupByKeyword, toast, findKeyword,
  addMetaField, renameMetaField, removeMetaField, moveMetaField, setSampleMeta, updateDoc,
} from '../state/doc.js';
import { sortSamples, currentSort, setSampleSort, sortableKeywords } from '../state/sample-sort.js';
import { matchSheet, pasteBlock } from '../state/sample-meta.js';
import { chooseFiles } from './Sidebar.jsx';
import { Icon, Button, Empty, openMenu, rectOf, openDialog } from './ui.jsx';
import { parseTable, toCSV } from '../../core/csv.js';
import { pickFiles, saveFile, safeName } from '../util/download.js';
import { report } from '../state/gating.js';

const fmtN = (n) => (Number.isFinite(n) && n > 0 ? n.toLocaleString('en-US') : '');

export function SamplesView() {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const sampleId = useSel((s) => s.ui.sampleId);
  const [renaming, setRenaming] = useState(null);
  const tableRef = useRef();
  const fields = doc.metaFields || [];
  const kwCols = (doc.settings.sampleKwCols || []).filter((k) => !fields.some((f) => f.toUpperCase() === k.toUpperCase()));
  const sort = currentSort(doc);
  const rows = sortSamples(doc, meta, doc.samples, sort);
  const own = (id, f) => ((doc.sampleMeta || {})[id] || {})[f] ?? '';
  const fileKw = (id, k) => findKeyword(((meta[id] || {}).keywords) || {}, k);
  const setKwCols = (cols) => updateDoc((d) => ({ ...d, settings: { ...d.settings, sampleKwCols: cols } }), { history: false });

  if (!doc.samples.length) {
    return (
      <div class="view-pad">
        <Empty icon="table" title="No samples yet" action={<Button variant="primary" icon="plus" onClick={chooseFiles}>Add FCS files</Button>}>
          Add data files, then use this tab to note what each sample is (treatment, donor, time point...) and group or sort them by it.
        </Empty>
      </div>
    );
  }

  // ---- columns
  const newColumn = () => {
    const n = addMetaField('New column');
    setRenaming(n);
  };
  const sortBy = (by, key = null) => setSampleSort(sort.by === by && sort.key === key ? { desc: !sort.desc } : { by, key, desc: false });
  const sortMark = (by, key = null) =>
    sort.by === by && (key === null || sort.key === key) ? <Icon name={sort.desc ? 'down' : 'up'} size={11} /> : null;
  const fieldMenu = (f, i, e) =>
    openMenu(rectOf(e.currentTarget), [
      { label: 'Rename', icon: 'pencil', onClick: () => setRenaming(f) },
      { label: 'Sort samples by this', icon: 'sort', onClick: () => setSampleSort({ by: 'kw', key: f, desc: false }) },
      {
        label: 'Make a group for each value',
        icon: 'tag',
        onClick: () => {
          const n = groupByKeyword(f);
          toast(n ? `Made ${n} group${n > 1 ? 's' : ''} from “${f}”` : `Samples were added to the existing groups for “${f}”`);
        },
      },
      { divider: true },
      { label: 'Move left', icon: 'left', disabled: i === 0, onClick: () => moveMetaField(f, i - 1) },
      { label: 'Move right', icon: 'right', disabled: i === fields.length - 1, onClick: () => moveMetaField(f, i + 1) },
      { divider: true },
      { label: 'Delete column', icon: 'trash', danger: true, onClick: () => removeMetaField(f) },
    ]);
  const kwMenu = (k, e) =>
    openMenu(rectOf(e.currentTarget), [
      { heading: `From the FCS files (${k})` },
      {
        label: 'Make an editable copy',
        icon: 'pencil',
        onClick: () => {
          const values = {};
          for (const s of doc.samples) values[s.id] = String(fileKw(s.id, k) ?? '');
          addMetaField(k, { values });
        },
      },
      { label: 'Sort samples by this', icon: 'sort', onClick: () => setSampleSort({ by: 'kw', key: k, desc: false }) },
      { label: 'Make a group for each value', icon: 'tag', onClick: () => toast(`Made ${groupByKeyword(k)} group(s) from ${k}`) },
      { divider: true },
      { label: 'Hide this column', icon: 'close', onClick: () => setKwCols((doc.settings.sampleKwCols || []).filter((x) => x !== k)) },
    ]);
  const showKeyword = (e) => {
    const all = sortableKeywords(doc, meta).filter((k) => !fields.includes(k));
    openMenu(
      rectOf(e.currentTarget),
      all.length
        ? all.map((k) => ({ label: k, checked: kwCols.includes(k), onClick: () => setKwCols(kwCols.includes(k) ? kwCols.filter((x) => x !== k) : [...kwCols, k]) }))
        : [{ label: 'Load data files to see their keywords', disabled: true }],
      { title: 'Show a keyword from the FCS files' },
    );
  };

  // ---- cells: arrows/Enter move between rows; pasting a block fills from here
  const focusCell = (r, c) => {
    const el = tableRef.current && tableRef.current.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (el) {
      el.focus();
      if (el.select) el.select();
    }
  };
  const onCellKey = (r, c) => (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusCell(e.shiftKey && e.key === 'Enter' ? r - 1 : r + 1, c);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusCell(r - 1, c);
    }
  };
  const onCellPaste = (r, c) => (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!/[\t\n\r]/.test(text.replace(/[\r\n]+$/, ''))) return; // one value: normal paste
    e.preventDefault();
    const cur = store.get().doc;
    const { entries, newFields } = pasteBlock(parseTable(text), rows.map((s) => s.id), cur.metaFields || [], r, c);
    for (const f of newFields) addMetaField(f);
    setSampleMeta(entries);
    toast(`Pasted ${new Set(entries.map((x) => x[0])).size} row${entries.length > 1 ? 's' : ''}${newFields.length ? `, adding ${newFields.length} column${newFields.length > 1 ? 's' : ''}` : ''}.`);
  };

  // ---- import / export
  const importSheet = async () => {
    const files = await pickFiles({ accept: '.csv,.tsv,.txt', multiple: false });
    if (!files || !files.length) return;
    const res = matchSheet(store.get().doc, parseTable(await files[0].text()));
    if (!res.keyHeader) {
      toast('No column in that file names these samples. Include a column of sample or file names.', { kind: 'error', timeout: 9000 });
      return;
    }
    const cur = store.get().doc.metaFields || [];
    for (const f of res.fields) if (!cur.some((x) => x.toUpperCase() === f.toUpperCase())) addMetaField(f);
    const canon = (f) => (store.get().doc.metaFields || []).find((x) => x.toUpperCase() === f.toUpperCase()) || f;
    setSampleMeta(res.entries.map(([id, f, v]) => [id, canon(f), v]));
    toast(`Filled ${res.fields.length} column${res.fields.length === 1 ? '' : 's'} for ${res.matched} of ${doc.samples.length} samples (matched by “${res.keyHeader}”).${res.unmatched.length ? ` Not found: ${res.unmatched.slice(0, 4).join(', ')}${res.unmatched.length > 4 ? '…' : ''}` : ''}`, { timeout: 10000 });
  };
  const exportSheet = async () => {
    const groupNames = (s) => (s.groupIds || []).map((g) => (doc.groups.find((x) => x.id === g) || {}).name).filter(Boolean).join('; ');
    const out = [
      ['Sample', 'File', 'Groups', 'Events', ...fields, ...kwCols],
      ...rows.map((s) => [s.name, s.fileName || '', groupNames(s), s.nEvents || '', ...fields.map((f) => own(s.id, f)), ...kwCols.map((k) => String(fileKw(s.id, k) ?? ''))]),
    ];
    report(await saveFile(`${safeName(doc.name)} samples.csv`, toCSV(out)), 'Sample table exported');
  };

  const groupCell = (s) => (e) =>
    openMenu(
      rectOf(e.currentTarget),
      [
        ...doc.groups.map((g) => ({ label: g.name, checked: (s.groupIds || []).includes(g.id), onClick: () => toggleSampleGroup(s.id, g.id) })),
        doc.groups.length ? { divider: true } : null,
        { label: 'New group with this sample…', icon: 'plus', onClick: () => openDialog('group', { sampleIds: [s.id] }) },
      ],
      { title: s.name },
    );

  return (
    <div class="view-pad samples-view">
      <div class="view-toolbar">
        <div class="vt-left">
          <h1 class="view-title">Samples</h1>
          <span class="muted small">{doc.samples.length} sample{doc.samples.length === 1 ? '' : 's'}</span>
        </div>
        <div class="vt-right">
          <Button variant="primary" icon="plus" onClick={newColumn}>
            Add column
          </Button>
          <Button icon="tag" onClick={showKeyword}>
            Show file keyword
          </Button>
          <Button icon="upload" onClick={importSheet}>
            Import sheet…
          </Button>
          <Button icon="download" onClick={exportSheet}>
            Export CSV
          </Button>
        </div>
      </div>
      <p class="muted small samples-help">
        Add a column for anything you know about your samples (treatment, donor, time point…) and type the values in, or paste a block of cells from a spreadsheet. Your columns work like the files’ keywords everywhere: make groups from them, sort the sample list by them, or add them to the Statistics table.
      </p>
      <div class="table-scroll samples-scroll">
        <table class="samples-table" ref={tableRef}>
          <thead>
            <tr>
              <th class="sticky-col">
                <button type="button" class="th-btn" onClick={() => sortBy('name')} title="Sort by name">
                  Sample {sortMark('name')}
                </button>
              </th>
              <th>
                <button type="button" class="th-btn" onClick={() => sortBy('group')} title="Sort by group">
                  Groups {sortMark('group')}
                </button>
              </th>
              <th class="num">
                <button type="button" class="th-btn" onClick={() => sortBy('events')} title="Sort by event count">
                  Events {sortMark('events')}
                </button>
              </th>
              {fields.map((f, i) => (
                <th class="own-col" key={`f:${f}`}>
                  {renaming === f ? (
                    <ColumnNameInput
                      name={f}
                      onDone={(v) => {
                        setRenaming(null);
                        if (v !== null && !renameMetaField(f, v)) toast(`There is already a column called “${v.trim()}”.`, { kind: 'warn' });
                      }}
                    />
                  ) : (
                    <button type="button" class="th-btn" onClick={(e) => fieldMenu(f, i, e)} onDblClick={() => setRenaming(f)} title="Rename, sort, make groups, move or delete">
                      {f} {sortMark('kw', f)}
                      <Icon name="down" size={10} />
                    </button>
                  )}
                </th>
              ))}
              {kwCols.map((k) => (
                <th class="kw-col" key={`k:${k}`}>
                  <button type="button" class="th-btn" onClick={(e) => kwMenu(k, e)} title="A keyword from the FCS files (read only)">
                    <span class="mono">{k}</span> {sortMark('kw', k)}
                    <Icon name="down" size={10} />
                  </button>
                </th>
              ))}
              <th class="add-col">
                <button type="button" class="th-btn" onClick={newColumn} title="Add a column">
                  <Icon name="plus" size={13} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, r) => {
              const st = (meta[s.id] || {}).status || 'missing';
              return (
                <tr key={s.id} class={s.id === sampleId ? 'is-current' : ''}>
                  <th class="sticky-col" scope="row">
                    <span class={`st-dot st-${st}`} title={st === 'ready' ? 'Loaded' : st === 'missing' ? 'Data file not loaded' : st} />
                    <input
                      class="cell-input name-input"
                      value={s.name}
                      data-r={r}
                      data-c={-1}
                      aria-label={`Name of ${s.name}`}
                      title={s.fileName && s.fileName !== s.name ? `File: ${s.fileName}` : undefined}
                      onFocus={() => setUI({ sampleId: s.id })}
                      onKeyDown={onCellKey(r, -1)}
                      onChange={(e) => renameSample(s.id, e.currentTarget.value)}
                    />
                  </th>
                  <td class="groups-cell">
                    <button type="button" class="groups-btn" onClick={groupCell(s)} title="Groups">
                      {(s.groupIds || []).map((g) => (doc.groups.find((x) => x.id === g) || {}).name).filter(Boolean).map((n) => (
                        <i class="mini-chip" key={n}>
                          {n}
                        </i>
                      ))}
                      <Icon name="plus" size={11} />
                    </button>
                  </td>
                  <td class="num muted">{fmtN(s.nEvents)}</td>
                  {fields.map((f, c) => {
                    const fallback = fileKw(s.id, f);
                    return (
                      <td class="own-col" key={f}>
                        <input
                          class="cell-input"
                          value={own(s.id, f)}
                          placeholder={fallback !== undefined ? String(fallback) : ''}
                          data-r={r}
                          data-c={c}
                          aria-label={`${f} for ${s.name}`}
                          onInput={(e) => setSampleMeta([[s.id, f, e.currentTarget.value]], { coalesce: `cell:${s.id}:${f}` })}
                          onKeyDown={onCellKey(r, c)}
                          onPaste={onCellPaste(r, c)}
                        />
                      </td>
                    );
                  })}
                  {kwCols.map((k) => (
                    <td class="kw-col mono" key={k}>
                      {String(fileKw(s.id, k) ?? '')}
                    </td>
                  ))}
                  <td class="add-col" />
                </tr>
              );
            })}
          </tbody>
        </table>
        {!fields.length ? (
          <div class="samples-empty">
            <Button icon="plus" onClick={newColumn}>
              Add your first column
            </Button>
            <span class="muted small">e.g. Treatment, Donor, Time point. Or import a sheet with a column of sample names.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The column-name editor in a header: focused and selected as soon as it appears. */
function ColumnNameInput({ name, onDone }) {
  const ref = useRef();
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);
  const finish = (v) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      class="field th-input"
      defaultValue={name}
      aria-label="Column name"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(e.currentTarget.value);
        }
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
