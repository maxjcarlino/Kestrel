import test from 'node:test';
import assert from 'node:assert/strict';

import { Logicle, FastLogicle, estimateLogicleW } from '../src/core/logicle.js';
import { makeTransform, normalizeSpec, arcsinhFromGatingML, formatValue } from '../src/core/transforms.js';
import { parseFCS, parseTextSegment, parseSpillover, classifyChannel } from '../src/core/fcs-parse.js';
import { writeFCS, spilloverToString } from '../src/core/fcs-write.js';
import { invertMatrix, multiply, compensateColumns, matchChannels, spilloverFromMedians } from '../src/core/compensation.js';
import { channelStats, percentileSorted } from '../src/core/stats.js';
import { makeZip, listZip, crc32 } from '../src/core/zip.js';
import { parseEventTable, toCSV } from '../src/core/csv.js';
import { parseXml, attr } from '../src/core/xml.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

// ------------------------------------------------------------ logicle

test('logicle: anchor points', () => {
  const l = new Logicle(262144, 0.5, 4.5, 0);
  close(l.scale(262144), 1, 1e-12, 'top');
  close(l.scale(0), 0.5 / 4.5, 1e-12, 'zero');
  close(l.inverse(1), 262144, 1e-6, 'inverse top');
  close(l.inverse(0.5 / 4.5), 0, 1e-9, 'inverse zero');
});

test('logicle: round trips and symmetry', () => {
  for (const [T, W, M, A] of [[262144, 0.5, 4.5, 0], [10000, 1, 4.5, 0], [262144, 0, 4.5, 0], [1e6, 0.8, 5.5, 0.5], [262144, 1.2, 4.5, -0.3]]) {
    const l = new Logicle(T, W, M, A);
    for (const x of [-5000, -100, -1, 0, 0.5, 1, 10, 100, 1000, 12345, T / 2, T, T * 3]) {
      const s = l.scale(x);
      const back = l.inverse(s);
      close(back, x, Math.max(1e-6, Math.abs(x) * 1e-9), `roundtrip T=${T} W=${W} x=${x}`);
    }
    // odd symmetry around x1
    for (const x of [1, 50, 1000]) close(l.scale(-x), 2 * l.x1 - l.scale(x), 1e-12, 'symmetry');
  }
});

test('logicle: monotone and near-log at the top', () => {
  const l = new Logicle(262144, 0.5, 4.5, 0);
  let prev = -Infinity;
  for (let x = -2000; x < 262144; x += 137) {
    const s = l.scale(x);
    assert.ok(s > prev);
    prev = s;
  }
  // one decade near the top spans ~1/M of the scale
  close(l.scale(262144) - l.scale(26214.4), 1 / 4.5, 0.01, 'decade');
});

test('fast logicle matches exact', () => {
  const l = new Logicle(262144, 0.7, 4.5, 0);
  const f = new FastLogicle(l);
  const xs = new Float32Array(20000);
  for (let i = 0; i < xs.length; i++) xs[i] = (Math.random() - 0.1) * 300000 * Math.random() ** 3;
  const out = f.scaleArray(xs);
  for (let i = 0; i < xs.length; i++) close(out[i], l.scale(xs[i]), 2e-6, 'fast');
});

test('estimate logicle W from negative spread', () => {
  const vals = new Float32Array(10000);
  for (let i = 0; i < vals.length; i++) vals[i] = (i % 2 ? 1 : -1) * Math.random() * 800;
  const w = estimateLogicleW(vals, 262144, 4.5, 0);
  assert.ok(w > 0.4 && w < 1.2, `W=${w}`);
  assert.equal(estimateLogicleW(new Float32Array([1, 2, 3]), 262144), 0);
});

// ------------------------------------------------------------ transforms

test('transforms: scale/inverse for all types', () => {
  const specs = [
    { type: 'linear', min: -1000, max: 262144 },
    { type: 'log', decades: 5, max: 262144 },
    { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 },
    { type: 'arcsinh', cofactor: 150, max: 262144, min: -500 },
  ];
  for (const sp of specs) {
    const t = makeTransform(sp);
    close(t.scale(t.inverse(0)), 0, 1e-9, sp.type);
    close(t.scale(t.inverse(1)), 1, 1e-9, sp.type);
    close(t.inverse(t.scale(5000)), 5000, 1e-3, sp.type);
    const arr = t.scaleArray(new Float32Array([100, 1000, 10000]));
    close(arr[1], t.scale(1000), 1e-5, sp.type + ' array');
    const ticks = t.ticks();
    assert.ok(ticks.length > 2, sp.type + ' ticks');
    for (const tk of ticks) assert.ok(tk.s >= -1e-6 && tk.s <= 1 + 1e-6, `${sp.type} tick ${tk.v} at ${tk.s}`);
  }
});

test('arcsinh <-> gating-ml fasinh', () => {
  const t = makeTransform({ type: 'arcsinh', cofactor: 5, max: 10000, min: -20 });
  const g = t.gatingML();
  const back = arcsinhFromGatingML(g.T, g.M, g.A);
  close(back.cofactor, 5, 1e-9);
  close(back.min, -20, 1e-6);
  // Gating-ML formula directly
  const fasinh = (x) => (Math.asinh((x * Math.sinh(g.M * Math.LN10)) / g.T) + g.A * Math.LN10) / ((g.M + g.A) * Math.LN10);
  for (const x of [-20, 0, 5, 300, 10000]) close(t.scale(x), fasinh(x), 1e-9);
});

test('normalizeSpec keeps logicle parameters valid', () => {
  const s = normalizeSpec({ type: 'logicle', T: 262144, W: 9, M: 4.5, A: 3 });
  assert.ok(2 * s.W <= s.M);
  assert.ok(s.A + 2 * s.W <= s.M + 1e-9);
  assert.doesNotThrow(() => makeTransform(s));
});

test('formatValue', () => {
  assert.equal(formatValue(0), '0');
  assert.equal(formatValue(50000, 50000), '50K');
  assert.equal(formatValue(250000, 50000), '250K');
  assert.equal(formatValue(1500000, 500000), '1.5M');
  assert.equal(formatValue(-200, 100), '−200');
});

// ------------------------------------------------------------ FCS

function buildFCS({ version = 'FCS3.1', text, data, delim = '/' }) {
  // text: array of [k, v]; offsets are filled in
  const enc = new TextEncoder();
  const mk = (b, e) => {
    let s = delim;
    for (const [k, v] of text) s += k.split(delim).join(delim + delim) + delim + String(v).split(delim).join(delim + delim) + delim;
    s += `$BEGINDATA${delim}${b}${delim}$ENDDATA${delim}${e}${delim}`;
    return enc.encode(s);
  };
  let b = 0;
  let e = 0;
  let t;
  for (let i = 0; i < 6; i++) {
    t = mk(b, e);
    const nb = 58 + t.length;
    const ne = nb + data.length - 1;
    if (nb === b && ne === e) break;
    b = nb;
    e = ne;
  }
  const head = `${version}    ` + [58, 58 + t.length - 1, b, e, 0, 0].map((n) => String(n).padStart(8, ' ')).join('');
  const out = new Uint8Array(58 + t.length + data.length);
  out.set(enc.encode(head), 0);
  out.set(t, 58);
  out.set(data, 58 + t.length);
  return out;
}

test('FCS 3.1 float round trip through writer and reader', () => {
  const n = 1000;
  const cols = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    cols[0][i] = i * 10.5;
    cols[1][i] = -i;
    cols[2][i] = Math.sin(i) * 1000;
  }
  const bytes = writeFCS({
    channels: [{ name: 'FSC-A', range: 262144 }, { name: 'FITC-A', label: 'CD3 | test/x', range: 262144 }, { name: 'PE-A', label: '', range: 262144 }],
    columns: cols,
    nEvents: n,
    keywords: { $CYT: 'Test', 'WEIRD|KEY': 'a|b||c', EMPTY: '' },
    spillover: { names: ['FITC-A', 'PE-A'], matrix: [[1, 0.2], [0.01, 1]] },
  });
  const p = parseFCS(bytes);
  assert.equal(p.nEvents, n);
  assert.equal(p.channels.length, 3);
  assert.equal(p.channels[1].label, 'CD3 | test/x');
  assert.equal(p.keywords['WEIRD|KEY'], 'a|b||c');
  for (let i = 0; i < n; i += 97) {
    assert.equal(p.columns[0][i], cols[0][i]);
    assert.equal(p.columns[2][i], cols[2][i]);
  }
  assert.deepEqual(p.spillover.names, ['FITC-A', 'PE-A']);
  close(p.spillover.matrix[0][1], 0.2, 1e-12);
  // subset export
  const sub = writeFCS({ channels: [{ name: 'A', range: 10 }], columns: [cols[0]], nEvents: n, indices: new Uint32Array([5, 7, 9]) });
  const ps = parseFCS(sub);
  assert.equal(ps.nEvents, 3);
  assert.equal(ps.columns[0][1], cols[0][7]);
  // empty population
  const empty = writeFCS({ channels: [{ name: 'A', range: 10 }], columns: [cols[0]], nEvents: n, indices: new Uint32Array(0) });
  assert.equal(parseFCS(empty).nEvents, 0);
});

test('FCS 2.0 big-endian 16-bit integers with log amplification and masks', () => {
  const n = 4;
  const P = 2;
  const vals = [[0, 1023, 512, 2048 + 100], [10, 20, 30, 40]];
  const data = new Uint8Array(n * P * 2);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < n; i++) for (let p = 0; p < P; p++) dv.setUint16((i * P + p) * 2, vals[p][i], false);
  const bytes = buildFCS({
    version: 'FCS2.0',
    text: [['$PAR', 2], ['$TOT', n], ['$DATATYPE', 'I'], ['$BYTEORD', '4,3,2,1'], ['$MODE', 'L'], ['$P1N', 'FL1-H'], ['$P1B', 16], ['$P1R', 1024], ['$P1E', '4,0'], ['$P2N', 'FSC-H'], ['$P2B', 16], ['$P2R', 1024], ['$P2E', '0,0']],
    data,
  });
  const p = parseFCS(bytes);
  assert.equal(p.nEvents, 4);
  // log decode: 10^(4 * x / 1024) * 1
  close(p.columns[0][0], 1, 1e-6);
  close(p.columns[0][1], Math.pow(10, (4 * 1023) / 1024), 1e-2);
  // masked: 2148 & 1023 = 100
  close(p.columns[0][3], Math.pow(10, (4 * 100) / 1024), 1e-3);
  assert.equal(p.columns[1][2], 30);
  assert.ok(p.channels[0].logAmplified);
});

test('FCS 3.2 mixed parameter data types ($PnDATATYPE)', () => {
  const n = 3;
  // per event: uint16 (I), float32 (F), float64 (D), little endian
  const data = new Uint8Array(n * 14);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < n; i++) {
    dv.setUint16(i * 14, 100 + i, true);
    dv.setFloat32(i * 14 + 2, -1.5 * i, true);
    dv.setFloat64(i * 14 + 6, 1e6 + i / 3, true);
  }
  const bytes = buildFCS({
    version: 'FCS3.2',
    text: [['$PAR', 3], ['$TOT', n], ['$DATATYPE', 'I'], ['$BYTEORD', '1,2,3,4'], ['$MODE', 'L'], ['$P1N', 'Time'], ['$P1B', 16], ['$P1R', 65536], ['$P2N', 'FSC-A'], ['$P2B', 32], ['$P2R', 262144], ['$P2DATATYPE', 'F'], ['$P3N', 'Big'], ['$P3B', 64], ['$P3R', 4e6], ['$P3DATATYPE', 'D']],
    data,
  });
  const p = parseFCS(bytes);
  assert.equal(p.nEvents, 3);
  assert.deepEqual(p.channels.map((c) => c.type), ['I', 'F', 'D']);
  assert.equal(p.columns[0][2], 102);
  assert.equal(p.columns[1][2], -3);
  close(p.columns[2][1], 1e6 + 1 / 3, 0.07);
});

test('FCS text segment: escaped delimiters and empty-value fallback', () => {
  const enc = new TextEncoder();
  const a = parseTextSegment(enc.encode('/$PAR/1/$DATATYPE/F/$BYTEORD/1,2,3,4/$P1S/A//B/'));
  assert.equal(a.$P1S, 'A/B');
  // An empty value (illegal but common) should not swallow the next keyword
  const b = parseTextSegment(enc.encode('/$PAR/1/$P1S//$DATATYPE/F/$BYTEORD/1,2,3,4/'));
  assert.equal(b.$DATATYPE, 'F');
});

test('FCS gain and multiple data sets', () => {
  const n = 3;
  const f = new Float32Array([100, 200, 300]);
  const data = new Uint8Array(f.buffer);
  const one = buildFCS({ text: [['$PAR', 1], ['$TOT', n], ['$DATATYPE', 'F'], ['$BYTEORD', '1,2,3,4'], ['$MODE', 'L'], ['$P1N', 'FL1-A'], ['$P1B', 32], ['$P1R', 262144], ['$P1E', '0,0'], ['$P1G', '2'], ['$NEXTDATA', 0]], data });
  const p = parseFCS(one);
  close(p.columns[0][2], 150, 1e-6, 'gain applied');
  const p2 = parseFCS(one, { applyGain: false });
  close(p2.columns[0][2], 300, 1e-6, 'gain ignored');
  // concatenate two datasets
  const two = new Uint8Array(one.length * 2);
  // patch NEXTDATA of first dataset: rebuild with correct offset
  const first = buildFCS({ text: [['$PAR', 1], ['$TOT', n], ['$DATATYPE', 'F'], ['$BYTEORD', '1,2,3,4'], ['$MODE', 'L'], ['$P1N', 'FL1-A'], ['$P1B', 32], ['$P1R', 262144], ['$NEXTDATA', String(one.length).padStart(8, '0')]], data });
  two.set(first, 0);
  const f2 = new Float32Array([7, 8, 9]);
  const second = buildFCS({ text: [['$PAR', 1], ['$TOT', n], ['$DATATYPE', 'F'], ['$BYTEORD', '1,2,3,4'], ['$MODE', 'L'], ['$P1N', 'FL1-A'], ['$P1B', 32], ['$P1R', 262144], ['$NEXTDATA', 0]], data: new Uint8Array(f2.buffer) });
  const all = new Uint8Array(first.length + second.length);
  all.set(first, 0);
  all.set(second, first.length);
  // NEXTDATA must point at the second header
  const fixed = buildFCS({ text: [['$PAR', 1], ['$TOT', n], ['$DATATYPE', 'F'], ['$BYTEORD', '1,2,3,4'], ['$MODE', 'L'], ['$P1N', 'FL1-A'], ['$P1B', 32], ['$P1R', 262144], ['$NEXTDATA', String(first.length).padStart(8, '0')]], data });
  assert.equal(fixed.length, first.length);
  all.set(fixed, 0);
  const d1 = parseFCS(all, { dataset: 1 });
  assert.equal(d1.datasetCount, 2);
  close(d1.columns[0][0], 7, 1e-6);
  void two;
});

test('spillover keyword parsing', () => {
  const s = parseSpillover('2,FITC-A,PE-A,1,0.1,0.02,1');
  assert.deepEqual(s.names, ['FITC-A', 'PE-A']);
  assert.deepEqual(s.matrix, [[1, 0.1], [0.02, 1]]);
  assert.equal(parseSpillover('3,a,b'), null);
  assert.equal(spilloverToString(s), '2,FITC-A,PE-A,1,0.1,0.02,1');
});

test('channel classification', () => {
  assert.equal(classifyChannel('FSC-A'), 'scatter');
  assert.equal(classifyChannel('SSC-B-A'), 'scatter');
  assert.equal(classifyChannel('Time'), 'time');
  assert.equal(classifyChannel('FITC-A'), 'fluor');
  assert.equal(classifyChannel('(Ir191)Di'), 'mass');
  assert.equal(classifyChannel('Event_length'), 'other');
});

// ------------------------------------------------------------ compensation

test('matrix inversion and compensation recover true signals', () => {
  const S = [[1, 0.2, 0.05], [0.01, 1, 0.15], [0, 0.03, 1]];
  const inv = invertMatrix(S);
  const I = multiply(S, inv);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(I[i][j], i === j ? 1 : 0, 1e-12);
  const n = 500;
  const truth = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) truth[k][i] = Math.random() * 10000;
  const raw = [0, 1, 2].map((j) => {
    const col = new Float32Array(n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) col[i] += truth[k][i] * S[k][j];
    return col;
  });
  const comp = compensateColumns(raw, [0, 1, 2], inv, n);
  for (let i = 0; i < n; i += 50) for (let k = 0; k < 3; k++) close(comp[k][i], truth[k][i], 0.05);
  assert.throws(() => invertMatrix([[1, 1], [1, 1]]));
});

test('channel matching and spillover from medians', () => {
  const chans = [{ name: 'FSC-A' }, { name: 'FITC-A', label: 'CD3' }, { name: 'PE-A' }];
  assert.deepEqual(matchChannels(['fitc-a', 'Comp-PE-A', 'CD3', 'nope'], chans), [1, 2, 1, -1]);
  const m = spilloverFromMedians(['FITC-A', 'PE-A'], [
    { primary: 'FITC-A', pos: { 'FITC-A': 10100, 'PE-A': 2100 }, neg: { 'FITC-A': 100, 'PE-A': 100 } },
    { primary: 'PE-A', pos: { 'FITC-A': 150, 'PE-A': 5100 }, neg: { 'FITC-A': 100, 'PE-A': 100 } },
  ]);
  close(m.matrix[0][1], 0.2, 1e-9);
  close(m.matrix[1][0], 0.01, 1e-9);
});

// ------------------------------------------------------------ stats, zip, csv, xml

test('statistics', () => {
  const v = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const idx = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const r = channelStats(v, idx, [{ stat: 'mean' }, { stat: 'median' }, { stat: 'sd' }, { stat: 'geomean' }, { stat: 'percentile', arg: 90 }, { stat: 'min' }, { stat: 'max' }, { stat: 'cv' }]);
  close(r.mean, 5.5, 1e-9);
  close(r.median, 5.5, 1e-9);
  close(r.sd, 3.0276503540974917, 1e-9);
  close(r.geomean, Math.exp([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reduce((a, x) => a + Math.log(x), 0) / 10), 1e-9);
  close(r['percentile:90'], 9.1, 1e-9);
  assert.equal(r.min, 1);
  assert.equal(r.max, 10);
  close(percentileSorted(new Float32Array([5]), 30), 5, 0);
});

test('zip round trip', () => {
  const z = makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }, { name: 'a.txt', data: 'dup' }]);
  const files = listZip(z);
  assert.equal(files.length, 3);
  assert.equal(new TextDecoder().decode(files[0].data), 'hello');
  assert.equal(files[2].name, 'a (2).txt');
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('csv', () => {
  assert.equal(toCSV([['a', 'b,c', 'd"e'], [1, NaN, 2.5]]), 'a,"b,c","d""e"\r\n1,,2.5\r\n');
  const t = parseEventTable('FSC-A;SSC-A\n1;2\n3;4\nbad;row\n');
  assert.deepEqual(t.channels, ['FSC-A', 'SSC-A']);
  assert.equal(t.nEvents, 2);
  assert.equal(t.columns[1][1], 4);
});

test('xml parser', () => {
  const doc = parseXml('<?xml version="1.0"?><!-- c --><a:root xmlns:a="x" a:id="r"><b k=\'1\'>t &amp; u</b><c/><![CDATA[<raw>]]></a:root>');
  const root = doc.children[0];
  assert.equal(root.local, 'root');
  assert.equal(attr(root, 'id'), 'r');
  assert.equal(root.children[0].text, 't & u');
  assert.equal(root.text, '<raw>');
});

import { Hyperlog } from '../src/core/hyperlog.js';

test('hyperlog: anchors, round trips, monotone', () => {
  const h = new Hyperlog(10000, 1, 4.5, 0);
  close(h.scale(10000), 1, 1e-9, 'top');
  close(h.scale(0), 1 / 4.5, 1e-12, 'zero at x1');
  let prev = -Infinity;
  for (const x of [-500, -10, -1, 0, 0.5, 3, 40, 900, 5000, 10000, 50000]) {
    const s = h.scale(x);
    assert.ok(s > prev, 'monotone');
    prev = s;
    close(h.inverse(s), x, Math.max(1e-7, Math.abs(x) * 1e-9), `round trip ${x}`);
  }
  const t = makeTransform({ type: 'hyperlog', T: 10000, W: 1, M: 4.5, A: 0 });
  const arr = t.scaleArray(new Float32Array([-200, 0, 37, 2500, 9999]));
  for (const [i, x] of [-200, 0, 37, 2500, 9999].entries()) close(arr[i], h.scale(x), 2e-6, 'fast');
});
