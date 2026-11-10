// A workspace whose gating was done by stepping one plot down the hierarchy
// (the population button on a plot) is saved with a single plot. When it's
// reopened, Layout must still offer every gate — not just the
// population that plot last showed.
//
//   node e2e/reopen-gates.mjs

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyDoc } from '../src/ui/state/doc.js';
import { workspaceFile } from '../src/ui/state/loader.js';
import { generateSample, demoManifest } from '../src/core/demo-data.js';
import { buildDemoTemplate } from '../src/ui/state/demo-template.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'kestrel-reopen-'));
const man = demoManifest().filter((m) => m.group === 'Samples');
const doc = emptyDoc('Stepped gating');
doc.groups = [{ id: 'g1', name: 'Samples' }];
doc.samples = man.map((m, i) => ({ id: `s${i}`, name: m.name, fileName: `${m.name}.fcs`, size: 0, nEvents: 0, channels: [], groupIds: ['g1'], source: { type: 'file' } }));
Object.assign(doc, buildDemoTemplate(doc));
// one plot, last moved to the T cells population (CD4 × CD8)
const tPlot = doc.plots.find((p) => doc.gates[p.pop] && doc.gates[p.pop].name === 'T cells');
doc.plots = [tPlot];
doc.layout = { ...doc.layout, plotIds: [tPlot.id] };
for (const m of man) await writeFile(path.join(tmp, `${m.name}.fcs`), generateSample({ kind: m.kind, donor: m.donor, seed: m.seed, events: 30000, name: m.name }));
const ws = path.join(tmp, 'Stepped gating.kestrel');
await writeFile(ws, JSON.stringify(workspaceFile(doc)));

const child = spawn('node', [path.join(root, 'scripts', 'open-workspace.mjs'), ws], { cwd: root, env: { ...process.env, KESTREL_NO_OPEN: '1' } });
const url = await new Promise((resolve) => {
  let o = '';
  child.stdout.on('data', (d) => {
    o += d;
    const m = o.match(/http\S+openWorkspace=1/);
    if (m) resolve(m[0]);
  });
});
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => {
  const s = window.kestrel.state();
  return s.doc.name === 'Stepped gating' && s.doc.samples.every((x) => (s.meta[x.id] || {}).status === 'ready');
}, null, { timeout: 30000 });
await page.waitForTimeout(1500);
check('the reopened workspace has the one saved plot', (await page.evaluate(() => window.kestrel.state().doc.plots.length)) === 1);

// Layout: a plot for every step of the gating strategy is offered, even
// though the workspace saved only one
await page.click('.view-tab:has-text("Layout")');
await page.waitForTimeout(1500);
const offered = await page.$$eval('.layout-side .check-list .check-row span', (els) => els.map((e) => e.textContent));
check('Layout offers a plot for every step of the gating, not just the last population', offered.length >= 6 && offered[0].startsWith('All events') && offered.some((t) => t.startsWith('Lymphocytes')) && offered.some((t) => t.startsWith('T cells')), offered.join(' | '));
const fresh = await page.evaluate(() => {
  const s = window.kestrel.state();
  return s.doc.samples.every((x) => s.counts[x.id] && s.counts[x.id].counts && Object.keys(s.doc.gates).every((g) => Number.isFinite(s.counts[x.id].counts[g])));
});
check('every gate is calculated for every sample on opening', fresh);
await page.click('.layout-side .check-list .check-row:has-text("Singlets") input');
await page.waitForTimeout(1500);
const after = await page.evaluate(() => {
  const s = window.kestrel.state();
  const p = s.doc.plots.find((q) => s.doc.gates[q.pop] && s.doc.gates[q.pop].name === 'Singlets');
  return { real: !!p, inLayout: !!p && s.doc.layout.plotIds.includes(p.id), n: s.doc.plots.length };
});
check('ticking one adds it to the workspace and the figure', after.real && after.inLayout && after.n === 2, JSON.stringify(after));
const gridCols = await page.$$eval('.layout-main .batch-col', (els) => els.map((e) => e.textContent));
check('…and it is drawn in the figure', gridCols.some((t) => t.startsWith('Singlets')), gridCols.join(' | '));
// "All" puts every step of the gating in the figure at once
await page.click('.layout-side .eyebrow-row .link-btn:has-text("All")');
await page.waitForTimeout(2500);
const all = await page.$$eval('.layout-main .batch-col', (els) => els.map((e) => e.textContent));
check('"All" puts every step of the gating in the figure, in order', all.length === offered.length && all[0].startsWith('All events'), all.join(' | '));
check('…drawn for every sample', (await page.$$eval('.layout-main .static-panel', (e) => e.length)) === all.length * man.length);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
if (child.exitCode === null) child.kill();
await rm(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
