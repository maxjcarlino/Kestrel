#!/usr/bin/env node
// Print the event count of every gate in a Gating-ML 2.0 file for one FCS file,
// evaluated by Kestrel's engine, as JSON ({gate name: count}).
//
//   node scripts/gatingml-counts.mjs sample.fcs gates.xml
//
// Compensation follows the Gating-ML file: a spectrumMatrix it defines is
// applied, "FCS" uses the file's own spillover matrix, otherwise none.

import fs from 'node:fs';
import { Engine } from '../src/engine/engine.js';
import { importGatingML } from '../src/core/gatingml.js';

const [fcsPath, xmlPath] = process.argv.slice(2);
if (!fcsPath || !xmlPath) {
  console.error('usage: gatingml-counts.mjs sample.fcs gates.xml');
  process.exit(2);
}
const imp = importGatingML(fs.readFileSync(xmlPath, 'utf8'));
const b = fs.readFileSync(fcsPath);
const e = new Engine();
const meta = e.handle('load', { id: 's', name: fcsPath, buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }).result;
e.handle('setTransforms', { transforms: imp.transforms });
e.handle('setDerived', { derived: imp.derived });
const c = imp.compensation;
if (c && c.mode === 'matrix') e.handle('setComp', { id: 's', comp: { names: c.matrix.names, matrix: c.matrix.matrix } });
else if (c && c.mode === 'file' && meta.spillover) e.handle('setComp', { id: 's', comp: meta.spillover });
e.handle('setGates', { gates: imp.gates, overrides: {} });
const { counts } = e.handle('counts', { id: 's' }).result;
const out = {};
for (const g of imp.gates) out[g.name] = counts[g.id];
console.log(JSON.stringify(out, null, 2));
for (const w of imp.warnings) console.error(`note: ${w}`);
