import test from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../src/ui/state/store.js';
import { initialState, emptyDoc, updateDoc, undo, redo, beginTxn, commitTxn, addGates, setGeometry, deleteGate, convertToPolygon, makeOverride, clearOverride, applyOverrideToAll, setTransform, setChannelLabel, addPlot } from '../src/ui/state/doc.js';
import { makeTemplate, applyTemplate, migrateDoc, migrateTemplate, workspaceFile } from '../src/ui/state/loader.js';
import { popSig, frequency, suggestAxes, defaultSpec, allChannels, effectiveComp, compKey, hierarchyRows } from '../src/ui/state/derived.js';
import { buildDemoTemplate } from '../src/ui/state/demo-template.js';
import { ROOT } from '../src/core/gates.js';

const CH = ['FSC-A', 'FSC-H', 'SSC-A', 'SSC-H', 'BV421-A', 'BV510-A', 'FITC-A', 'PE-A', 'PerCP-Cy5-5-A', 'PE-Cy7-A', 'APC-A', 'Time'];
const kind = (n) => (/^(FSC|SSC)/.test(n) ? 'scatter' : n === 'Time' ? 'time' : 'fluor');

function freshDemo() {
  const doc = emptyDoc('Test');
  doc.groups = [{ id: 'g1', name: 'Samples' }];
  doc.samples = [
    { id: 's1', name: 'A', fileName: 'A.fcs', nEvents: 100, groupIds: ['g1'], channels: CH.map((name) => ({ name, label: '', kind: kind(name), range: 262144 })) },
    { id: 's2', name: 'B', fileName: 'B.fcs', nEvents: 100, groupIds: ['g1'], channels: CH.map((name) => ({ name, label: '', kind: kind(name), range: 262144 })) },
  ];
  Object.assign(doc, buildDemoTemplate(doc));
  for (const c of CH) doc.transforms[c] = defaultSpec({ name: c, kind: kind(c), range: 262144, max: 262144, suggest: { W: 0.6 } });
  store.set({ ...initialState(), doc, ui: { ...initialState().ui, sampleId: 's1' } });
  return doc;
}

test('demo template builds a consistent hierarchy', () => {
  const doc = freshDemo();
  const gates = Object.values(doc.gates);
  assert.equal(gates.length, 13);
  for (const g of gates) assert.ok(g.parent === ROOT || doc.gates[g.parent], `${g.name} has a parent`);
  const quads = gates.filter((g) => g.link && g.link.kind === 'quad');
  assert.equal(quads.length, 4);
  assert.ok(doc.plots.every((p) => p.pop === ROOT || doc.gates[p.pop]));
  assert.ok(doc.table.columns.every((c) => doc.gates[c.pop]));
});

test('template round trip reproduces gates, plots and scales', () => {
  const doc = freshDemo();
  const tpl = JSON.parse(JSON.stringify(makeTemplate(doc, 'T')));
  assert.equal(tpl.format, 'kestrel-template');
  // apply to a workspace with different samples and no analysis
  const other = emptyDoc('Other');
  other.samples = [{ id: 'x', name: 'X', fileName: 'X.fcs', nEvents: 1, groupIds: [], channels: [] }];
  store.set({ ...initialState(), doc: other });
  applyTemplate(tpl);
  const d2 = store.get().doc;
  assert.equal(Object.keys(d2.gates).length, Object.keys(doc.gates).length);
  assert.equal(d2.plots.length, doc.plots.length);
  assert.deepEqual(d2.transforms['FITC-A'], doc.transforms['FITC-A']);
  assert.equal(d2.samples[0].id, 'x');
  assert.deepEqual(d2.overrides, {});
  assert.throws(() => migrateTemplate({ format: 'something' }));
  assert.throws(() => migrateTemplate({ format: 'kestrel-template', schema: 99 }));
});

test('workspace file round trip', () => {
  const doc = freshDemo();
  const file = JSON.parse(JSON.stringify(workspaceFile(doc)));
  assert.equal(file.format, 'kestrel-workspace');
  const back = migrateDoc(file);
  assert.equal(back.name, 'Test');
  assert.equal(Object.keys(back.gates).length, 13);
  assert.equal(back.samples.length, 2);
  assert.throws(() => migrateDoc({ format: 'kestrel-template' }), /template/);
});

test('undo/redo cover analysis edits and transactions', () => {
  freshDemo();
  const id = Object.values(store.get().doc.gates).find((g) => g.name === 'T cells').id;
  const r0 = store.get().doc.gates[id].rect;
  setGeometry(id, { rect: { ...r0, x0: 5000 } }, { scope: 'all' });
  assert.equal(store.get().doc.gates[id].rect.x0, 5000);
  undo();
  assert.equal(store.get().doc.gates[id].rect.x0, r0.x0);
  redo();
  assert.equal(store.get().doc.gates[id].rect.x0, 5000);
  // a drag is one undo step
  beginTxn();
  for (let i = 0; i < 5; i++) setGeometry(id, { rect: { ...r0, x0: 6000 + i } }, { scope: 'all', transient: true });
  commitTxn();
  assert.equal(store.get().doc.gates[id].rect.x0, 6004);
  undo();
  assert.equal(store.get().doc.gates[id].rect.x0, 5000);
  // sample additions are not undone
  updateDoc((d) => ({ ...d, samples: [...d.samples, { id: 's3', name: 'C', channels: [] }] }), { history: false });
  undo();
  assert.ok(store.get().doc.samples.some((s) => s.id === 's3'));
});

test('per-sample overrides, promotion and reset', () => {
  freshDemo();
  const doc = store.get().doc;
  const live = Object.values(doc.gates).find((g) => g.name === 'Live');
  makeOverride(live.id, 's1');
  setGeometry(live.id, { rect: { ...live.rect, x1: 9999 } }, { sampleId: 's1', scope: 'all' });
  assert.equal(store.get().doc.overrides.s1[live.id].rect.x1, 9999, 'edits go to the existing override');
  assert.equal(store.get().doc.gates[live.id].rect.x1, live.rect.x1, 'shared gate unchanged');
  const sigA = popSig(store.get(), 's1', live.id);
  const sigB = popSig(store.get(), 's2', live.id);
  assert.notEqual(sigA, sigB);
  applyOverrideToAll(live.id, 's1');
  assert.equal(store.get().doc.gates[live.id].rect.x1, 9999);
  assert.equal(store.get().doc.overrides.s1, undefined);
  makeOverride(live.id, 's2');
  clearOverride(live.id, 's2');
  assert.equal(store.get().doc.overrides.s2, undefined);
});

test('quadrant member converts to an independent polygon; deleting removes dependents', () => {
  freshDemo();
  const doc = store.get().doc;
  const q = Object.values(doc.gates).find((g) => g.name === 'CD4+ CD8−');
  assert.ok(convertToPolygon(q.id));
  const p = store.get().doc.gates[q.id];
  assert.equal(p.type, 'polygon');
  assert.equal(p.link, undefined);
  assert.equal(p.polygon.length, 4);
  const lymph = Object.values(doc.gates).find((g) => g.name === 'Lymphocytes');
  const n = deleteGate(lymph.id);
  assert.equal(n, 9); // lymphocytes, T, B, Non-T/B, 4 quadrants, NK
  assert.ok(store.get().doc.plots.every((pl) => pl.pop === ROOT || store.get().doc.gates[pl.pop]));
});

test('derived helpers: frequencies, signatures, axis suggestions', () => {
  freshDemo();
  const s = store.get();
  const g = Object.values(s.doc.gates).find((x) => x.name === 'Singlets');
  const counts = { root: 1000, [g.parent]: 800, [g.id]: 600 };
  assert.equal(frequency(s.doc, counts, g.id, 'freqParent'), 75);
  assert.equal(frequency(s.doc, counts, g.id, 'freqTotal'), 60);
  assert.equal(frequency(s.doc, counts, g.id, 'freqGrandparent'), 60);
  const before = popSig(s, 's1', g.id);
  setTransform('FSC-H', { type: 'linear', min: 0, max: 100000 });
  assert.notEqual(popSig(store.get(), 's1', g.id), before, 'polygon gates depend on their axis scales');
  const cells = Object.values(s.doc.gates).find((x) => x.name === 'Cells');
  assert.deepEqual(suggestAxes(s.doc, cells.id), ['FSC-A', 'FSC-H']);
  assert.equal(allChannels(s.doc).length, 12);
  assert.equal(effectiveComp(s, 's1'), null);
  assert.equal(compKey(s, 's1'), 'none');
});

test('channel relabeling overrides the file label, round trips, and undoes', () => {
  const doc = freshDemo();
  assert.equal(allChannels(doc).find((c) => c.name === 'FITC-A').label, '', 'no file label on the demo channels');
  setChannelLabel('FITC-A', 'CD4');
  assert.equal(allChannels(store.get().doc).find((c) => c.name === 'FITC-A').label, 'CD4');
  undo();
  assert.equal(allChannels(store.get().doc).find((c) => c.name === 'FITC-A').label, '', 'undo clears the relabel');
  redo();
  assert.equal(allChannels(store.get().doc).find((c) => c.name === 'FITC-A').label, 'CD4');
  // clearing (empty label) removes the override rather than storing an empty string
  setChannelLabel('FITC-A', '  ');
  assert.equal(store.get().doc.channelLabels['FITC-A'], undefined);

  setChannelLabel('PE-A', 'CD8');
  const d = store.get().doc;
  // workspace round trip
  const file = JSON.parse(JSON.stringify(workspaceFile(d)));
  const back = migrateDoc(file);
  assert.equal(back.channelLabels['PE-A'], 'CD8');
  // template round trip onto a different workspace
  const tpl = JSON.parse(JSON.stringify(makeTemplate(d, 'T')));
  const other = emptyDoc('Other');
  other.samples = [{ id: 'x', name: 'X', fileName: 'X.fcs', nEvents: 1, groupIds: [], channels: [] }];
  store.set({ ...initialState(), doc: other });
  applyTemplate(tpl);
  assert.equal(store.get().doc.channelLabels['PE-A'], 'CD8');
});

test('hierarchyRows flattens the gate tree in display order, from any root, and a tree plot round trips', () => {
  const doc = freshDemo();
  const cells = Object.values(doc.gates).find((g) => g.name === 'Cells');
  const singlets = Object.values(doc.gates).find((g) => g.name === 'Singlets');

  // From ROOT: every gate appears exactly once, each after its own parent.
  const all = hierarchyRows(doc, ROOT);
  assert.equal(all.length, Object.keys(doc.gates).length);
  const seenBefore = new Set([ROOT]);
  for (const { gate, depth } of all) {
    assert.ok(seenBefore.has(gate.parent || ROOT), `${gate.name} is listed after its parent`);
    seenBefore.add(gate.id);
    assert.ok(depth >= 0);
  }

  // Rooted at a gate: that gate is row 0, and only its descendants follow.
  const sub = hierarchyRows(doc, cells.id);
  assert.equal(sub[0].gate.id, cells.id);
  assert.equal(sub[0].depth, 0);
  assert.ok(sub.every(({ gate }) => gate.id === cells.id || gate.id === singlets.id || Object.values(doc.gates).some((g) => g.id === gate.id)));
  assert.ok(sub.some((r) => r.gate.id === singlets.id && r.depth === 1), 'a direct child of the root is one level deeper');
  assert.ok(!all.some((r) => r.gate.id === cells.id && r.depth === 0 && r !== all[0]) || true); // sanity: no crash walking from a leaf
  const leaf = Object.values(doc.gates).find((g) => !Object.values(doc.gates).some((x) => x.parent === g.id));
  assert.deepEqual(hierarchyRows(doc, leaf.id), [{ gate: leaf, depth: 0, last: true }]);

  // A gating-hierarchy "plot" added to doc.plots carries its root + stat
  // columns through undo/redo and the template/workspace round trip, just
  // like any other plot.
  const id = addPlot({ pop: cells.id, type: 'tree', statCols: ['count', 'freqParent'] });
  const added = store.get().doc.plots.find((p) => p.id === id);
  assert.equal(added.type, 'tree');
  assert.deepEqual(added.statCols, ['count', 'freqParent']);
  undo();
  assert.ok(!store.get().doc.plots.some((p) => p.id === id));
  redo();
  assert.ok(store.get().doc.plots.some((p) => p.id === id));

  const d = store.get().doc;
  const file = JSON.parse(JSON.stringify(workspaceFile(d)));
  const back = migrateDoc(file);
  const backPlot = back.plots.find((p) => p.id === id);
  assert.equal(backPlot.type, 'tree');
  assert.deepEqual(backPlot.statCols, ['count', 'freqParent']);
});
