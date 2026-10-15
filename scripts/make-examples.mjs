// Regenerate examples/: a complete workflow template and Gating-ML for the demo panel.
//   node scripts/make-examples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine/engine.js';
import { demoManifest } from '../src/core/demo-data.js';
import { emptyDoc } from '../src/ui/state/doc.js';
import { buildDemoTemplate } from '../src/ui/state/demo-template.js';
import { makeTemplate } from '../src/ui/state/loader.js';
import { defaultSpec } from '../src/ui/state/derived.js';
import { normalizeSpec } from '../src/core/transforms.js';
import { exportGatingML } from '../src/core/gatingml.js';
import { orderGates } from '../src/core/gates.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'examples');
fs.mkdirSync(out, { recursive: true });

// Estimate display scales from the first demo donor, as the app does on load.
const e = new Engine();
const first = demoManifest()[0];
const meta = e.handle('loadDemo', { id: 's', name: first.name, spec: { ...first, kind: 'cells' } }).result;

const doc = emptyDoc('Demo 7-colour PBMC panel');
doc.groups = [{ id: 'grp-samples', name: 'Samples' }];
doc.samples = [];
Object.assign(doc, buildDemoTemplate(doc));
for (const c of meta.channels) doc.transforms[c.name] = normalizeSpec(defaultSpec(c));
const tpl = makeTemplate(doc, 'Demo 7-colour PBMC panel');
tpl.description = 'Viability, singlets, lymphocytes, monocytes, T/B/NK cells and CD4/CD8 subsets for the simulated 7-colour PBMC panel bundled with Kestrel.';
fs.writeFileSync(path.join(out, 'pbmc-7colour.template.json'), JSON.stringify(tpl, null, 2) + '\n');
const xml = exportGatingML({ gates: orderGates(doc.gates).ordered, transforms: doc.transforms, compensation: { mode: 'file', fileNames: meta.spillover.names }, appName: 'Kestrel' });
fs.writeFileSync(path.join(out, 'pbmc-7colour.gating-ml.xml'), xml);
console.log('wrote examples/pbmc-7colour.template.json and examples/pbmc-7colour.gating-ml.xml');
