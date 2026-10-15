// Statistics table: populations × statistics across samples, exportable as CSV.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSel, store } from '../state/store.js';
import { addTableColumns, removeTableColumn, moveTableColumn, setTable, samplesInGroup, findKeyword, toast, setUI } from '../state/doc.js';
import { frequency, popName, popPath, channelInfo, countsVersion, allChannels } from '../state/derived.js';
import { request, getCounts } from '../state/bridge.js';
import { STATS, STAT_ORDER, statLabel, formatStat } from '../../core/stats.js';
import { ROOT } from '../../core/gates.js';
import { toCSV, toTSV } from '../../core/csv.js';
import { Icon, IconButton, Button, Popover, rectOf, openMenu, Empty } from './ui.jsx';
import { popOptions } from '../plot/PlotCard.jsx';
import { saveFile, safeName } from '../util/download.js';
import { report } from '../state/gating.js';

function colTitle(doc, c) {
  if (c.kind === 'keyword') return { top: 'Keyword', main: c.keyword, sub: '' };
  const st = STATS[c.stat];
  const ch = c.channel ? channelInfo(doc, c.channel) : null;
  return {
    top: popName(doc, c.pop),
    main: c.stat === 'percentile' ? `P${c.arg ?? 50}` : st ? st.short : c.stat,
    sub: ch ? ch.label || ch.name : '',
    path: popPath(doc, c.pop),
  };
}

export function TableView() {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const columns = doc.table.columns;
  const samples = samplesInGroup(doc, doc.table.groupId).filter((x) => (meta[x.id] || {}).status === 'ready');
  const [rows, setRows] = useState({});
  const [busy, setBusy] = useState(0);
  const [adder, setAdder] = useState(null);
  const state = store.get();
  const versions = samples.map((smp) => countsVersion(state, smp.id) + '|' + Object.values(doc.transforms).length).join(',');
  const colKeyStr = JSON.stringify(columns.map((c) => [c.kind, c.pop, c.stat, c.channel, c.arg, c.keyword]));
  const run = useRef(0);

  useEffect(() => {
    const myRun = ++run.current;
    let pending = samples.length;
    setBusy(pending);
    samples.forEach(async (smp) => {
      try {
        const counts = await getCounts(smp.id);
        const statCols = columns.filter((c) => c.kind !== 'keyword' && STATS[c.stat] && STATS[c.stat].channel);
        const vals = statCols.length ? await request(smp.id, 'stats', { reqs: statCols.map((c) => ({ pop: c.pop, channel: c.channel, stat: c.stat, arg: c.arg })) }) : [];
        if (run.current !== myRun) return;
        const byId = {};
        statCols.forEach((c, i) => (byId[c.id] = vals[i]));
        const m = store.get().meta[smp.id] || {};
        const d = store.get().doc;
        const row = {};
        for (const c of columns) {
          if (c.kind === 'keyword') row[c.id] = m.keywords ? findKeyword(m.keywords, c.keyword) ?? '' : '';
          else if (STATS[c.stat] && STATS[c.stat].channel) row[c.id] = byId[c.id];
          else row[c.id] = frequency(d, counts, c.pop, c.stat);
        }
        setRows((r) => ({ ...r, [smp.id]: row }));
      } catch (e) {
        /* leave row empty */
      } finally {
        pending--;
        if (run.current === myRun) setBusy(pending);
      }
    });
  }, [versions, colKeyStr, samples.map((s) => s.id).join(',')]);

  const ranges = useMemo(() => {
    const out = {};
    for (const c of columns) {
      if (c.kind === 'keyword') continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const smp of samples) {
        const v = rows[smp.id] && rows[smp.id][c.id];
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      out[c.id] = [lo, hi];
    }
    return out;
  }, [rows, colKeyStr]);

  const tableRows = () => {
    const head = ['Sample', ...columns.map((c) => {
      const t = colTitle(doc, c);
      return c.kind === 'keyword' ? c.keyword : `${t.path || t.top} | ${t.main}${t.sub ? ` ${t.sub}` : ''}`;
    })];
    const body = samples.map((smp) => [smp.name, ...columns.map((c) => {
      const v = rows[smp.id] ? rows[smp.id][c.id] : '';
      if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toPrecision(8)) : '';
      return v ?? '';
    })]);
    return [head, ...body];
  };

  const exportCSV = async () => report(await saveFile(`${safeName(doc.name)} statistics.csv`, toCSV(tableRows())), 'Table exported');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toTSV(tableRows()));
      toast('Table copied. Paste it into a spreadsheet.');
    } catch (e) {
      toast('Copying is blocked here. Use Export CSV instead.', { kind: 'warn' });
    }
  };

  const presets = (anchor) =>
    openMenu(anchor, [
      { heading: 'Add columns' },
      { label: 'Frequency of parent for every population', onClick: () => addTableColumns(Object.keys(doc.gates).map((id) => ({ kind: 'stat', pop: id, stat: 'freqParent' }))) },
      { label: 'Counts for every population', onClick: () => addTableColumns(Object.keys(doc.gates).map((id) => ({ kind: 'stat', pop: id, stat: 'count' }))) },
      { label: 'Frequency of total for every population', onClick: () => addTableColumns(Object.keys(doc.gates).map((id) => ({ kind: 'stat', pop: id, stat: 'freqTotal' }))) },
      { divider: true },
      { label: 'Remove all columns', icon: 'trash', danger: true, disabled: !columns.length, onClick: () => setTable({ columns: [] }) },
    ]);

  return (
    <div class="view-pad table-view">
      <div class="view-toolbar">
        <div class="vt-left">
          <h1 class="view-title">Statistics</h1>
          <select class="field field-sm" value={doc.table.groupId || ''} onChange={(e) => setTable({ groupId: e.currentTarget.value || null })} aria-label="Samples to include">
            <option value="">All samples</option>
            {doc.groups.map((g) => (
              <option value={g.id} key={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          {busy > 0 ? <span class="muted small">Calculating {busy}…</span> : null}
        </div>
        <div class="vt-right">
          <Button icon="plus" variant="primary" onClick={(e) => setAdder({ anchor: rectOf(e.currentTarget) })}>Add statistic</Button>
          <Button icon="tag" onClick={(e) => setAdder({ anchor: rectOf(e.currentTarget), keyword: true })}>Add keyword</Button>
          <IconButton icon="more" label="More table options" onClick={(e) => presets(rectOf(e.currentTarget))} />
          <Button icon="copy" onClick={copy} disabled={!columns.length}>Copy</Button>
          <Button icon="download" onClick={exportCSV} disabled={!columns.length}>Export CSV</Button>
        </div>
      </div>
      {!columns.length ? (
        <Empty icon="table" title="No statistics yet" action={<Button variant="primary" icon="plus" onClick={(e) => setAdder({ anchor: rectOf(e.currentTarget) })}>Add statistic</Button>}>
          Add frequencies, counts or median intensities. Every sample in the table is calculated with the same gates, so the table is part of your workflow template.
        </Empty>
      ) : (
        <div class="table-scroll">
          <table class="stats-table">
            <thead>
              <tr>
                <th class="sticky-col">Sample</th>
                {columns.map((c, ci) => {
                  const t = colTitle(doc, c);
                  return (
                    <th key={c.id} title={t.path}>
                      <div class="th-wrap">
                        <span class="th-top">{t.top}</span>
                        <span class="th-main">
                          {t.main}
                          {t.sub ? <em> {t.sub}</em> : null}
                        </span>
                      </div>
                      <button
                        type="button"
                        class="th-more"
                        aria-label="Column options"
                        onClick={(e) =>
                          openMenu(rectOf(e.currentTarget), [
                            { label: 'Move left', icon: 'left', disabled: ci === 0, onClick: () => moveTableColumn(c.id, -1) },
                            { label: 'Move right', icon: 'right', disabled: ci === columns.length - 1, onClick: () => moveTableColumn(c.id, 1) },
                            { divider: true },
                            { label: 'Remove column', icon: 'trash', danger: true, onClick: () => removeTableColumn(c.id) },
                          ])
                        }
                      >
                        <Icon name="more" size={13} />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {samples.map((smp) => (
                <tr key={smp.id}>
                  <th class="sticky-col" scope="row">
                    <button type="button" class="link-btn" onClick={() => setUI({ sampleId: smp.id, view: 'gating' })} title="Show in gating view">
                      {smp.name}
                    </button>
                  </th>
                  {columns.map((c) => {
                    const v = rows[smp.id] ? rows[smp.id][c.id] : undefined;
                    if (c.kind === 'keyword') return <td class="kw-cell" key={c.id}>{v === undefined ? '…' : String(v)}</td>;
                    const [lo, hi] = ranges[c.id] || [0, 0];
                    const t = Number.isFinite(v) && hi > lo ? (v - lo) / (hi - lo) : 0;
                    return (
                      <td class="num" key={c.id} style={Number.isFinite(v) ? { '--heat': `${Math.round(6 + t * 26)}%` } : null}>
                        {v === undefined ? '…' : formatStat(c.stat, v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {samples.length === 0 ? <p class="muted pad">No loaded samples in this group.</p> : null}
        </div>
      )}
      {adder ? <ColumnAdder anchor={adder.anchor} keyword={adder.keyword} onClose={() => setAdder(null)} /> : null}
    </div>
  );
}

function ColumnAdder({ anchor, keyword, onClose }) {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const sampleId = useSel((s) => s.ui.sampleId);
  const pops = popOptions(doc);
  const [sel, setSel] = useState(() => new Set());
  const [stat, setStat] = useState('freqParent');
  const [channel, setChannel] = useState('');
  const [arg, setArg] = useState(90);
  const [kw, setKw] = useState('');
  const chans = allChannels(doc);
  if (keyword) {
    const keys = Object.keys((meta[sampleId] && meta[sampleId].keywords) || {}).sort();
    return (
      <Popover anchor={anchor} onClose={onClose} width={320} class="adder">
        <div class="adder-body">
          <label class="field-row">
            <span>Keyword</span>
            <input class="field" list="kw-list" value={kw} onInput={(e) => setKw(e.currentTarget.value)} placeholder="e.g. $DATE or TUBE NAME" autoFocus />
            <datalist id="kw-list">
              {keys.map((k) => (
                <option value={k} key={k} />
              ))}
            </datalist>
          </label>
          <div class="adder-foot">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!kw.trim()}
              onClick={() => {
                addTableColumns([{ kind: 'keyword', keyword: kw.trim() }]);
                onClose();
              }}
            >
              Add column
            </Button>
          </div>
        </div>
      </Popover>
    );
  }
  const needsChannel = STATS[stat] && STATS[stat].channel;
  const ok = sel.size > 0 && (!needsChannel || channel);
  const toggle = (id) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={360} class="adder">
      <div class="adder-body">
        <div class="eyebrow">Populations</div>
        <div class="pop-checks">
          {pops.map((p) => (
            <label class="pop-check" style={{ paddingLeft: `${8 + p.depth * 12}px` }} key={p.id}>
              <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.name}</span>
            </label>
          ))}
        </div>
        <label class="field-row">
          <span>Statistic</span>
          <select class="field" value={stat} onChange={(e) => setStat(e.currentTarget.value)}>
            {STAT_ORDER.map((k) => (
              <option value={k} key={k}>
                {STATS[k].label}
              </option>
            ))}
          </select>
        </label>
        {needsChannel ? (
          <label class="field-row">
            <span>Parameter</span>
            <select class="field" value={channel} onChange={(e) => setChannel(e.currentTarget.value)}>
              <option value="">Choose…</option>
              {chans.map((c) => (
                <option value={c.name} key={c.name}>
                  {c.label ? `${c.label} · ${c.name}` : c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {stat === 'percentile' ? (
          <label class="field-row">
            <span>Percentile</span>
            <input class="field num" type="number" min="0" max="100" value={arg} onInput={(e) => setArg(parseFloat(e.currentTarget.value))} />
          </label>
        ) : null}
        <div class="adder-foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ok}
            onClick={() => {
              addTableColumns([...sel].map((pop) => ({ kind: 'stat', pop, stat, channel: needsChannel ? channel : null, ...(stat === 'percentile' ? { arg } : {}) })));
              onClose();
            }}
          >
            Add {sel.size > 1 ? `${sel.size} columns` : 'column'}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

export { statLabel, ROOT };
