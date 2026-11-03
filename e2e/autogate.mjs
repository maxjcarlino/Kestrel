// Automatic pre-gating, end to end: a fresh workspace with three donors'
// files, one click on Auto-gate, and the Cells → Singlets → Live front end
// appears as ordinary gates with a plot for each step — then undoes in one go.
//
//   node e2e/autogate.mjs

import { chromium } from 'playwright';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSample, demoManifest } from '../src/core/demo-data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'kestrel-auto-'));
const files = [];
for (const m of demoManifest().filter((x) => x.group === 'Samples')) {
  const f = path.join(tmp, `${m.name}.fcs`);
  await writeFile(f, generateSample({ kind: m.kind, donor: m.donor, seed: m.seed, events: 40000, name: m.name }));
  files.push(f);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file://' + path.join(root, 'dist', 'kestrel.html'));
await page.waitForSelector('.sample-row', { timeout: 30000 });
await page.waitForTimeout(1500);
await page.click('.ws-menu');
await page.click('.menu-item:has-text("New workspace")');
await page.waitForTimeout(800);
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.panel.samples .btn-primary:has-text("Add files")')]);
await chooser.setFiles(files);
await page.waitForFunction(() => {
  const s = window.kestrel.state();
  return s.doc.samples.length === 3 && s.doc.samples.every((x) => (s.meta[x.id] || {}).status === 'ready');
}, null, { timeout: 30000 });
await page.waitForTimeout(800);

const linkShown = await page.$('.tree-empty .link-btn');
check('an empty hierarchy offers to build the front end automatically', !!linkShown);
await page.click('.auto-gate-btn');
await page.waitForSelector('.autogate-dialog', { timeout: 3000 });
const picked = await page.$$eval('.autogate-dialog select', (els) => els.map((e) => e.value));
check('the dialog picks FSC-A, SSC-A, FSC-H and the viability dye by itself', picked.slice(0, 4).join(',') === 'FSC-A,SSC-A,FSC-H,BV510-A', picked.join(','));
const steps = await page.$$eval('.autogate-step input[type=checkbox]', (els) => els.map((e) => e.checked));
check('all three steps are on', steps.join(',') === 'true,true,true');
await page.click('.autogate-dialog .btn-primary');
await page.waitForSelector('.autogate-dialog', { state: 'detached', timeout: 15000 });
await page.waitForTimeout(800);
const toastText = await page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' / '));
// Batch keeps every sample's counts current, so all three get computed
await page.click('.view-tab:has-text("Batch")');
await page.waitForTimeout(3000);

const st = await page.evaluate(() => {
  const s = window.kestrel.state();
  const gates = Object.values(s.doc.gates);
  const by = (n) => gates.find((g) => g.name === n);
  const c = by('Cells');
  const sg = by('Singlets');
  const l = by('Live');
  return {
    names: gates.map((g) => g.name),
    chain: !!(c && sg && l && c.parent === 'root' && sg.parent === c.id && l.parent === sg.id),
    types: [c && c.type, sg && sg.type, l && l.type],
    plots: s.doc.plots.map((p) => `${p.pop === 'root' ? 'root' : (s.doc.gates[p.pop] || {}).name}:${p.x}x${p.y}`),
    counts: s.doc.samples.map((x) => {
      const k = (s.counts[x.id] || {}).counts || {};
      return [k.root, c && k[c.id], sg && k[sg.id], l && k[l.id]];
    }),
  };
});
check('builds Cells → Singlets → Live, each inside the one before', st.chain && st.names.length === 3, st.names.join(' > '));
check('as editable polygon/rectangle gates', st.types.join(',') === 'polygon,polygon,rect', st.types.join(','));
check(
  'with a plot for each step and one to carry on from',
  ['root:FSC-AxSSC-A', 'Cells:FSC-AxFSC-H', 'Singlets:BV510-AxSSC-A', 'Live:FSC-AxSSC-A'].every((p) => st.plots.includes(p)),
  st.plots.join(' | '),
);
const sane = st.counts.every(([n, c, sg, l]) => c / n > 0.85 && c / n < 0.97 && sg / c > 0.93 && sg / c < 0.99 && l / sg > 0.88 && l / sg < 0.99);
check('every sample gets sensible frequencies (debris, doublets and dead cells out)', sane, st.counts.map((c) => c.map((v, i) => (i ? ((100 * v) / c[i - 1]).toFixed(1) + '%' : v)).join(' ')).join(' | '));
check('says what it built', /Built Cells \([\d.]+%\) → Singlets \([\d.]+%\) → Live \([\d.]+%\)/.test(toastText), toastText.slice(0, 140));

await page.click('.view-tab:has-text("Gating")');
await page.waitForTimeout(400);
await page.keyboard.press('Control+z');
await page.waitForTimeout(600);
const after = await page.evaluate(() => {
  const s = window.kestrel.state();
  return { gates: Object.keys(s.doc.gates).length, plots: s.doc.plots.length };
});
check('one undo removes all of it', after.gates === 0 && after.plots <= 1, JSON.stringify(after));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await rm(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
