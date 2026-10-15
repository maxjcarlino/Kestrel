import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTemplate, asTemplate, templateColumns } from '../src/engine/batch.js';
import { generateSample } from '../src/core/demo-data.js';
import { Engine } from '../src/engine/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'pbmc-7colour.template.json'), 'utf8'));
const file = (name, seed) => {
  const b = generateSample({ kind: 'cells', donor: 'PBMC_Donor02', seed, events: 20000, name });
  return { name: `${name}.fcs`, buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};

test('batch: a template produces one row per file with its table columns', () => {
  const res = runTemplate(template, [file('A', 5), file('B', 6)]);
  assert.equal(res.rows.length, 2);
  assert.equal(res.header.length, 1 + template.table.columns.length);
  assert.equal(res.rows[0][0], 'A');
  assert.match(res.header[1], /Lymphocytes \| Count$/);
  assert.deepEqual(res.warnings, []);
  // the count column equals the engine's own count for that gate
  const e = new Engine();
  const f = file('A', 5);
  e.handle('load', { id: 's', name: 'A', buffer: f.buffer });
  e.handle('setTransforms', { transforms: template.transforms });
  const sp = e.samples.get('s').spillover;
  e.handle('setComp', { id: 's', comp: { names: sp.names, matrix: sp.matrix } });
  e.handle('setGates', { gates: template.gates, overrides: {} });
  const counts = e.handle('counts', { id: 's' }).result.counts;
  const col = template.table.columns.findIndex((c) => c.stat === 'count');
  assert.equal(res.rows[0][col + 1], counts[template.table.columns[col].pop]);
});

test('batch: workspace files are accepted and tables default to counts and % parent', () => {
  const ws = {
    format: 'kestrel-workspace',
    name: 'W',
    gates: Object.fromEntries(template.gates.map((g) => [g.id, g])),
    gateOrder: template.gates.map((g) => g.id),
    transforms: template.transforms,
    comp: { matrices: [], default: 'none' },
    table: { columns: [] },
  };
  const t = asTemplate(ws);
  assert.equal(t.gates.length, template.gates.length);
  assert.equal(templateColumns(t).length, 2 * template.gates.length);
  const res = runTemplate(ws, [file('C', 7)]);
  assert.equal(res.header.length, 1 + 2 * template.gates.length);
  assert.throws(() => asTemplate({ hello: 1 }), /not a Kestrel template/);
});
