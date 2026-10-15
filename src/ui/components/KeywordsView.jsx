// Keywords: FCS metadata for the current sample, or compared across samples.

import { useMemo, useState } from 'preact/hooks';
import { useSel } from '../state/store.js';
import { setUI, findKeyword } from '../state/doc.js';
import { Icon, Segmented, Empty, Button } from './ui.jsx';
import { toCSV } from '../../core/csv.js';
import { saveFile, safeName } from '../util/download.js';
import { report } from '../state/gating.js';

export function KeywordsView() {
  const doc = useSel((s) => s.doc);
  const meta = useSel((s) => s.meta);
  const sampleId = useSel((s) => s.ui.sampleId);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('one');
  const [picked, setPicked] = useState(['$DATE', '$CYT', 'TUBE NAME', '$TOT']);
  const m = meta[sampleId] || {};
  const kw = m.keywords || {};
  const needle = q.trim().toLowerCase();
  const entries = useMemo(
    () => Object.entries(kw).filter(([k, v]) => !needle || k.toLowerCase().includes(needle) || String(v).toLowerCase().includes(needle)).sort((a, b) => a[0].localeCompare(b[0])),
    [kw, needle],
  );
  const allKeys = useMemo(() => {
    const set = new Set();
    for (const smp of doc.samples) for (const k of Object.keys((meta[smp.id] || {}).keywords || {})) set.add(k);
    return [...set].sort();
  }, [doc.samples, meta]);
  const smp = doc.samples.find((x) => x.id === sampleId);

  if (!doc.samples.length) {
    return (
      <div class="view-pad">
        <Empty icon="tag" title="No samples yet">Keywords are the metadata stored in each FCS file, such as the cytometer, date and tube name.</Empty>
      </div>
    );
  }

  const exportCompare = async () => {
    const rows = [['Sample', ...picked], ...doc.samples.map((s) => [s.name, ...picked.map((k) => findKeyword((meta[s.id] || {}).keywords || {}, k) ?? '')])];
    report(await saveFile(`${safeName(doc.name)} keywords.csv`, toCSV(rows)), 'Keywords exported');
  };

  return (
    <div class="view-pad keywords-view">
      <div class="view-toolbar">
        <div class="vt-left">
          <h1 class="view-title">Keywords</h1>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'one', label: 'This sample' }, { value: 'compare', label: 'Compare samples' }]} label="Keyword view" />
        </div>
        <div class="vt-right">
          <label class="search">
            <Icon name="search" size={14} />
            <input class="field" placeholder="Filter keywords" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Filter keywords" />
          </label>
          {mode === 'compare' ? <Button icon="download" onClick={exportCompare}>Export CSV</Button> : null}
        </div>
      </div>
      {mode === 'one' ? (
        <div class="table-scroll">
          <p class="muted small pad-b">
            {smp ? smp.name : ''} · {entries.length} of {Object.keys(kw).length} keywords
          </p>
          <table class="kw-table">
            <thead>
              <tr>
                <th>Keyword</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row" class="mono">{k}</th>
                  <td class="mono">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div class="kw-compare">
          <div class="kw-pick">
            <div class="eyebrow">Keywords to compare</div>
            <div class="check-list">
              {allKeys
                .filter((k) => !needle || k.toLowerCase().includes(needle))
                .map((k) => (
                  <label class="check-row" key={k}>
                    <input type="checkbox" checked={picked.includes(k)} onChange={() => setPicked(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k])} />
                    <span class="mono">{k}</span>
                  </label>
                ))}
            </div>
          </div>
          <div class="table-scroll">
            <table class="kw-table">
              <thead>
                <tr>
                  <th>Sample</th>
                  {picked.map((k) => (
                    <th class="mono" key={k}>
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {doc.samples.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">
                      <button type="button" class="link-btn" onClick={() => setUI({ sampleId: s.id })}>
                        {s.name}
                      </button>
                    </th>
                    {picked.map((k) => (
                      <td class="mono" key={k}>
                        {String(findKeyword((meta[s.id] || {}).keywords || {}, k) ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
