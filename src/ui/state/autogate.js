// Automatic pre-gating in the app: sample events from the engine, find the
// Cells → Singlets → Live front end (src/core/autogate.js), and add it to the
// workspace as ordinary shared gates with a plot for each step, as one undo
// step.

import { store } from './store.js';
import { request } from './bridge.js';
import { addGates, addPlot, newGateBase, beginTxn, commitTxn, setUI } from './doc.js';
import { autoPregate } from '../../core/autogate.js';
import { makeTransform } from '../../core/transforms.js';
import { ROOT } from '../../core/gates.js';

const TARGET_EVENTS = 200000;

function uniqueName(gates, base) {
  const names = new Set(Object.values(gates).map((g) => g.name));
  if (!names.has(base)) return base;
  for (let k = 1; ; k++) {
    const n = k === 1 ? `${base} (auto)` : `${base} (auto ${k})`;
    if (!names.has(n)) return n;
  }
}

function ensurePlot(pop, x, y) {
  const doc = store.get().doc;
  const have = doc.plots.find((p) => p.pop === pop && p.x === x && (p.y || null) === (y || null) && p.type !== 'tree');
  return have ? have.id : addPlot({ pop, x, y, type: y ? 'pseudo' : 'hist' }, { focus: false });
}

/**
 * @param {object} o
 * @param {string[]} o.sampleIds samples whose events are pooled to fit the gates
 * @param {{fscA, sscA, fscH?, viab?}} o.channels channel names
 * @param {{cells, singlets, live}} o.steps which gates to make
 * @param {string} [o.parent] population to start from
 * @returns {Promise<{made: {name, kept}[], n: number, notes: string[]}>}
 */
export async function runAutoPregate({ sampleIds, channels, steps, parent = ROOT }) {
  const s = store.get();
  const ready = sampleIds.filter((id) => (s.meta[id] || {}).status === 'ready');
  if (!ready.length) throw new Error('None of the chosen samples has its data loaded.');
  const names = ['fscA', 'sscA', 'fscH', 'viab'].filter((k) => channels[k]);
  const max = Math.max(20000, Math.ceil(TARGET_EVENTS / ready.length));
  const parts = await Promise.all(ready.map((id) => request(id, 'events', { pop: parent, channels: names.map((k) => channels[k]), max })));
  const n = parts.reduce((t, p) => t + p.n, 0);
  if (n < 200) throw new Error(`Only ${n} events in that population: too few to find gates from.`);
  const cols = {};
  names.forEach((k, j) => {
    const a = new Float32Array(n);
    let o = 0;
    for (const p of parts) {
      a.set(p.columns[j].subarray(0, p.n), o);
      o += p.n;
    }
    cols[k] = a;
  });
  const transforms = store.get().doc.transforms;
  const tx = {};
  for (const k of names) tx[k] = makeTransform(transforms[channels[k]]);
  const res = autoPregate(cols, tx, {
    cells: !!steps.cells,
    singlets: !!steps.singlets && !!channels.fscH,
    live: !!steps.live && !!channels.viab,
  });

  // the gates, each inside the one before
  const doc = store.get().doc;
  const work = { ...doc.gates };
  const made = [];
  let at = parent;
  const make = (base, type, x, y, geom, kept) => {
    const g = { ...newGateBase({ ...doc, gates: work }, { parent: at, x, y, type, name: uniqueName(work, base) }), ...geom };
    work[g.id] = g;
    made.push({ gate: g, kept });
    at = g.id;
  };
  if (res.cells) make('Cells', 'polygon', channels.fscA, channels.sscA, { polygon: res.cells.polygon }, res.cells.kept);
  if (res.singlets) make('Singlets', 'polygon', channels.fscA, channels.fscH, { polygon: res.singlets.polygon }, res.singlets.kept);
  if (res.live) make('Live', 'rect', channels.viab, channels.sscA, { rect: res.live.rect }, res.live.kept);
  if (!made.length) return { made: [], n, notes: res.notes };

  beginTxn();
  try {
    addGates(made.map((m) => m.gate), { select: false });
    // a plot for each step, showing its gate, and one of the last population to carry on from
    const first = ensurePlot(made[0].gate.parent, made[0].gate.x, made[0].gate.y);
    for (const m of made.slice(1)) ensurePlot(m.gate.parent, m.gate.x, m.gate.y);
    ensurePlot(at, channels.fscA, channels.sscA);
    setUI({ selectedGate: at, focusPlot: first, flashPlot: first, view: 'gating' });
  } finally {
    commitTxn();
  }
  return { made: made.map((m) => ({ id: m.gate.id, name: m.gate.name, kept: m.kept })), n, notes: res.notes };
}
