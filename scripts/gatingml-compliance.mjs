// Gating-ML 2.0 compliance check.
//
// Evaluates every gate of the Gating-ML 2.0 reference document on the
// reference data file with Kestrel's engine and compares event membership
// with the published results, event by event.
//
// The reference files are not part of this repository (they come from the
// gatingMLData package by J. Spidlen and N. Gopalakrishnan, GPL). They are
// downloaded from a pinned commit of the FlowKit repository, which carries a
// copy, and cached in .cache/gatingml2/.
//
//   node scripts/gatingml-compliance.mjs            download if needed, then check
//   node scripts/gatingml-compliance.mjs --dir DIR  use a local copy (data1.fcs, gml/, truth/)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine/engine.js';
import { importGatingML } from '../src/core/gatingml.js';
import { parseXml, attr, findAll } from '../src/core/xml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = 'f2159043b6a56e527d4baacf97490caf8354618e';
const BASE = `https://raw.githubusercontent.com/whitews/FlowKit/${COMMIT}/data/gate_ref`;
const SHA256 = {
  'data1.fcs': 'cba7812f5bbce700786d22d97cf9858c1301878aa840c64eadcd263a3a0a5508',
  'gml/gml_all_gates.xml': '10f0aa16abe0505ce97b66b36904f7ac94f008b011a7f9f3ecea240575c3914f',
};
const RESULTS = [
  'Range1', 'Range2', 'Rectangle1', 'Rectangle2', 'Rectangle3', 'Rectangle4', 'Rectangle5',
  'Polygon1', 'Polygon2', 'Polygon3NS', 'Polygon4', 'Ellipse1',
  'RatRange1', 'RatRange1a', 'RatRange2',
  'FL2N-FL4N', 'FL2N-FL4P', 'FL2P-FL4N', 'FL2P-FL4P',
  'FSCN-SSCN', 'FSCD-SSCN-FL1N', 'FSCP-SSCN-FL1N', 'FSCD-FL1P', 'FSCN-SSCP-FL1P',
  'And1', 'And2', 'And3', 'And4', 'Or1', 'Or2', 'Not1', 'ParAnd2', 'ParAnd3',
  'ScaleRange1', 'ScaleRange1c', 'ScaleRange2', 'ScaleRange2c', 'ScaleRange3', 'ScaleRange3c',
  'ScaleRange4', 'ScaleRange4c', 'ScaleRange5', 'ScaleRange5c', 'ScaleRange6', 'ScaleRange6c',
  'ScaleRange7c', 'ScaleRange8c', 'ScaleRect1', 'ScalePar1',
];

function argDir() {
  const i = process.argv.indexOf('--dir');
  return i > 0 ? path.resolve(process.argv[i + 1]) : null;
}

async function fetchTo(rel, dir) {
  const dest = path.join(dir, rel);
  if (fs.existsSync(dest)) return;
  const res = await fetch(`${BASE}/${rel}`);
  if (!res.ok) throw new Error(`Could not download ${rel}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function ensureData() {
  const local = argDir();
  if (local) return local;
  const dir = path.join(ROOT, '.cache', 'gatingml2');
  const files = ['data1.fcs', 'gml/gml_all_gates.xml', ...RESULTS.map((r) => `truth/Results_${r}.txt`)];
  let fetched = 0;
  for (const f of files) {
    if (!fs.existsSync(path.join(dir, f))) fetched++;
    await fetchTo(f, dir);
  }
  if (fetched) console.log(`Downloaded ${fetched} reference file${fetched > 1 ? 's' : ''} to ${path.relative(ROOT, dir)}/`);
  for (const [f, sum] of Object.entries(SHA256)) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    if (got !== sum) throw new Error(`${f} does not match the pinned checksum. Delete ${path.relative(ROOT, dir)}/ and run again.`);
  }
  return dir;
}

/** Compensation references used by each gate's dimensions. */
function compRefs(xml) {
  const root = parseXml(xml).children.find((c) => c.local === 'Gating-ML');
  const out = {};
  for (const el of root.children) {
    const id = attr(el, 'id');
    if (!id || !/Gate$/.test(el.local)) continue;
    const refs = [...findAll(el, 'dimension'), ...findAll(el, 'divider')].map((d) => attr(d, 'compensation-ref') || 'uncompensated');
    out[id] = [...new Set(refs)];
    if (el.local === 'QuadrantGate') for (const q of findAll(el, 'Quadrant')) out[attr(q, 'id')] = out[id];
  }
  return out;
}

function evaluate(buffer, imp, comp) {
  const e = new Engine();
  e.handle('load', { id: 's', name: 'data1', buffer });
  e.handle('setTransforms', { transforms: imp.transforms });
  e.handle('setDerived', { derived: imp.derived });
  const s = e.samples.get('s');
  if (comp === 'FCS') {
    if (s.spillover) e.handle('setComp', { id: 's', comp: { names: s.spillover.names, matrix: s.spillover.matrix } });
  } else if (comp) e.handle('setComp', { id: 's', comp });
  e.handle('setGates', { gates: imp.gates, overrides: {} });
  const out = new Map();
  for (const g of imp.gates) {
    const idx = e.pop(s, g.id);
    const mask = new Uint8Array(s.N);
    for (const i of idx) mask[i] = 1;
    out.set(g.name, { mask, n: idx.length });
  }
  return { out, N: s.N };
}

const dir = await ensureData();
const xml = fs.readFileSync(path.join(dir, 'gml/gml_all_gates.xml'), 'utf8');
const imp = importGatingML(xml);
const refs = compRefs(xml);
const file = fs.readFileSync(path.join(dir, 'data1.fcs'));
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.length);
const matrix = imp.compensation && imp.compensation.matrix ? { names: imp.compensation.matrix.names, matrix: imp.compensation.matrix.matrix } : null;
const runs = { plain: evaluate(buffer, imp, null), matrix: matrix ? evaluate(buffer, imp, matrix) : null, fcs: evaluate(buffer, imp, 'FCS') };

let pass = 0;
const rows = [];
for (const id of RESULTS) {
  const truth = fs.readFileSync(path.join(dir, 'truth', `Results_${id}.txt`), 'utf8').split(/\s+/).filter((x) => x === '0' || x === '1');
  const r = refs[id] || [];
  // Kestrel compensates a whole sample with one matrix; pick the run that matches the gate's reference.
  const run = r.some((x) => x !== 'uncompensated' && x !== 'FCS') && runs.matrix ? runs.matrix : r.includes('FCS') ? runs.fcs : runs.plain;
  const res = run.out.get(id);
  if (!res) {
    rows.push(`  MISSING  ${id}`);
    continue;
  }
  let diff = truth.length === run.N ? 0 : Math.abs(truth.length - run.N);
  for (let i = 0; i < Math.min(truth.length, run.N); i++) if ((truth[i] === '1') !== (res.mask[i] === 1)) diff++;
  const want = truth.filter((x) => x === '1').length;
  if (diff === 0) pass++;
  rows.push(`  ${diff === 0 ? 'ok  ' : 'FAIL'}  ${id.padEnd(15)} expected ${String(want).padStart(6)}   kestrel ${String(res.n).padStart(6)}${diff ? `   ${diff} events differ` : ''}`);
}
console.log(rows.join('\n'));
for (const w of imp.warnings) console.log(`  note: ${w}`);
console.log(`\n${pass} of ${RESULTS.length} Gating-ML 2.0 reference gates match event for event.`);
process.exit(pass === RESULTS.length ? 0 : 1);
