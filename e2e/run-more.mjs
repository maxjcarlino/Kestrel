// More end-to-end flows: ellipse, histogram gates, boolean gates, overlays,
// templates applied to new data, Gating-ML and CSV import, hosted-artifact saving.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSample, demoManifest } from '../src/core/demo-data.js';
import { runTemplate } from '../src/engine/batch.js';
import { toCSV } from '../src/core/csv.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] || path.join(root, 'e2e', 'shots');
fs.mkdirSync(shots, { recursive: true });
const url = 'file://' + path.join(root, 'dist', 'kestrel.html');
let failures = 0;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// fixtures on disk
const fx = path.join(shots, 'fixtures');
fs.mkdirSync(fx, { recursive: true });
fs.writeFileSync(path.join(fx, 'NewDonor.fcs'), generateSample({ kind: 'cells', donor: 'PBMC_Donor03', seed: 4242, events: 40000, name: 'NewDonor' }));
fs.writeFileSync(path.join(fx, 'table.csv'), 'FSC-A,SSC-A,CD3\n' + Array.from({ length: 500 }, (_, i) => `${1000 + i * 100},${2000 + (i % 50) * 300},${(i % 7) * 1000}`).join('\n'));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_TUNNEL|fonts/.test(m.text())) errors.push(`console: ${m.text()}`);
});
const ready = async () => {
  await page.waitForSelector('.plot-card', { timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.plot-foot .num')].every((e) => !e.textContent.includes('…')), null, { timeout: 30000 });
  await page.waitForTimeout(300);
};
const treeNames = () => page.$$eval('.tree-row .tree-label', (els) => els.map((e) => e.textContent));
const countOf = (name) => page.$$eval('.tree-row', (rows, n) => {
  const r = rows.find((x) => x.querySelector('.tree-label') && x.querySelector('.tree-label').textContent === n);
  return r ? parseInt(r.querySelector('.num').textContent.replace(/,/g, ''), 10) : null;
}, name);
const areaOf = (b) => ({ x: b.x + 44, y: b.y + 8, w: b.width - 54, h: b.height - 32 });
const at = (a, sx, sy) => [a.x + sx * a.w, a.y + (1 - sy) * a.h];
const canvasArea = async (i) => {
  const c = (await page.$$('.plot-canvas'))[i];
  await c.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  return areaOf(await c.boundingBox());
};
const plotIndex = (name) => page.$$eval('.plot-card .pop-name', (els, n) => els.findIndex((e) => e.textContent === n), name);
async function nameIt(n) {
  const ed = await page.waitForSelector('.gate-name-edit input', { timeout: 3000 }).catch(() => null);
  if (ed) {
    if (n) await ed.fill(n);
    await ed.press('Enter');
  }
  await page.waitForTimeout(300);
}

await page.goto(url);
await ready();

// ---- the app's statistics export equals the headless batch runner on the same files
{
  await page.click('.view-tab:has-text("Statistics")');
  await page.waitForSelector('.stats-table');
  await page.waitForFunction(() => ![...document.querySelectorAll('.stats-table td')].some((td) => td.textContent === '…'), null, { timeout: 30000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export CSV")')]);
  const appCsv = fs.readFileSync(await dl.path(), 'utf8');
  const tpl = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'pbmc-7colour.template.json'), 'utf8'));
  const donors = demoManifest().filter((m) => m.kind === 'cells');
  const res = runTemplate(tpl, donors.map((m) => {
    const b = generateSample(m);
    return { name: `${m.name}.fcs`, buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }));
  const cliCsv = toCSV([res.header, ...res.rows]);
  check('statistics export matches the headless batch runner exactly', appCsv.trim() === cliCsv.trim(), appCsv === cliCsv ? '' : `app ${appCsv.split('\n')[1]} | cli ${cliCsv.split('\n')[1]}`);
  await page.click('.view-tab:has-text("Gating")');
  await ready();
}

// ---- ellipse on Live (FSC-A x SSC-A)
const li = (await page.$$eval('.plot-card', (cards) => cards.map((c) => c.querySelector('.pop-name').textContent + '|' + c.querySelector('.axis-x').textContent))).findIndex((t) => t.startsWith('Live|') && t.includes('FSC-A'));
await page.keyboard.press('e');
let a = await canvasArea(li);
let p0 = at(a, 0.15, 0.03);
let p1 = at(a, 0.4, 0.16);
await page.mouse.move(p0[0], p0[1]);
await page.mouse.down();
await page.mouse.move(p1[0], p1[1], { steps: 6 });
await page.mouse.up();
await nameIt('Ellipse test');
a = await canvasArea(li);
const e1 = await countOf('Ellipse test');
check('ellipse gate drawn', e1 > 1000, `${e1} events`);
// grab the +a handle (right end of the major axis) and drag outward
const hx = at(a, 0.4, 0.095);
await page.mouse.move(hx[0], hx[1]);
await page.mouse.down();
await page.mouse.move(hx[0] + 40, hx[1] - 10, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(500);
const e2 = await countOf('Ellipse test');
check('ellipse handle reshapes the gate', e2 !== e1, `${e1} -> ${e2}`);
await page.mouse.click(...at(a, 0.27, 0.095), { button: 'right' });
const menuTxt = await page.$eval('.menu', (m) => m.textContent).catch(() => 'no menu');
if (!/^Ellipse test/.test(menuTxt)) {
  console.log('menu:', menuTxt);
  await page.screenshot({ path: path.join(shots, 'fail-ellipse.png') });
}
await page.click('.menu-item:has-text("Convert to polygon")', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(500);
const e3 = await countOf('Ellipse test');
const kind = await page.$eval('.insp-kind', (e) => e.textContent);
check('ellipse converts to polygon with nearly the same events', /Polygon/.test(kind) && Math.abs(e3 - e2) / e2 < 0.02, `${e2} -> ${e3}`);
await page.screenshot({ path: path.join(shots, '11-ellipse.png') });

// ---- histogram range and split gates
const hi = await plotIndex('Non-T/B');
a = await canvasArea(hi);
await page.keyboard.press('g');
p0 = at(a, 0.2, 0.5);
p1 = at(a, 0.45, 0.5);
await page.mouse.move(p0[0], p0[1]);
await page.mouse.down();
await page.mouse.move(p1[0], p1[1], { steps: 5 });
await page.mouse.up();
await nameIt('CD56 dim');
check('range gate drawn on a histogram', (await countOf('CD56 dim')) > 0, `${await countOf('CD56 dim')}`);
await page.keyboard.press('s');
await page.mouse.click(...at(a, 0.5, 0.5));
await page.waitForTimeout(500);
const neg = await countOf('CD56−');
const pos = await countOf('CD56+');
const parent = await countOf('Non-T/B');
check('split gate divides the parent exactly', neg + pos === parent, `${neg} + ${pos} = ${parent}`);
await page.screenshot({ path: path.join(shots, '12-histogram.png') });

// ---- boolean gate (B cells OR T cells)
await page.click('.tree-row:has-text("B cells")', { button: 'right' });
await page.click('.menu-item:has-text("New boolean gate")');
await page.waitForSelector('.dialog');
await page.click('.dialog .seg button:has-text("OR")');
await page.click('.dialog .check-row:has-text("T cells") input');
await page.click('.dialog .btn-primary');
await page.waitForTimeout(600);
const bOr = await countOf('B cells or T cells');
check('boolean OR gate equals the sum of disjoint gates', bOr === (await countOf('B cells')) + (await countOf('T cells')), `${bOr}`);
await page.click('.tree-row:has-text("Lymphocytes")', { button: 'right' });
await page.click('.menu-item:has-text("New boolean gate")');
await page.click('.dialog .seg button:has-text("NOT")');
await page.click('.dialog .check-row:has-text("Monocytes") input');
const within = await page.$eval('.dialog select', (s) => s.options[s.selectedIndex].textContent.trim());
await page.click('.dialog .btn-primary').catch(() => {});
await page.waitForTimeout(400);
const notG = await countOf('not Monocytes');
const live = await countOf('Live');
const mono = await countOf('Monocytes');
check('boolean NOT gate is the complement within its parent', notG === live - mono, `${within}: ${notG} = ${live} - ${mono}`);

// ---- overlay in layout view
await page.click('.view-tab:has-text("Layout")');
await page.waitForTimeout(2500);
const overlayCanvas = await page.$('.overlay-card canvas');
check('histogram overlay renders in the layout view', !!overlayCanvas);
await page.screenshot({ path: path.join(shots, '13-layout.png'), fullPage: false });
await page.evaluate(() => document.querySelector('.overlay-card') && document.querySelector('.overlay-card').scrollIntoView());
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shots, '14-overlay.png') });
await page.click('.view-tab:has-text("Gating")');

// ---- save template, start a new workspace, add a new file, apply the template
const [d] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('.ws-menu'); await page.click('.menu-item:has-text("Save as template")'); })()]);
const tplPath = path.join(fx, d.suggestedFilename());
await d.saveAs(tplPath);
const [dg] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('.ws-menu'); await page.click('.menu-item:has-text("Export gates (.xml)")'); })()]);
const gmlPath = path.join(fx, dg.suggestedFilename());
await dg.saveAs(gmlPath);
const referenceCD4 = await countOf('CD4+ CD8−');

await page.click('.ws-menu');
await page.click('.menu-item:has-text("New workspace")');
await page.waitForSelector('.empty-title');
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.empty .btn-primary')]);
await fc.setFiles(path.join(fx, 'NewDonor.fcs'));
await page.waitForSelector('.plot-card');
await page.waitForTimeout(1200);
const [fc2] = await Promise.all([page.waitForEvent('filechooser'), (async () => { await page.click('.ws-menu'); await page.click('.menu-item:has-text("Apply template")'); })()]);
await fc2.setFiles(tplPath);
await page.waitForTimeout(2500);
console.log('toasts after apply:', await page.$$eval('.toast', (els) => els.map((t) => t.textContent)));
let names = await treeNames();
check('template applied to a new sample recreates the hierarchy', names.includes('Lymphocytes') && names.includes('CD4+ CD8−') && names.includes('B cells or T cells'), `${names.length} gates`);
const plots = await page.$$eval('.plot-card', (e) => e.length);
check('template brings its plots', plots >= 8, `${plots} plots`);
const newCD4 = await countOf('CD4+ CD8−');
check('gates produce counts on the new data', newCD4 > 1000, `${newCD4} CD4 T cells (reference sample: ${referenceCD4})`);
await page.screenshot({ path: path.join(shots, '15-template-applied.png') });

// ---- Gating-ML import into another empty workspace
await page.click('.ws-menu');
await page.click('.menu-item:has-text("New workspace")');
await page.waitForSelector('.empty-title');
const [fc3] = await Promise.all([page.waitForEvent('filechooser'), page.click('.empty .btn-primary')]);
await fc3.setFiles(path.join(fx, 'NewDonor.fcs'));
await page.waitForSelector('.plot-card');
await page.waitForTimeout(800);
const [fc4] = await Promise.all([page.waitForEvent('filechooser'), (async () => { await page.click('.ws-menu'); await page.click('.menu-item:has-text("Import gates")'); })()]);
await fc4.setFiles(gmlPath);
await page.waitForTimeout(1500);
const gmlCD4 = await countOf('CD4+ CD8−');
check('Gating-ML import reproduces the same counts as the template', gmlCD4 === newCD4, `${gmlCD4} vs ${newCD4}`);

// ---- CSV import
const [fc5] = await Promise.all([page.waitForEvent('filechooser'), page.click('.panel.samples .btn-primary')]);
await fc5.setFiles(path.join(fx, 'table.csv'));
await page.waitForTimeout(1200);
const csvRow = await page.$$eval('.sample-row', (rows) => rows.map((r) => r.textContent).find((t) => t.includes('table')));
check('CSV tables load as samples', !!csvRow && /500/.test(csvRow), csvRow || 'missing');

// ---- ratio parameter from the axis menu, and a Hyperlog scale
await page.click('.sample-row:has-text("NewDonor")');
await ready();
const yIdx = await page.$$eval('.plot-card .axis-y', (els) => els.findIndex((e) => !/Count/.test(e.textContent)));
await (await page.$$('.axis-y'))[yIdx].click();
await page.click('.ratio-row .link-btn');
await page.selectOption('select[aria-label="Numerator"]', 'PE-Cy7-A');
await page.selectOption('select[aria-label="Denominator"]', 'PerCP-Cy5-5-A');
await page.fill('input[aria-label="Ratio name"]', 'CD4:CD8');
await page.click('.ratio-form .btn-primary');
await page.waitForTimeout(1200);
const ratioLabel = await (await page.$$('.axis-y'))[yIdx].textContent();
check('a ratio parameter can be created from the axis menu and plotted', /CD4:CD8/.test(ratioLabel), ratioLabel);
await (await page.$$('.axis-y'))[yIdx].click();
const ratioGroup = await page.$$eval('.axis-group-title', (els) => els.map((e) => e.textContent));
check('ratio parameters are listed in their own group', ratioGroup.includes('Ratios'), ratioGroup.join(', '));
const ratioMax = await page.$eval('.scale-editor .scale-note', (e) => e.textContent);
check('a new ratio gets a display scale from the data', !/262,?144|262K/.test(ratioMax), ratioMax);
await page.keyboard.press('Escape');
await (await page.$$('.axis-x'))[yIdx].click();
await page.click('.scale-editor button:has-text("Hyperlog")');
await page.waitForTimeout(800);
const hl = await page.$eval('.scale-editor', (e) => e.textContent);
check('Hyperlog scale can be chosen and edited', /Width \(W\)/.test(hl) && /Hyperlog/.test(hl), hl.slice(0, 80));
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(shots, '16-ratio-hyperlog.png') });

// ---- backgating strip, Batch tab
{
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await p2.waitForSelector('.topbar', { timeout: 30000 });
  await p2.click('.ws-menu');
  await p2.click('.menu-item:has-text("Open the demo experiment")');
  await p2.waitForSelector('.tree-row:has-text("T cells")', { timeout: 30000 });
  await p2.waitForTimeout(2500);
  await p2.click('.tree-row:has-text("CD4+ CD8−")');
  await p2.waitForTimeout(1500);
  const caps = await p2.$$eval('.bg-item .bg-cap', (els) => els.map((e) => e.textContent));
  const cur = await p2.$$eval('.bg-item.is-current .bg-cap', (els) => els.map((e) => e.textContent));
  check('gating path runs from ungated FSC-A × SSC-A to the selected population', caps.length === 6 && caps[0] === 'All events→Cells' && cur[0] === 'T cells→CD4+ CD8−', caps.join(' | '));

  // ---- the sidebar can be dragged wider/narrower, and the choice persists
  const sidebarBox = await p2.$eval('.sidebar', (el) => el.getBoundingClientRect());
  const handleBox = await p2.$eval('.sidebar-resizer', (el) => el.getBoundingClientRect());
  await p2.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await p2.mouse.down();
  await p2.mouse.move(handleBox.x + 120, handleBox.y + handleBox.height / 2, { steps: 6 });
  await p2.mouse.up();
  await p2.waitForTimeout(300);
  const widerBox = await p2.$eval('.sidebar', (el) => el.getBoundingClientRect());
  check('dragging the sidebar handle resizes the sidebar', widerBox.width > sidebarBox.width + 80, `${sidebarBox.width} -> ${widerBox.width}`);
  await p2.reload();
  await p2.waitForSelector('.sidebar', { timeout: 15000 });
  await p2.waitForTimeout(800);
  const afterReload = await p2.$eval('.sidebar', (el) => el.getBoundingClientRect());
  check('the resized sidebar width survives a reload', Math.abs(afterReload.width - widerBox.width) < 2, `${widerBox.width} vs ${afterReload.width}`);
  // double-click resets it back to the default
  await p2.waitForSelector('.sidebar-resizer');
  await p2.dblclick('.sidebar-resizer');
  await p2.waitForTimeout(300);
  const resetBox = await p2.$eval('.sidebar', (el) => el.getBoundingClientRect());
  check('double-clicking the handle resets the sidebar to its default width', Math.round(resetBox.width) === 304, resetBox.width);

  // ---- a long sample name shrinks to fit instead of being cropped
  const originalName = await p2.$eval('.sample-row .fit-text', (el) => el.textContent);
  const longName = 'PBMC Donor 01 (unstained control)';
  const renameTo = async (name) => {
    await p2.$eval('.sample-row', (el) => el.querySelector('.row-more').click());
    await p2.waitForTimeout(150);
    await p2.click('.menu-item:has-text("Rename")');
    await p2.fill('.row-input', name);
    await p2.press('.row-input', 'Enter');
    await p2.waitForTimeout(500);
  };
  await renameTo(longName);
  const fit = await p2.$eval('.sample-row .fit-text', (el) => ({
    text: el.textContent,
    fontSize: parseFloat(getComputedStyle(el).fontSize),
    overflowing: el.scrollWidth > el.clientWidth + 1,
  }));
  check('a long sample name shrinks its font instead of being cropped', fit.text === longName && !fit.overflowing && fit.fontSize < 13, JSON.stringify(fit));
  await renameTo(originalName); // restore it: later checks pick samples by their demo names

  // ---- dot size: a typed integer, settable per plot
  const card0 = (await p2.$$('.plot-card'))[0];
  await card0.$eval('button[title="Dot plot"]', (b) => b.click());
  await p2.waitForTimeout(400);
  await card0.$eval('button[title="Dot size"]', (b) => b.click());
  await p2.waitForTimeout(200);
  await p2.fill('input[aria-label="Dot size for this plot"]', '6');
  await p2.press('input[aria-label="Dot size for this plot"]', 'Enter');
  await p2.waitForTimeout(400);
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(200);
  await card0.$eval('button[title="Dot size"]', (b) => b.click());
  await p2.waitForTimeout(200);
  const dotVal = await p2.$eval('input[aria-label="Dot size for this plot"]', (el) => el.value);
  const hasReset = await p2.$('button:has-text("Use default")');
  check('dot size accepts a typed integer, per plot', dotVal === '6' && !!hasReset, dotVal);
  const dotPopSize = await p2.$eval('.dotsize-pop', (el) => {
    const pop = el.closest('.popover');
    return { w: pop.scrollWidth - pop.clientWidth, h: pop.scrollHeight - pop.clientHeight, cw: pop.clientWidth, ch: pop.clientHeight };
  });
  check('the dot size popover is small and never scrolls', dotPopSize.w === 0 && dotPopSize.h === 0, JSON.stringify(dotPopSize));
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(200);
  const globalDot = await p2.$('input[aria-label="Default dot size in pixels"]');
  if (globalDot) {
    await globalDot.fill('3');
    await globalDot.press('Enter');
    await p2.waitForTimeout(300);
    const gv = await p2.$eval('input[aria-label="Default dot size in pixels"]', (el) => el.value);
    check('the default dot size (Display panel) accepts a typed integer', gv === '3', gv);
  }

  // ---- concatenate samples into one plot (all plot types)
  await card0.$eval('button[title="Concatenate samples"]', (b) => b.click());
  await p2.waitForTimeout(300);
  await p2.click('.concat-menu .check-row:has-text("PBMC_Donor01") input');
  await p2.click('.concat-menu .check-row:has-text("PBMC_Donor02") input');
  await p2.waitForTimeout(1500);
  const pooled = await card0.$eval('.num', (el) => el.textContent.trim());
  check('concatenating samples pools events into one plot', /pooled from 2 samples/.test(pooled), pooled);
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(200);

  // ---- relabel a parameter (the "CD4" for "FITC-A" problem): the rename
  // pencil in the axis picker overrides whatever the file's own label is,
  // applies everywhere that channel is shown, round-trips, and resets.
  await card0.$eval('.axis-x', (b) => b.click());
  await p2.waitForSelector('.axis-menu', { timeout: 3000 });
  await p2.click('.axis-row:has-text("FITC-A") .axis-relabel');
  await p2.fill('input[aria-label="Label for FITC-A"]', 'CD4-test');
  await p2.press('input[aria-label="Label for FITC-A"]', 'Enter');
  await p2.waitForTimeout(300);
  const relabeledRow = await p2.$eval('.axis-row:has-text("FITC-A") .axis-opt b', (el) => el.textContent);
  check('relabeling a parameter is reflected in the picker', relabeledRow === 'CD4-test', relabeledRow);
  await p2.click('.axis-opt:has-text("CD4-test")');
  await p2.waitForTimeout(300);
  const axisShows = await card0.$eval('.axis-x', (el) => el.textContent);
  check('the new label shows on the plot axis', /CD4-test/.test(axisShows), axisShows);
  const relabeled = await p2.evaluate(() => window.kestrel.state().doc.channelLabels['FITC-A']);
  check('the override is stored on the document (so it saves and syncs)', relabeled === 'CD4-test', relabeled);
  await card0.$eval('.axis-x', (b) => b.click());
  await p2.waitForSelector('.axis-menu .scale-editor');
  await p2.click('.scale-head button:has-text("Reset label")');
  await p2.waitForTimeout(300);
  const afterReset = await p2.evaluate(() => window.kestrel.state().doc.channelLabels['FITC-A']);
  check('"Reset label" clears the override', afterReset === undefined, afterReset);
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(200);

  // ---- Batch view keeps every sample's percentages current, not just the
  // one that happened to be active in Gating. Edit a shared gate's bounds
  // (so every sample's membership changes at once), then go straight to
  // Batch without ever selecting the other samples individually, and check
  // their counts were refreshed to the new gate anyway.
  await p2.click('.tree-row:has-text("Live")');
  await p2.waitForTimeout(300);
  const boundInputs = await p2.$$('.geom-grid input');
  const editApplied = boundInputs.length >= 2;
  if (editApplied) {
    const x1 = boundInputs[1];
    const cur = parseFloat(await x1.inputValue());
    await x1.fill(String(Math.round(cur * 0.7)));
    await x1.press('Enter');
    await p2.waitForTimeout(700);
  }
  const otherIds = await p2.evaluate(() => {
    const st = window.kestrel.state();
    const g = st.doc.groups.find((x) => /^samples$/i.test(x.name));
    const members = g ? st.doc.samples.filter((s) => (s.groupIds || []).includes(g.id)) : st.doc.samples;
    return members.filter((s) => s.id !== st.ui.sampleId).map((s) => s.id);
  });
  await p2.click('.view-tab:has-text("Batch")');
  await p2.waitForTimeout(2500);
  const cells = await p2.$$eval('.batch-cell', (els) => els.length);
  check('Batch tab draws every plot for every sample', cells === 8 * 3, `${cells} panels`);
  const freshness = await p2.evaluate((ids) => {
    const st = window.kestrel.state();
    return ids.map((id) => {
      const want = window.kestrel.countsVersion(st, id);
      const have = st.counts[id] && st.counts[id].version;
      return have === want;
    });
  }, otherIds);
  check(
    "Batch view refreshes every sample's counts after a shared gate edit, not only the one last viewed in Gating",
    editApplied && otherIds.length > 0 && freshness.every(Boolean),
    `${freshness.filter(Boolean).length} of ${freshness.length} other samples fresh (edit applied: ${editApplied})`,
  );

  await p2.click('.batch-cell >> nth=4');
  await p2.waitForTimeout(600);
  check('clicking a Batch panel opens it in Gating', (await p2.$eval('.view-tab.is-on', (e) => e.textContent)).includes('Gating'));

  // ---- layout view: toggle which labels are drawn on each panel
  await p2.click('.view-tab:has-text("Layout")');
  await p2.waitForTimeout(800);
  const plotChecks = await p2.$$('.check-list .check-row input');
  if (plotChecks.length) await plotChecks[0].click();
  await p2.waitForTimeout(1500);
  const titleToggle = await p2.$('.layout-side label.check-row:has-text("Plot title") input');
  const axisToggle = await p2.$('.layout-side label.check-row:has-text("Axis labels") input');
  check('Layout view offers toggles for plot title and axis labels', !!titleToggle && !!axisToggle);
  if (titleToggle && axisToggle) {
    await titleToggle.click();
    await axisToggle.click();
    await p2.waitForTimeout(600);
    const bothOff = (await titleToggle.isChecked()) === false && (await axisToggle.isChecked()) === false;
    check('unchecking both toggles turns them off', bothOff);
    await titleToggle.click();
    await axisToggle.click();
  }

  await p2.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
await ctx.close();

// ---- hosted artifact: downloads go through the capability; disallowed types are zipped
const art = await browser.newContext({ viewport: { width: 1300, height: 900 } });
await art.addInitScript(() => {
  window.__saved = [];
  window.claude = {
    use: async (name) =>
      name === 'downloads'
        ? Object.freeze({
            save: async ({ filename, data }) => {
              window.__saved.push({ filename, kind: data && data.constructor ? data.constructor.name : typeof data, size: data && data.size });
              return { status: 'saved' };
            },
          })
        : null,
  };
});
const ap = await art.newPage();
// load the body-only artifact build inside the same skeleton the host adds
const body = fs.readFileSync(path.join(root, 'dist', 'artifact.html'), 'utf8');
const wrapped = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
const wrappedPath = path.join(fx, 'artifact-wrapped.html');
fs.writeFileSync(wrappedPath, wrapped);
const aerr = [];
ap.on('pageerror', (e) => aerr.push(e.message));
await ap.goto('file://' + wrappedPath);
await ap.waitForSelector('.plot-card', { timeout: 30000 });
await ap.waitForTimeout(2500);
await ap.click('.ws-menu');
await ap.click('.menu-item:has-text("Export gates (.xml)")');
await ap.waitForTimeout(800);
await ap.click('.ws-menu');
await ap.click('.menu-item:has-text("Save as template")');
await ap.waitForTimeout(800);
const saved = await ap.evaluate(() => window.__saved);
check('artifact build runs inside the host skeleton', aerr.length === 0, aerr.join(' | '));
check('hosted saves use the downloads capability', saved.length === 2, JSON.stringify(saved));
check('XML is packaged as .zip where only some types are allowed', saved[0] && /\.zip$/.test(saved[0].filename), saved[0] && saved[0].filename);
check('JSON templates are saved directly', saved[1] && /\.template\.json$/.test(saved[1].filename), saved[1] && saved[1].filename);
const title = await ap.title();
check('page title', title === 'Kestrel Cytometry', title);
await art.close();

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
