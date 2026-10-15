import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine/engine.js';
import { generateSample, demoManifest, DEMO_DETECTORS, DEMO_SPILL } from '../src/core/demo-data.js';
import { parseFCS } from '../src/core/fcs-parse.js';
import { ROOT } from '../src/core/gates.js';

test('demo generator produces valid FCS with spillover', () => {
  const bytes = generateSample({ kind: 'cells', donor: 'PBMC_Donor01', seed: 101, events: 20000, name: 'PBMC_Donor01' });
  const p = parseFCS(bytes);
  assert.equal(p.nEvents, 20000);
  assert.equal(p.channels.length, 12);
  assert.deepEqual(p.spillover.names, DEMO_DETECTORS);
  assert.equal(p.channels[6].label, 'CD3');
  const m = demoManifest();
  assert.equal(m.length, 11);
});

test('engine: load, compensate, gate, plot, stats, export', () => {
  const e = new Engine();
  const bytes = generateSample({ kind: 'cells', donor: 'PBMC_Donor01', seed: 101, events: 30000, name: 'S1' });
  const meta = e.handle('load', { id: 's1', name: 'S1', buffer: bytes.buffer }).result;
  assert.equal(meta.nEvents, 30000);
  const fitc = meta.channels.find((c) => c.name === 'FITC-A');
  assert.ok(fitc.suggest.W >= 0 && fitc.suggest.W <= 2.25);

  e.handle('setTransforms', { transforms: { 'FITC-A': { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 }, 'PE-A': { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 } } });
  // compensate with the true matrix: CD3+ cells should have PE (CD56) near zero
  e.handle('setComp', { id: 's1', comp: { names: DEMO_DETECTORS, matrix: DEMO_SPILL } });
  const gates = [
    { id: 'cells', name: 'Cells', parent: ROOT, type: 'rect', x: 'FSC-A', y: 'SSC-A', rect: { x0: 45000, x1: 80000, y0: 8000, y1: 30000 } },
    { id: 't', name: 'T', parent: 'cells', type: 'range', x: 'FITC-A', range: { lo: 3000, hi: null } },
    { id: 'poly', name: 'P', parent: 'cells', type: 'polygon', x: 'FITC-A', y: 'PE-A', polygon: [[3000, -2000], [200000, -2000], [200000, 1500], [3000, 1500]] },
  ];
  e.handle('setGates', { gates, overrides: {} });
  const { counts, errors } = e.handle('counts', { id: 's1' }).result;
  assert.deepEqual(errors, {});
  assert.ok(counts.cells > 10000, `cells ${counts.cells}`);
  assert.ok(counts.t > 0.5 * counts.cells, `T ${counts.t}`);
  // after correct compensation most T cells sit in the PE-negative band
  assert.ok(counts.poly > 0.85 * counts.t, `poly ${counts.poly} of ${counts.t}`);

  const plot = e.handle('plot', { id: 's1', req: { pop: 'cells', x: 'FITC-A', y: 'PE-A', w: 100, h: 80, overlays: ['t'] } });
  const sum = plot.result.counts.reduce((a, b) => a + b, 0);
  assert.equal(sum, counts.cells);
  assert.equal(plot.result.overlays[0].counts.reduce((a, b) => a + b, 0), counts.t);
  const hist = e.handle('plot', { id: 's1', req: { pop: 't', x: 'FITC-A', bins: 128 } });
  assert.equal(hist.result.counts.reduce((a, b) => a + b, 0), counts.t);

  const st = e.handle('stats', { id: 's1', reqs: [{ pop: 't', channel: 'FITC-A', stat: 'median' }, { pop: 't', channel: 'PE-A', stat: 'median' }, { pop: 't', channel: 'FITC-A', stat: 'mode' }] }).result;
  assert.ok(st[0] > 5000 && st[0] < 30000, `median FITC ${st[0]}`);
  assert.ok(Math.abs(st[1]) < 400, `median PE ${st[1]}`);
  assert.ok(st[2] > 3000);

  // override geometry for this sample only
  e.handle('setGates', { gates, overrides: { s1: { t: { range: { lo: 1e9, hi: null } } } } });
  assert.equal(e.handle('counts', { id: 's1' }).result.counts.t, 0);
  e.handle('setOverrides', { overrides: {} });
  assert.equal(e.handle('counts', { id: 's1' }).result.counts.t, counts.t);

  // export population as FCS and read back
  const ex = e.handle('exportFCS', { id: 's1', pop: 't', extra: { KESTREL_POPULATION: 'Cells/T' } }).result;
  const back = parseFCS(ex.buffer);
  assert.equal(back.nEvents, counts.t);
  assert.equal(back.keywords.KESTREL_POPULATION, 'Cells/T');
  assert.ok(back.spillover);
  const csv = new TextDecoder().decode(e.handle('exportCSV', { id: 's1', pop: 't', channels: ['FSC-A', 'FITC-A'] }).result.buffer);
  assert.equal(csv.trim().split('\n').length, counts.t + 1);

  // transform change invalidates polygon population but not range gate
  e.handle('setTransforms', { transforms: { 'FITC-A': { type: 'logicle', T: 262144, W: 1.5, M: 4.5, A: 0 }, 'PE-A': { type: 'linear', min: -5000, max: 50000 } } });
  const c2 = e.handle('counts', { id: 's1' }).result.counts;
  assert.equal(c2.t, counts.t);
});

test('engine: spillover estimate from simulated single-stain beads', () => {
  const e = new Engine();
  const det = DEMO_DETECTORS;
  const ids = [];
  det.forEach((d, i) => {
    const b = generateSample({ kind: 'bead', dye: i, seed: 910 + i, events: 8000, name: `Comp_${d}` });
    e.handle('load', { id: d, name: d, buffer: b.buffer });
    ids.push(d);
  });
  const est = det.map((d) => {
    const r = e.handle('controlMedians', { id: d, primary: d, channels: det }).result;
    return { primary: d, pos: r.pos, neg: r.neg };
  });
  // FITC -> PE true value 0.24
  const fitc = est[2];
  const v = (fitc.pos['PE-A'] - fitc.neg['PE-A']) / (fitc.pos['FITC-A'] - fitc.neg['FITC-A']);
  assert.ok(Math.abs(v - 0.24) < 0.01, `FITC->PE ${v}`);
  const pc = est[4];
  const v2 = (pc.pos['PE-Cy7-A'] - pc.neg['PE-Cy7-A']) / (pc.pos['PerCP-Cy5-5-A'] - pc.neg['PerCP-Cy5-5-A']);
  assert.ok(Math.abs(v2 - 0.18) < 0.01, `PerCP->PE-Cy7 ${v2}`);
});
