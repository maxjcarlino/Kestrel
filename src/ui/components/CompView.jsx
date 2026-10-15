// Compensation view: matrices, assignment, spillover editor and pairwise check plots.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { setUI, addMatrix, updateMatrix, deleteMatrix, setDefaultComp, setSampleComp, toast } from '../state/doc.js';
import { compChoice, effectiveComp, compKey, popSig, channelInfo } from '../state/derived.js';
import { request } from '../state/bridge.js';
import { makeTransform, transformKey } from '../../core/transforms.js';
import { invertMatrix, matchChannels } from '../../core/compensation.js';
import { toCSV } from '../../core/csv.js';
import { ROOT } from '../../core/gates.js';
import { densityImage, plotArea } from '../plot/render.js';
import { makeCanvas } from '../plot/paint.js';
import { Icon, Button, openMenu, rectOf, openDialog, InlineEdit, Empty } from './ui.jsx';
import { saveFile, safeName, pickFiles } from '../util/download.js';
import { report } from '../state/gating.js';
import { useTheme } from '../theme.js';
import { popOptions } from '../plot/PlotCard.jsx';

export function CompView() {
  const doc = useSel((s) => s.doc);
  const sampleId = useSel((s) => s.ui.sampleId);
  const meta = useSel((s) => s.meta);
  const selId = useSel((s) => s.ui.compMatrixId);
  const fileMatrix = sampleId && meta[sampleId] && meta[sampleId].spillover;
  const matrices = doc.comp.matrices;
  const active = selId && (selId === 'file' || matrices.some((m) => m.id === selId)) ? selId : matrices.length ? matrices[matrices.length - 1].id : 'file';
  const mat = active === 'file' ? (fileMatrix ? { id: 'file', name: 'Acquisition matrix', names: fileMatrix.names, matrix: fileMatrix.matrix, readOnly: true } : null) : matrices.find((m) => m.id === active);

  if (!doc.samples.length) {
    return (
      <div class="view-pad">
        <Empty icon="matrix" title="No samples yet">Add FCS files to set up compensation.</Empty>
      </div>
    );
  }

  return (
    <div class="comp">
      <aside class="comp-side">
        <section class="card">
          <header class="card-head">
            <h2>Matrices</h2>
          </header>
          <ul class="mat-list">
            <li class={`mat-row ${active === 'file' ? 'is-on' : ''}`} onClick={() => setUI({ compMatrixId: 'file' })}>
              <Icon name="file" size={14} />
              <span class="mat-name">Acquisition matrix</span>
              <span class="muted small">from each file</span>
            </li>
            {matrices.map((m) => (
              <li class={`mat-row ${active === m.id ? 'is-on' : ''}`} onClick={() => setUI({ compMatrixId: m.id })} key={m.id}>
                <Icon name="matrix" size={14} />
                <span class="mat-name">{m.name}</span>
                <span class="muted small num" title="Parameters in this workspace’s files, of all in the matrix">{visibleIdx(doc, m.names).length < m.names.length ? `${visibleIdx(doc, m.names).length} of ${m.names.length}` : `${m.names.length}×${m.names.length}`}</span>
                <button
                  type="button"
                  class="row-more"
                  aria-label={`Options for ${m.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openMenu(rectOf(e.currentTarget), [
                      { label: 'Duplicate', icon: 'copy', onClick: () => setUI({ compMatrixId: addMatrix({ ...m, name: `${m.name} copy` }) }) },
                      { label: 'Export as CSV', icon: 'download', onClick: () => exportMatrix(m) },
                      { divider: true },
                      { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteMatrix(m.id) },
                    ]);
                  }}
                >
                  <Icon name="more" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <div class="card-actions">
            <Button icon="flask" variant="primary" onClick={() => openDialog('computeComp')}>Compute from single stains</Button>
            <Button icon="copy" disabled={!fileMatrix} onClick={() => setUI({ compMatrixId: addMatrix({ name: `Edited acquisition matrix`, names: fileMatrix.names, matrix: fileMatrix.matrix, source: 'acquisition' }) })}>
              Editable copy of acquisition matrix
            </Button>
            <Button icon="upload" onClick={importMatrixCSV}>Import CSV matrix</Button>
          </div>
        </section>
        <section class="card">
          <header class="card-head">
            <h2>Applied to samples</h2>
          </header>
          <label class="field-row">
            <span>Workspace default</span>
            <select class="field" value={doc.comp.default} onChange={(e) => setDefaultComp(e.currentTarget.value)}>
              <option value="file">Acquisition matrix (from each file)</option>
              <option value="none">None (uncompensated)</option>
              {matrices.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <div class="assign-list">
            {doc.samples.map((smp) => {
              const own = doc.comp.perSample[smp.id];
              return (
                <label class={`assign-row ${smp.id === sampleId ? 'is-current' : ''}`} key={smp.id}>
                  <span class="assign-name" title={smp.name}>
                    {smp.name}
                  </span>
                  <select class="field field-sm" value={own === undefined ? 'default' : own} onChange={(e) => setSampleComp(smp.id, e.currentTarget.value)}>
                    <option value="default">Default</option>
                    <option value="file">Acquisition</option>
                    <option value="none">None</option>
                    {matrices.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </section>
      </aside>
      <section class="comp-main">
        {mat ? <MatrixEditor mat={mat} /> : <Empty icon="matrix" title="This file has no acquisition matrix">Compute one from single-stain controls, or import a CSV matrix.</Empty>}
        <CompPreview mat={mat} />
      </section>
    </div>
  );
}

async function exportMatrix(m) {
  const rows = [['', ...m.names], ...m.names.map((n, i) => [n, ...m.matrix[i]])];
  report(await saveFile(`${safeName(m.name)}.csv`, toCSV(rows)), 'Matrix exported');
}

async function importMatrixCSV() {
  const [file] = await pickFiles({ accept: '.csv,.txt', multiple: false });
  if (!file) return;
  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
    const head = lines[0].split(sep).map((s) => s.trim().replace(/^"|"$/g, ''));
    const names = head.slice(1);
    const matrix = lines.slice(1, 1 + names.length).map((l) => l.split(sep).slice(1).map((v) => parseFloat(v)));
    if (matrix.length !== names.length || matrix.some((r) => r.length < names.length || r.some((v) => !Number.isFinite(v)))) throw new Error('Expected a square table with detector names in the first row and column.');
    // accept percentages
    const scale = matrix.some((r, i) => Math.abs(r[i] - 100) < 1e-6) ? 0.01 : 1;
    const id = addMatrix({ name: file.name.replace(/\.[^.]+$/, ''), names, matrix: matrix.map((r) => r.slice(0, names.length).map((v) => v * scale)), source: 'csv' });
    setUI({ compMatrixId: id });
    toast(`Imported ${names.length}×${names.length} matrix`);
  } catch (e) {
    toast(`Could not import ${file.name}: ${e.message}`, { kind: 'error', timeout: 8000 });
  }
}

/** Channels of all samples in the workspace (first occurrence of each name). */
function workspaceChannels(doc) {
  const out = [];
  const seen = new Set();
  for (const smp of doc.samples) for (const c of smp.channels || []) if (!seen.has(c.name)) (seen.add(c.name), out.push(c));
  return out;
}

/** Indices of matrix parameters that exist in the workspace's files. */
function visibleIdx(doc, names) {
  const chans = workspaceChannels(doc);
  const all = names.map((_, i) => i);
  if (!chans.length) return all;
  const m = matchChannels(names, chans);
  return all.filter((i) => m[i] >= 0);
}

function pct(v) {
  const x = v * 100;
  return Math.abs(x) < 0.005 ? '0.00' : x.toFixed(2);
}

function heat(v) {
  const a = Math.min(1, Math.abs(v) / 0.3);
  return v < 0 ? `color-mix(in oklab, var(--bad) ${Math.round(a * 45)}%, transparent)` : `color-mix(in oklab, var(--accent) ${Math.round(a * 45)}%, transparent)`;
}

function MatrixEditor({ mat }) {
  const doc = useSel((s) => s.doc);
  const cell = useSel((s) => s.ui.compCell);
  const ro = !!mat.readOnly;
  const [edit, setEdit] = useState(null);
  const vis = visibleIdx(doc, mat.names);
  const hidden = mat.names.filter((_, i) => !vis.includes(i));
  let singular = false;
  try {
    invertMatrix(mat.matrix);
  } catch (e) {
    singular = true;
  }
  const setVal = (i, j, pct) => {
    if (ro || i === j || !Number.isFinite(pct)) return;
    const m = mat.matrix.map((r) => r.slice());
    m[i][j] = Math.round(pct * 1000) / 100000;
    updateMatrix(mat.id, { matrix: m }, { coalesce: `m:${mat.id}:${i}:${j}` });
  };
  const nudge = (i, j, d) => setVal(i, j, mat.matrix[i][j] * 100 + d);
  const onKey = (e, i, j) => {
    if (e.key === 'ArrowRight') move(i, step(j, 1));
    else if (e.key === 'ArrowLeft') move(i, step(j, -1));
    else if (e.key === 'ArrowDown' && !e.altKey) move(step(i, 1), j);
    else if (e.key === 'ArrowUp' && !e.altKey) move(step(i, -1), j);
    else if ((e.key === 'ArrowUp' || e.key === '+' || e.key === '=') && !ro) nudge(i, j, e.shiftKey ? 1 : 0.1);
    else if ((e.key === 'ArrowDown' || e.key === '-') && !ro) nudge(i, j, e.shiftKey ? -1 : -0.1);
    else if (e.key === 'Enter' && !ro && i !== j) setEdit({ i, j });
    else return;
    e.preventDefault();
  };
  const step = (k, d) => vis[vis.indexOf(k) + d];
  const move = (i, j) => {
    if (i === undefined || j === undefined) return;
    setUI({ compCell: { i, j } });
    const el = document.querySelector(`[data-cell="${i}-${j}"]`);
    if (el) el.focus();
  };
  const label = (name) => {
    const c = channelInfo(doc, name);
    return c.label ? `${c.label}` : name;
  };
  return (
    <section class="card mat-card">
      <header class="card-head">
        {ro ? <h2>{mat.name}</h2> : <InlineEdit value={mat.name} onCommit={(v) => updateMatrix(mat.id, { name: v.trim() || mat.name })} class="h2-edit" />}
        <span class="muted small">Spillover in %. Row = fluorochrome, column = detector.{ro ? ' Read only.' : ' Select a cell and type, or use Alt+↑/↓ (Shift for 1%).'}</span>
      </header>
      {singular ? (
        <p class="note-warn">
          <Icon name="warn" size={13} /> This matrix cannot be inverted, so it cannot be applied. Check for duplicate rows.
        </p>
      ) : null}
      {hidden.length ? (
        <p class="muted small mat-hidden" title={hidden.join(', ')}>
          {hidden.length} parameter{hidden.length > 1 ? 's' : ''} of this matrix {hidden.length > 1 ? 'are' : 'is'} not in this workspace's files and {hidden.length > 1 ? 'are' : 'is'} hidden: {hidden.join(', ')}.
        </p>
      ) : null}
      <div class="mat-scroll">
        <table class="mat-table">
          <thead>
            <tr>
              <th class="corner" />
              {vis.map((j) => mat.names[j]).map((c, k) => (
                <th scope="col" class={cell && cell.j === vis[k] ? 'is-hl' : ''} title={c} key={c}>
                  <span class="mat-det">{c}</span>
                  <span class="mat-mk">{label(c) !== c ? label(c) : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vis.map((i) => [mat.names[i], i]).map(([r, i]) => (
              <tr key={r}>
                <th scope="row" class={cell && cell.i === i ? 'is-hl' : ''} title={r}>
                  <span class="mat-det">{r}</span>
                  <span class="mat-mk">{label(r) !== r ? label(r) : ''}</span>
                </th>
                {vis.map((j) => [mat.matrix[i][j], j]).map(([v, j]) => {
                  const isSel = cell && cell.i === i && cell.j === j;
                  const diag = i === j;
                  if (edit && edit.i === i && edit.j === j) {
                    return (
                      <td class="is-sel" key={j}>
                        <input
                          class="cell-input"
                          defaultValue={(v * 100).toFixed(2)}
                          ref={(el) => el && setTimeout(() => el.select(), 0)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') {
                              setVal(i, j, parseFloat(e.currentTarget.value));
                              setEdit(null);
                              setTimeout(() => move(i, j), 0);
                            } else if (e.key === 'Escape') setEdit(null);
                          }}
                          onBlur={(e) => {
                            setVal(i, j, parseFloat(e.currentTarget.value));
                            setEdit(null);
                          }}
                          aria-label={`Spillover of ${r} into ${mat.names[j]} in percent`}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      class={`${diag ? 'is-diag' : ''} ${isSel ? 'is-sel' : ''} num`}
                      style={!diag && v !== 0 ? { background: heat(v) } : null}
                      tabIndex={0}
                      data-cell={`${i}-${j}`}
                      onClick={() => setUI({ compCell: { i, j } })}
                      onDblClick={() => !ro && !diag && setEdit({ i, j })}
                      onKeyDown={(e) => onKey(e, i, j)}
                      onWheel={(e) => {
                        if (ro || diag || !isSel) return;
                        e.preventDefault();
                        nudge(i, j, e.deltaY < 0 ? 0.1 : -0.1);
                      }}
                      key={j}
                    >
                      {diag ? '100' : pct(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ preview

function MiniDensity({ res, size, theme, cmap, highlight, onClick, title }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current;
    if (!c || !res || !res.counts) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.plotBg;
    ctx.fillRect(0, 0, size, size);
    const img = densityImage(res.counts, res.w, res.h, { cmap, dark: theme.dark, sigma: 0.9 });
    const tmp = makeCanvas(res.w, res.h);
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, size, size);
    ctx.strokeStyle = theme.axis;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }, [res, size, theme, cmap]);
  return <canvas ref={ref} class={`mini ${highlight ? 'is-hl' : ''}`} style={{ width: `${size}px`, height: `${size}px` }} onClick={onClick} title={title} role="img" aria-label={title} />;
}

function CompPreview({ mat }) {
  const doc = useSel((s) => s.doc);
  const sampleId = useSel((s) => s.ui.sampleId);
  const status = useSel((s) => (s.meta[s.ui.sampleId] || {}).status);
  const cell = useSel((s) => s.ui.compCell);
  const theme = useTheme();
  const [pop, setPop] = useState(() => {
    const gs = Object.values(store.get().doc.gates);
    const pick = gs.find((g) => /^singlets?$/i.test(g.name)) || gs.find((g) => /^(live|cells)$/i.test(g.name));
    return pick ? pick.id : ROOT;
  });
  const [grids, setGrids] = useState(null);
  const state = store.get();
  const applied = sampleId ? effectiveComp(state, sampleId) : null;
  const allNames = mat ? mat.names : applied ? applied.names : [];
  const vis = visibleIdx(doc, allNames);
  const names = vis.map((i) => allNames[i]);
  const assignedHere = sampleId && mat && (compChoice(doc, sampleId) === mat.id || (mat.id === 'file' && compChoice(doc, sampleId) === 'file'));
  const size = names.length > 10 ? 64 : names.length > 7 ? 82 : 96;
  const big = cell && vis.includes(cell.i) && vis.includes(cell.j) && cell.i !== cell.j ? [allNames[cell.i], allNames[cell.j]] : null;
  const popOk = pop === ROOT || doc.gates[pop];
  const key = sampleId && status === 'ready' && names.length && popOk
    ? [sampleId, pop, names.join(','), compKey(state, sampleId), popSig(state, sampleId, pop), names.map((n) => transformKey(doc.transforms[n])).join(',')].join('|')
    : null;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const reqs = [];
    for (let i = 0; i < names.length; i++) for (let j = 0; j < names.length; j++) if (i !== j) reqs.push({ pop, x: names[i], y: names[j], w: 64, h: 64 });
    request(sampleId, 'plots', { reqs }).then(
      (res) => {
        if (!alive) return;
        const map = new Map();
        let k = 0;
        for (let i = 0; i < names.length; i++) for (let j = 0; j < names.length; j++) if (i !== j) map.set(`${i}-${j}`, res[k++]);
        setGrids(map);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [key]);
  const [bigRes, setBigRes] = useState(null);
  const bigKey = key && big ? key + '|' + big.join('/') : null;
  useEffect(() => {
    if (!bigKey) return;
    let alive = true;
    request(sampleId, 'plot', { req: { pop, x: big[0], y: big[1], w: 240, h: 240 } }).then((r) => alive && setBigRes(r), () => {});
    return () => {
      alive = false;
    };
  }, [bigKey]);

  if (!names.length) return null;
  const smp = doc.samples.find((x) => x.id === sampleId);
  return (
    <section class="card preview-card">
      <header class="card-head">
        <h2>Check plots</h2>
        <div class="preview-ctl">
          <span class="muted small">{smp ? smp.name : ''}</span>
          <select class="field field-sm" value={pop} onChange={(e) => setPop(e.currentTarget.value)} aria-label="Population for check plots">
            {popOptions(doc).map((p) => (
              <option value={p.id} key={p.id}>
                {' '.repeat(p.depth)}
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </header>
      {mat && !assignedHere ? (
        <div class="notice">
          <Icon name="help" size={14} />
          <span>
            These plots show {smp ? smp.name : 'the current sample'} with {applied ? `“${applied.name}”` : 'no compensation'}. Use “{mat.name}” for this sample to check it.
          </span>
          {mat.id !== 'file' ? (
            <button type="button" class="link-btn" onClick={() => setSampleComp(sampleId, mat.id)}>
              Use for this sample
            </button>
          ) : (
            <button type="button" class="link-btn" onClick={() => setSampleComp(sampleId, 'file')}>
              Use for this sample
            </button>
          )}
        </div>
      ) : null}
      <div class="preview-body">
        <div class="nxn" style={{ gridTemplateColumns: `auto repeat(${names.length}, ${size}px)` }}>
          <div />
          {names.map((n) => (
            <div class="nxn-col" title={n} key={n}>
              {channelInfo(doc, n).label || n}
            </div>
          ))}
          {names.map((r, i) => (
            <>
              <div class="nxn-row" title={r} key={`r${i}`}>
                {channelInfo(doc, r).label || r}
              </div>
              {names.map((c, j) =>
                i === j ? (
                  <div class="nxn-diag" style={{ width: `${size}px`, height: `${size}px` }} key={`${i}-${j}`} />
                ) : (
                  <MiniDensity
                    key={`${i}-${j}`}
                    res={grids && grids.get(`${i}-${j}`)}
                    size={size}
                    theme={theme}
                    cmap={doc.settings.colormap}
                    highlight={cell && cell.i === vis[i] && cell.j === vis[j]}
                    onClick={() => setUI({ compCell: { i: vis[i], j: vis[j] } })}
                    title={`${r} (x) against ${c} (y)`}
                  />
                ),
              )}
            </>
          ))}
        </div>
        {big ? (
          <div class="big-check">
            <div class="eyebrow">
              {channelInfo(doc, big[0]).label || big[0]} → {channelInfo(doc, big[1]).label || big[1]}
            </div>
            <BigCheck res={bigRes} x={big[0]} y={big[1]} theme={theme} cmap={doc.settings.colormap} />
            <p class="muted small">Single-stained events should form a horizontal band. A band that tilts up means too little compensation; down means too much.</p>
          </div>
        ) : (
          <p class="muted small big-hint">Select a matrix cell or a small plot to enlarge that pair.</p>
        )}
      </div>
    </section>
  );
}

function BigCheck({ res, x, y, theme, cmap }) {
  const ref = useRef();
  const doc = useSel((s) => s.doc);
  useEffect(() => {
    const c = ref.current;
    if (!c || !res || !res.counts) return;
    const W = 280;
    const H = 280;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const area = plotArea(W, H);
    ctx.fillStyle = theme.plotBg;
    ctx.fillRect(area.x, area.y, area.w, area.h);
    const img = densityImage(res.counts, res.w, res.h, { cmap, dark: theme.dark, sigma: 1.4 });
    const tmp = makeCanvas(res.w, res.h);
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, area.x, area.y, area.w, area.h);
    import('../plot/render.js').then(({ drawAxes }) => {
      drawAxes(ctx, area, { tx: makeTransform(doc.transforms[x]), ty: makeTransform(doc.transforms[y]), theme, font: `10px ${theme.fontUI}` });
    });
  }, [res, theme, cmap, doc.transforms[x], doc.transforms[y]]);
  return <canvas ref={ref} style={{ width: '280px', height: '280px' }} role="img" aria-label={`${x} against ${y}`} />;
}
