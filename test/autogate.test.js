import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine/engine.js';
import { generateSample, demoManifest } from '../src/core/demo-data.js';
import { normalizeSpec, makeTransform } from '../src/core/transforms.js';
import { defaultSpec } from '../src/ui/state/derived.js';
import { emptyDoc } from '../src/ui/state/doc.js';
import { buildDemoTemplate } from '../src/ui/state/demo-template.js';
import { autoPregate, guessPregateChannels, findLiveThreshold, convexHull, simplifyPolygon } from '../src/core/autogate.js';

/** Load a demo file the way the app does: default scales, acquisition compensation. */
function load(spec, { comp = true } = {}) {
  const e = new Engine();
  const bytes = generateSample(spec);
  const meta = e.handle('load', { id: 's', name: spec.name, buffer: bytes.buffer }).result;
  const transforms = {};
  for (const c of meta.channels) transforms[c.name] = normalizeSpec(defaultSpec(c));
  e.handle('setTransforms', { transforms });
  if (comp) e.handle('setComp', { id: 's', comp: meta.spillover });
  return { e, meta, transforms };
}

function run(e, meta, transforms, steps) {
  const ch = guessPregateChannels(meta.channels);
  const keys = ['fscA', 'sscA', 'fscH', 'viab'].filter((k) => ch[k]);
  const ev = e.handle('events', { id: 's', pop: 'root', channels: keys.map((k) => ch[k]), max: 60000 }).result;
  const cols = {};
  const tx = {};
  keys.forEach((k, j) => {
    cols[k] = ev.columns[j];
    tx[k] = makeTransform(transforms[ch[k]]);
  });
  return { ch, r: autoPregate(cols, tx, steps) };
}

test('recognises scatter channels and the viability dye by label', () => {
  const ch = guessPregateChannels([
    { name: 'FSC-A', kind: 'scatter' }, { name: 'FSC-H', kind: 'scatter' }, { name: 'SSC-A', kind: 'scatter' },
    { name: 'FITC-A', label: 'CD3', kind: 'fluor' }, { name: 'BV510-A', label: 'Zombie Aqua', kind: 'fluor' },
  ]);
  assert.deepEqual(ch, { fscA: 'FSC-A', sscA: 'SSC-A', fscH: 'FSC-H', viab: 'BV510-A' });
  const none = guessPregateChannels([{ name: 'FSC-A', kind: 'scatter' }, { name: 'SSC-A', kind: 'scatter' }, { name: 'PE-A', label: 'CD8', kind: 'fluor' }]);
  assert.equal(none.viab, null);
  assert.equal(none.fscH, null);
});

test('finds Cells, Singlets and Live within a couple of points of the hand-drawn demo gates, for every donor', () => {
  for (const m of demoManifest().filter((x) => x.group === 'Samples')) {
    const { e, meta, transforms } = load({ kind: m.kind, donor: m.donor, seed: m.seed, events: 60000, name: m.name });
    const { ch, r } = run(e, meta, transforms);
    assert.deepEqual(r.notes, []);
    // evaluate the found gates and the demo's hand-drawn ones with the engine itself
    const auto = [
      { id: 'c', name: 'Cells', parent: 'root', type: 'polygon', x: ch.fscA, y: ch.sscA, polygon: r.cells.polygon },
      { id: 'sg', name: 'Singlets', parent: 'c', type: 'polygon', x: ch.fscA, y: ch.fscH, polygon: r.singlets.polygon },
      { id: 'l', name: 'Live', parent: 'sg', type: 'rect', x: ch.viab, y: ch.sscA, rect: r.live.rect },
    ];
    const doc = emptyDoc('t');
    doc.samples = [{ id: 's', name: m.name, channels: meta.channels, groupIds: [] }];
    const hand = Object.values(buildDemoTemplate(doc).gates).filter((g) => ['Cells', 'Singlets', 'Live'].includes(g.name));
    e.handle('setGates', { gates: [...auto, ...hand], overrides: {} });
    const c = e.handle('counts', { id: 's' }).result.counts;
    const h = (name) => c[hand.find((g) => g.name === name).id];
    const pts = (a, b) => (100 * a) / b;
    const near = (name, got, want) => assert.ok(Math.abs(got - want) < 2.5, `${m.name} ${name}: auto ${got.toFixed(1)}% vs hand ${want.toFixed(1)}%`);
    near('Cells', pts(c.c, c.root), pts(h('Cells'), c.root));
    near('Singlets', pts(c.sg, c.c), pts(h('Singlets'), h('Cells')));
    near('Live', pts(c.l, c.sg), pts(h('Live'), h('Singlets')));
    // the fractions it reports from its own sample of events agree with the engine
    assert.ok(Math.abs(r.cells.kept - c.c / c.root) < 0.01);
    assert.ok(Math.abs(r.singlets.kept - c.sg / c.c) < 0.01);
    assert.ok(Math.abs(r.live.kept - c.l / c.sg) < 0.01);
  }
});

test('Live still lands between the dim and dead peaks on uncompensated data', () => {
  const m = demoManifest()[0];
  const { e, meta, transforms } = load({ kind: m.kind, donor: m.donor, seed: m.seed, events: 60000, name: m.name }, { comp: false });
  const { r } = run(e, meta, transforms);
  // the donor has 5% dead cells
  assert.ok(r.live.kept > 0.9 && r.live.kept < 0.98, `live ${r.live.kept}`);
});

test('skips steps it has no parameter for, and copes with data that has no debris or dead cells', () => {
  const { e, meta, transforms } = load({ kind: 'bead', dye: 2, seed: 912, events: 15000, name: 'Comp_FITC-A' });
  const { r } = run(e, meta, transforms, { cells: true, singlets: true, live: false });
  assert.ok(r.cells && r.cells.kept > 0.9, `beads cells ${r.cells && r.cells.kept}`);
  assert.ok(r.singlets);
  const ev = e.handle('events', { id: 's', pop: 'root', channels: ['FSC-A', 'SSC-A'], max: 5000 }).result;
  const t = makeTransform(transforms['FSC-A']);
  const r2 = autoPregate({ fscA: ev.columns[0], sscA: ev.columns[1] }, { fscA: t, sscA: makeTransform(transforms['SSC-A']) });
  assert.ok(r2.cells && !r2.singlets && !r2.live);
  assert.equal(r2.notes.length, 2, r2.notes.join(' | '));
});

test('Live threshold: a single dim peak with no dead cells keeps nearly everything', () => {
  const v = new Float32Array(20000);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < v.length; i++) v[i] = 0.3 + 0.03 * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(6.283 * rnd());
  const t = findLiveThreshold(v);
  const kept = v.filter((x) => x < t).length / v.length;
  assert.ok(kept > 0.995 && t < 0.5, `t ${t}, kept ${kept}`);
});

test('geometry helpers: hull and simplification', () => {
  const hull = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.2, 0.8]]);
  assert.equal(hull.length, 4);
  const circle = Array.from({ length: 40 }, (_, i) => [Math.cos((i / 40) * 6.283), Math.sin((i / 40) * 6.283)]);
  assert.equal(simplifyPolygon(circle, 10).length, 10);
});
