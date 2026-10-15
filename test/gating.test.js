import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateGate, orderGates, applyOverride, ROOT, EDGE_HI } from '../src/core/gates.js';
import { toPolygon, makeQuadrant, makeSplit, quadrantNames, rectFromScale, ellipseFromBox, translateGeometry, quadCenter } from '../src/core/gate-geometry.js';
import { makeTransform } from '../src/core/transforms.js';
import { exportGatingML, importGatingML } from '../src/core/gatingml.js';
import { mulberry32 } from '../src/core/demo-data.js';

function dataset(n = 20000, seed = 7) {
  const r = mulberry32(seed);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (r() - 0.1) * 300000;
    y[i] = (r() * r() - 0.05) * 200000;
  }
  return { n, x, y };
}

const specs = {
  X: { type: 'logicle', T: 262144, W: 0.6, M: 4.5, A: 0 },
  Y: { type: 'linear', min: 0, max: 262144 },
};

function ctxFor(d, pops = {}) {
  const tx = makeTransform(specs.X);
  const ty = makeTransform(specs.Y);
  const sx = tx.scaleArray(d.x);
  const sy = ty.scaleArray(d.y);
  return {
    N: d.n,
    values: (ch) => (ch === 'X' ? d.x : ch === 'Y' ? d.y : null),
    scaled: (ch) => (ch === 'X' ? sx : ch === 'Y' ? sy : null),
    transform: (ch) => (ch === 'X' ? tx : ty),
    pop: (id) => pops[id],
  };
}

const all = (n) => Uint32Array.from({ length: n }, (_, i) => i);

test('rectangle gate with open edges matches brute force', () => {
  const d = dataset();
  const ctx = ctxFor(d);
  const g = { id: 'r', type: 'rect', x: 'X', y: 'Y', parent: ROOT, rect: { x0: 1000, x1: null, y0: null, y1: 50000 } };
  const out = evaluateGate(g, all(d.n), ctx);
  let expect = 0;
  for (let i = 0; i < d.n; i++) if (d.x[i] >= 1000 && d.y[i] < 50000) expect++;
  assert.equal(out.length, expect);
});

test('polygon gate is evaluated in display space; converted rectangle is equivalent', () => {
  const d = dataset();
  const ctx = ctxFor(d);
  const tx = makeTransform(specs.X);
  const ty = makeTransform(specs.Y);
  const rect = { id: 'r', type: 'rect', x: 'X', y: 'Y', parent: ROOT, rect: { x0: 500, x1: 90000, y0: 10000, y1: 120000 } };
  const poly = toPolygon(rect, tx, ty);
  assert.equal(poly.type, 'polygon');
  assert.equal(poly.polygon.length, 4);
  const a = evaluateGate(rect, all(d.n), ctx);
  const b = evaluateGate(poly, all(d.n), ctx);
  // boundaries may differ for events exactly on an edge only
  assert.ok(Math.abs(a.length - b.length) <= 2, `${a.length} vs ${b.length}`);
  // open-ended rectangle converted to polygon still includes off-scale events
  const open = { id: 'o', type: 'rect', x: 'X', y: 'Y', parent: ROOT, rect: { x0: 500, x1: null, y0: null, y1: null } };
  const op = toPolygon(open, tx, ty);
  assert.ok(Math.abs(ty.scale(op.polygon[2][1]) - EDGE_HI) < 1e-9);
  const ra = evaluateGate(open, all(d.n), ctx).length;
  const rb = evaluateGate(op, all(d.n), ctx).length;
  assert.ok(Math.abs(ra - rb) <= 2, `${ra} vs ${rb}`);
});

test('ellipse gate, its polygon conversion and translation', () => {
  const d = dataset();
  const ctx = ctxFor(d);
  const tx = makeTransform(specs.X);
  const ty = makeTransform(specs.Y);
  const e = { id: 'e', type: 'ellipse', x: 'X', y: 'Y', parent: ROOT, ellipse: ellipseFromBox([0.4, 0.2], [0.8, 0.5], tx, ty) };
  const n1 = evaluateGate(e, all(d.n), ctx).length;
  // brute force in scale space
  let expect = 0;
  for (let i = 0; i < d.n; i++) {
    const sx = Math.min(1, Math.max(0, tx.scale(d.x[i])));
    const sy = Math.min(1, Math.max(0, ty.scale(d.y[i])));
    const u = (sx - 0.6) / 0.2;
    const v = (sy - 0.35) / 0.15;
    if (u * u + v * v <= 1) expect++;
  }
  assert.ok(Math.abs(n1 - expect) <= 3, `${n1} vs ${expect}`);
  const p = toPolygon(e, tx, ty);
  const n2 = evaluateGate(p, all(d.n), ctx).length;
  assert.ok(Math.abs(n1 - n2) / n1 < 0.02, `${n1} vs ${n2}`);
  const moved = { ...e, ...translateGeometry(e, 0.1, 0, tx, ty) };
  assert.ok(Math.abs(tx.scale(moved.ellipse.c[0]) - 0.7) < 1e-9);
});

test('quadrants partition the parent exactly', () => {
  const d = dataset();
  const ctx = ctxFor(d);
  const names = quadrantNames('CD4', 'CD8');
  const qs = makeQuadrant({ parent: ROOT, x: 'X', y: 'Y', center: [2000, 60000], names, colors: ['#1', '#2', '#3', '#4'] });
  const total = qs.reduce((a, g) => a + evaluateGate(g, all(d.n), ctx).length, 0);
  assert.equal(total, d.n);
  assert.deepEqual(quadCenter(qs[3]), [2000, 60000]);
  assert.equal(qs[1].name, 'CD4+ CD8+');
  const sp = makeSplit({ parent: ROOT, x: 'X', threshold: 100, names: ['neg', 'pos'], colors: ['#1', '#2'] });
  const t2 = sp.reduce((a, g) => a + evaluateGate(g, all(d.n), ctx).length, 0);
  assert.equal(t2, d.n);
});

test('boolean gates and ordering', () => {
  const d = dataset();
  const A = { id: 'A', type: 'range', x: 'X', parent: ROOT, range: { lo: 0, hi: null } };
  const B = { id: 'B', type: 'range', x: 'Y', parent: ROOT, range: { lo: 50000, hi: null } };
  const pops = {};
  const ctx = ctxFor(d, pops);
  pops.A = evaluateGate(A, all(d.n), ctx);
  pops.B = evaluateGate(B, all(d.n), ctx);
  const and = { id: 'C', type: 'boolean', parent: ROOT, boolean: { op: 'and', refs: [{ id: 'A' }, { id: 'B', not: true }] } };
  const or = { id: 'D', type: 'boolean', parent: ROOT, boolean: { op: 'or', refs: [{ id: 'A' }, { id: 'B' }] } };
  let e1 = 0;
  let e2 = 0;
  for (let i = 0; i < d.n; i++) {
    const a = d.x[i] >= 0;
    const b = d.y[i] >= 50000;
    if (a && !b) e1++;
    if (a || b) e2++;
  }
  assert.equal(evaluateGate(and, all(d.n), ctx).length, e1);
  assert.equal(evaluateGate(or, all(d.n), ctx).length, e2);
  const { ordered, invalid } = orderGates([and, A, B, { id: 'Z', parent: 'missing', type: 'range', x: 'X', range: {} }, { id: 'L1', parent: 'L2', type: 'range', x: 'X', range: {} }, { id: 'L2', parent: 'L1', type: 'range', x: 'X', range: {} }]);
  assert.deepEqual(ordered.map((g) => g.id), ['A', 'B', 'C']);
  assert.ok(invalid.has('Z') && invalid.has('L1') && invalid.has('L2'));
});

test('overrides replace geometry only', () => {
  const g = { id: 'g', name: 'G', type: 'rect', x: 'X', y: 'Y', parent: ROOT, rect: { x0: 1, x1: 2, y0: 3, y1: 4 } };
  const e = applyOverride(g, { rect: { x0: 5, x1: 6, y0: 7, y1: 8 } });
  assert.equal(e.name, 'G');
  assert.equal(e.rect.x0, 5);
  assert.equal(g.rect.x0, 1);
});

test('rectangle from scale snaps edges to unbounded', () => {
  const tx = makeTransform(specs.X);
  const ty = makeTransform(specs.Y);
  const r = rectFromScale([-0.1, 0.5], [0.5, 1.2], tx, ty);
  assert.equal(r.x0, null);
  assert.equal(r.y1, null);
  assert.ok(Math.abs(ty.scale(r.y0) - 0.5) < 1e-9);
});

test('Gating-ML round trip preserves populations', () => {
  const d = dataset();
  const tx = makeTransform(specs.X);
  const ty = makeTransform(specs.Y);
  const gates = [
    { id: 'p1', name: 'Cells', type: 'polygon', x: 'X', y: 'Y', parent: ROOT, color: '#1f77d0', polygon: [[1000, 10000], [150000, 20000], [200000, 150000], [500, 120000]] },
    { id: 'r1', name: 'Bright & tall', type: 'rect', x: 'X', y: 'Y', parent: 'p1', color: '#d6336c', rect: { x0: 20000, x1: null, y0: 60000, y1: null } },
    { id: 'e1', name: 'Blob', type: 'ellipse', x: 'X', y: 'Y', parent: 'p1', color: '#2b9a66', ellipse: ellipseFromBox([0.5, 0.2], [0.9, 0.6], tx, ty) },
    { id: 'n1', name: 'Range', type: 'range', x: 'X', parent: ROOT, color: '#7048e8', range: { lo: null, hi: 3000 } },
    ...makeQuadrant({ parent: 'p1', x: 'X', y: 'Y', center: [5000, 80000], names: quadrantNames('A', 'B'), colors: ['#1', '#2', '#3', '#4'] }),
  ];
  gates.push({ id: 'b1', name: 'Bool', type: 'boolean', parent: 'p1', color: '#000', boolean: { op: 'and', refs: [{ id: 'e1' }, { id: 'r1', not: true }] } });
  const xml = exportGatingML({ gates, transforms: { X: specs.X, Y: specs.Y }, compensation: { mode: 'matrix', matrix: { name: 'Comp 1', names: ['X'], matrix: [[1]] } } });
  assert.ok(xml.includes('<gating:PolygonGate'));
  assert.ok(xml.includes('transforms:logicle'));
  const imp = importGatingML(xml);
  assert.equal(imp.warnings.length, 0, imp.warnings.join('; '));
  assert.equal(imp.gates.length, gates.length);
  assert.equal(imp.transforms.X.type, 'logicle');
  assert.equal(imp.compensation.mode, 'matrix');
  // Evaluate both hierarchies and compare counts by name
  const evalAll = (list) => {
    const pops = {};
    const ctx = ctxFor(d, pops);
    const { ordered } = orderGates(list);
    const counts = {};
    for (const g of ordered) {
      const parent = g.parent === ROOT ? all(d.n) : pops[g.parent];
      pops[g.id] = evaluateGate(g, parent, ctx);
      counts[g.name] = pops[g.id].length;
    }
    return counts;
  };
  const c1 = evalAll(gates);
  const c2 = evalAll(imp.gates);
  for (const k of Object.keys(c1)) assert.ok(Math.abs(c1[k] - c2[k]) <= 2, `${k}: ${c1[k]} vs ${c2[k]}`);
  // quadrant links survive
  const linked = imp.gates.filter((g) => g.link && g.link.kind === 'quad');
  assert.equal(linked.length, 4);
  assert.equal(new Set(linked.map((g) => g.link.group)).size, 1);
});

test('Gating-ML import of a standard QuadrantGate and transforms', () => {
  const xml = `<?xml version="1.0"?>
  <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
    <transforms:transformation transforms:id="L"><transforms:flin transforms:T="1000" transforms:A="0"/></transforms:transformation>
    <gating:QuadrantGate gating:id="Q">
      <gating:divider gating:id="D1" gating:compensation-ref="uncompensated" gating:transformation-ref="L"><data-type:fcs-dimension data-type:name="FL1"/><gating:value>0.5</gating:value></gating:divider>
      <gating:divider gating:id="D2" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL2"/><gating:value>200</gating:value></gating:divider>
      <gating:Quadrant gating:id="PP"><gating:position gating:divider_ref="D1" gating:location="0.8"/><gating:position gating:divider_ref="D2" gating:location="300"/></gating:Quadrant>
      <gating:Quadrant gating:id="NP"><gating:position gating:divider_ref="D2" gating:location="300"/><gating:position gating:divider_ref="D1" gating:location="0.1"/></gating:Quadrant>
      <gating:Quadrant gating:id="PN"><gating:position gating:divider_ref="D1" gating:location="0.8"/><gating:position gating:divider_ref="D2" gating:location="100"/></gating:Quadrant>
      <gating:Quadrant gating:id="NN"><gating:position gating:divider_ref="D1" gating:location="0.1"/><gating:position gating:divider_ref="D2" gating:location="100"/></gating:Quadrant>
    </gating:QuadrantGate>
    <gating:RectangleGate gating:id="Child" gating:parent_id="PP"><gating:dimension gating:min="600"><data-type:fcs-dimension data-type:name="FL2"/></gating:dimension></gating:RectangleGate>
  </gating:Gating-ML>`;
  const imp = importGatingML(xml);
  assert.equal(imp.gates.length, 5);
  const pp = imp.gates.find((g) => g.name === 'PP');
  assert.equal(pp.x, 'FL1');
  assert.equal(pp.rect.x0, 500); // 0.5 on flin(T=1000) -> 500
  assert.equal(pp.rect.y0, 200);
  assert.equal(pp.link.role, 'UR');
  const np = imp.gates.find((g) => g.name === 'NP');
  assert.equal(np.x, 'FL1');
  assert.equal(np.link.role, 'UL');
  const child = imp.gates.find((g) => g.name === 'Child');
  assert.equal(child.parent, pp.id);
  assert.equal(child.type, 'range');
  assert.equal(child.range.lo, 600);
});

test('Gating-ML import: 3-D quadrant, ratio parameter and hyperlog scale evaluate like brute force', async () => {
  const { Engine } = await import('../src/engine/engine.js');
  const { writeFCS } = await import('../src/core/fcs-write.js');
  const r = mulberry32(11);
  const n = 8000;
  const cols = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    cols[0][i] = r() * 1000;
    cols[1][i] = r() * 1000;
    cols[2][i] = 1 + r() * 999;
  }
  const channels = ['A', 'B', 'C'].map((name) => ({ name, label: '', range: 1024 }));
  const bytes = writeFCS({ channels, columns: cols, nEvents: n });
  const xml = `<?xml version="1.0"?>
  <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
    <transforms:transformation transforms:id="R"><transforms:fratio transforms:A="2" transforms:B="10" transforms:C="0"><data-type:fcs-dimension data-type:name="A"/><data-type:fcs-dimension data-type:name="C"/></transforms:fratio></transforms:transformation>
    <transforms:transformation transforms:id="H"><transforms:hyperlog transforms:T="1000" transforms:W="1" transforms:M="4.5" transforms:A="0"/></transforms:transformation>
    <gating:QuadrantGate gating:id="Q3">
      <gating:divider gating:id="DA" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="A"/><gating:value>300</gating:value><gating:value>700</gating:value></gating:divider>
      <gating:divider gating:id="DB" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="B"/><gating:value>500</gating:value></gating:divider>
      <gating:divider gating:id="DC" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="C"/><gating:value>250</gating:value></gating:divider>
      <gating:Quadrant gating:id="Mid-Lo-Hi"><gating:position gating:divider_ref="DA" gating:location="500"/><gating:position gating:divider_ref="DB" gating:location="100"/><gating:position gating:divider_ref="DC" gating:location="900"/></gating:Quadrant>
      <gating:Quadrant gating:id="Hi-any-Lo"><gating:position gating:divider_ref="DA" gating:location="800"/><gating:position gating:divider_ref="DC" gating:location="10"/></gating:Quadrant>
    </gating:QuadrantGate>
    <gating:RectangleGate gating:id="Ratio"><gating:dimension gating:min="1" gating:max="4" gating:compensation-ref="uncompensated"><data-type:new-dimension data-type:transformation-ref="R"/></gating:dimension></gating:RectangleGate>
    <gating:RectangleGate gating:id="Hyper"><gating:dimension gating:min="0.6" gating:compensation-ref="uncompensated" gating:transformation-ref="H"><data-type:fcs-dimension data-type:name="B"/></gating:dimension></gating:RectangleGate>
  </gating:Gating-ML>`;
  const imp = importGatingML(xml);
  assert.equal(imp.derived.length, 1);
  assert.equal(imp.transforms.B.type, 'hyperlog');
  const e = new Engine();
  e.handle('load', { id: 's', name: 's', buffer: bytes.buffer });
  e.handle('setTransforms', { transforms: imp.transforms });
  e.handle('setDerived', { derived: imp.derived });
  e.handle('setGates', { gates: imp.gates, overrides: {} });
  const { counts, errors } = e.handle('counts', { id: 's' }).result;
  assert.deepEqual(errors, {});
  const byName = Object.fromEntries(imp.gates.map((g) => [g.name, counts[g.id]]));
  const [A, B, C] = cols;
  const hb = makeTransform(imp.transforms.B);
  const want = { 'Mid-Lo-Hi': 0, 'Hi-any-Lo': 0, Ratio: 0, Hyper: 0 };
  for (let i = 0; i < n; i++) {
    if (A[i] >= 300 && A[i] < 700 && B[i] < 500 && C[i] >= 250) want['Mid-Lo-Hi']++;
    if (A[i] >= 700 && C[i] < 250) want['Hi-any-Lo']++;
    const ratio = (2 * (A[i] - 10)) / C[i];
    if (ratio >= 1 && ratio < 4) want.Ratio++;
    if (hb.scale(B[i]) >= 0.6) want.Hyper++;
  }
  for (const k of Object.keys(want)) assert.equal(byName[k], want[k], k);
  // the 3-D region is an AND of a 2-D and a 1-D part, all under the same parent
  const q = imp.gates.find((g) => g.name === 'Mid-Lo-Hi');
  assert.equal(q.type, 'boolean');
  assert.equal(q.boolean.refs.length, 2);
  assert.ok(imp.warnings.some((w) => w.includes('Mid-Lo-Hi')));
});
