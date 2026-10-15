// End-to-end tests in headless Chromium (Playwright).
//   node e2e/run.mjs [screenshot-dir]
// Exercises the main user flows against dist/kestrel.html.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] || path.join(root, 'e2e', 'shots');
fs.mkdirSync(shots, { recursive: true });
const url = 'file://' + path.join(root, 'dist', 'kestrel.html');

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_TUNNEL|fonts\.g/.test(m.text())) errors.push(`console: ${m.text()}`);
});

async function ready() {
  await page.waitForSelector('.plot-card', { timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.plot-foot .num')].length > 0 && [...document.querySelectorAll('.plot-foot .num')].every((e) => !e.textContent.includes('…')), null, { timeout: 30000 });
  await page.waitForTimeout(300);
}
const treeNames = () => page.$$eval('.tree-row .tree-label', (els) => els.map((e) => e.textContent));
const plotCount = () => page.$$eval('.plot-card', (els) => els.length);
async function canvasBox(i) {
  const c = (await page.$$('.plot-canvas'))[i];
  await c.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  return c.boundingBox();
}
// plot area inside the canvas (matches MARGIN in render.js)
function areaOf(box) {
  return { x: box.x + 44, y: box.y + 8, w: box.width - 54, h: box.height - 32 };
}
const at = (a, sx, sy) => [a.x + sx * a.w, a.y + (1 - sy) * a.h];

await page.goto(url);
await ready();
check('demo workspace loads with plots', (await plotCount()) === 8, `${await plotCount()} plots`);
const names0 = await treeNames();
check('demo gating hierarchy present', names0.includes('Lymphocytes') && names0.includes('T cells'), names0.join(', '));

// ---- rectangle gate on the first plot
await page.keyboard.press('r');
let a = areaOf(await canvasBox(0));
let p0 = at(a, 0.55, 0.55);
let p1 = at(a, 0.8, 0.75);
await page.mouse.move(p0[0], p0[1]);
await page.mouse.down();
await page.mouse.move((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, { steps: 4 });
await page.mouse.move(p1[0], p1[1], { steps: 4 });
await page.mouse.up();
await page.waitForSelector('.gate-name-edit input', { timeout: 3000 }).catch(() => {});
const editor = await page.$('.gate-name-edit input');
check('naming field appears after drawing a gate', !!editor);
if (editor) {
  await editor.fill('Granulocytes');
  await editor.press('Enter');
}
await page.waitForTimeout(400);
let names = await treeNames();
check('rectangle gate created and named', names.includes('Granulocytes'), names.join(', '));
await page.screenshot({ path: path.join(shots, '01-rect-gate.png') });

// ---- double-click the new gate to drill down
const before = await plotCount();
const mid = at(a, 0.67, 0.65);
await page.mouse.dblclick(mid[0], mid[1]);
await page.waitForTimeout(800);
const after = await plotCount();
check('double-click drills down into a new plot', after === before + 1, `${before} -> ${after}`);
const popNames = await page.$$eval('.plot-card .pop-name', (els) => els.map((e) => e.textContent));
check('drill-down plot shows the gated population', popNames.includes('Granulocytes'), popNames.join(', '));

// ---- right-click the gate -> Convert to polygon
await page.mouse.click(mid[0], mid[1], { button: 'right' });
await page.waitForSelector('.menu', { timeout: 3000 });
const menuText = await page.$eval('.menu', (m) => m.textContent);
check('right-click opens the gate menu', /Convert to polygon/.test(menuText) && /Drill down/.test(menuText));
await page.click('.menu-item:has-text("Convert to polygon")');
await page.waitForTimeout(400);
const kind = await page.$eval('.insp-kind', (e) => e.textContent).catch(() => '');
check('gate converted to a polygon', /Polygon/.test(kind), kind);
await page.screenshot({ path: path.join(shots, '02-converted.png') });

// ---- drag a polygon vertex (select tool) and check counts change
const countOf = async (name) => {
  const rows = await page.$$('.tree-row');
  for (const r of rows) {
    const label = await r.$eval('.tree-label', (e) => e.textContent).catch(() => null);
    if (label === name) return r.$eval('.num', (e) => e.textContent);
  }
  return null;
};
const c1 = await countOf('Granulocytes');
const v = at(a, 0.8, 0.75);
const target = at(a, 0.42, 0.5);
await page.mouse.move(v[0], v[1]);
await page.mouse.down();
await page.mouse.move(target[0], target[1], { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(600);
const c2 = await countOf('Granulocytes');
check('dragging a polygon corner updates the population', c1 !== null && c2 !== null && c1 !== c2, `${c1} -> ${c2}`);

// ---- undo restores
await page.keyboard.press('Control+z');
await page.waitForTimeout(600);
const c3 = await countOf('Granulocytes');
check('undo reverts the corner drag', c3 === c1, `${c3} vs ${c1}`);

// ---- axis label dropdown on plot 1 (x axis)
const axisBtn = (await page.$$('.axis-x'))[1];
await axisBtn.click();
await page.waitForSelector('.axis-menu', { timeout: 3000 });
const hasScale = await page.$('.axis-menu .scale-editor');
check('axis label opens parameter menu with scale editor', !!hasScale);
await page.fill('.axis-menu .axis-search input', 'ssc-h');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const xLabel = await (await page.$$('.axis-x'))[1].textContent();
check('picking from the axis menu changes the parameter', /SSC-H/.test(xLabel), xLabel);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);

// y axis -> Count (histogram)
const yBtn = (await page.$$('.axis-y'))[1];
await yBtn.click();
await page.waitForSelector('.axis-menu');
await page.click('.axis-menu .axis-opt:has-text("Count")');
await page.waitForTimeout(500);
const yLabel = await (await page.$$('.axis-y'))[1].textContent();
check('Y-axis menu can switch a plot to a histogram', /Count/.test(yLabel), yLabel);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);

// ---- polygon tool
await page.keyboard.press('p');
a = areaOf(await canvasBox(0));
const pts = [[0.2, 0.25], [0.35, 0.25], [0.38, 0.4], [0.22, 0.42]].map(([x, y]) => at(a, x, y));
for (const [x, y] of pts) await page.mouse.click(x, y);
await page.mouse.dblclick(pts[3][0], pts[3][1]);
await page.waitForTimeout(400);
const ed2 = await page.$('.gate-name-edit input');
if (ed2) {
  await ed2.fill('Polygon test');
  await ed2.press('Enter');
}
await page.waitForTimeout(300);
names = await treeNames();
check('polygon gate drawn by clicking corners', names.includes('Polygon test'), names.slice(-3).join(', '));

// ---- quadrant tool on plot 2
await page.keyboard.press('q');
a = areaOf(await canvasBox(1));
const q = at(a, 0.5, 0.5);
await page.mouse.click(q[0], q[1]);
await page.waitForTimeout(500);
names = await treeNames();
const quads = names.filter((n) => /FSC-A[+−] FSC-H[+−]/.test(n));
check('quadrant tool creates four linked gates', quads.length === 4, quads.join(', '));

// ---- delete via keyboard
await page.keyboard.press('Escape');
await page.click('.tree-row:has-text("Polygon test")');
await page.keyboard.press('Delete');
await page.waitForTimeout(300);
names = await treeNames();
check('Delete key removes the selected gate', !names.includes('Polygon test'));

// ---- workspace rename + autosave + reload
await page.click('.ws-name');
await page.fill('.ws-name-input', 'My PBMC analysis');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const wsName = await page.$eval('.ws-name-text', (e) => e.textContent);
check('workspace renamed from the header', wsName === 'My PBMC analysis', wsName);
await page.click('.view-tab:has-text("Statistics")');
await page.waitForTimeout(900);
const status = await page.$eval('.save-chip', (e) => e.textContent);
check('changing view saves the workspace', /Saved/.test(status), status);
await page.screenshot({ path: path.join(shots, '03-statistics.png') });
await page.click('.view-tab:has-text("Gating")');
await page.waitForTimeout(500);
await page.reload();
await ready();
const wsName2 = await page.$eval('.ws-name-text', (e) => e.textContent);
check('workspace name survives a reload', wsName2 === 'My PBMC analysis', wsName2);
names = await treeNames();
check('gates survive a reload (autosave)', names.includes('Granulocytes') && names.filter((n) => /FSC-A[+−] FSC-H[+−]/.test(n)).length === 4, names.length + ' gates');

// ---- per-sample adjustment
await page.click('.seg button:has-text("This sample")');
a = areaOf(await canvasBox(0));
const g = at(a, 0.67, 0.65);
const before4 = await countOf('Granulocytes');
await page.mouse.move(g[0], g[1]);
await page.mouse.down();
await page.mouse.move(g[0] - 25, g[1] + 20, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(600);
const adj = await page.$$eval('.tree-row', (rows) => rows.filter((r) => r.textContent.includes('Granulocytes') && r.querySelector('.adj-pill')).length);
check('"This sample" edits create a sample-specific gate', adj === 1);
await page.click('.seg button:has-text("All samples")');
await page.keyboard.press(']');
await page.waitForTimeout(800);
const adj2 = await page.$$eval('.tree-row .adj-pill', (els) => els.length);
check('other samples keep the shared gate', adj2 === 0);
await page.keyboard.press('[');
await page.waitForTimeout(500);
void before4;

// ---- compensation from single stains
await page.click('.view-tab:has-text("Compensation")');
await page.waitForTimeout(800);
await page.click('.btn:has-text("Compute from single stains")');
await page.waitForSelector('.ctl-table');
const assigned = await page.$$eval('.ctl-row select', (sels) => sels.map((s) => s.value));
check('controls are matched to detectors by file name', assigned.filter((v) => v && v !== 'unstained').length === 7 && assigned.includes('unstained'), assigned.join(','));
await page.click('.dialog .btn-primary');
await page.waitForSelector('.dialog .mat-table', { timeout: 15000 });
const fitcPe = await page.$$eval('.dialog .mat-table tbody tr', (rows) => {
  const r = rows.find((x) => x.querySelector('th').textContent.includes('FITC-A'));
  return r ? [...r.querySelectorAll('td')].map((td) => td.textContent) : [];
});
const val = parseFloat(fitcPe[3]);
check('computed FITC→PE spillover matches the simulated truth (24%)', Math.abs(val - 24) < 1.0, `${val}%`);
await page.click('.dialog .btn:has-text("Save and use as default")');
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(shots, '04-compensation.png') });

// ---- exports (standalone page uses normal downloads)
await page.click('.view-tab:has-text("Gating")');
await page.waitForTimeout(600);
const dl = async (fn) => {
  try {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), fn()]);
    const p = path.join(shots, d.suggestedFilename());
    await d.saveAs(p);
    return p;
  } catch (e) {
    const toasts = await page.$$eval('.toast', (els) => els.map((t) => t.textContent)).catch(() => []);
    console.log('download failed:', e.message.split('\n')[0], '| toasts:', toasts.join(' / '));
    await page.screenshot({ path: path.join(shots, 'download-fail.png') });
    return null;
  }
};
await page.click('.ws-menu');
const tplPath = await dl(() => page.click('.menu-item:has-text("Save as template")'));
const tpl = tplPath ? JSON.parse(fs.readFileSync(tplPath, 'utf8')) : {};
check('template export contains gates, scales and compensation', tpl.format === 'kestrel-template' && tpl.gates.length > 10 && Object.keys(tpl.transforms).length > 5 && tpl.comp.matrices.length === 1, `${(tpl.gates || []).length} gates`);
await page.click('.ws-menu');
const gmlPath = await dl(() => page.click('.menu-item:has-text("Export gates (.xml)")'));
const gml = gmlPath ? fs.readFileSync(gmlPath, 'utf8') : '';
check('Gating-ML export', gml.includes('<gating:Gating-ML') && gml.includes('transforms:spectrumMatrix'), path.basename(gmlPath));
await page.click('.tree-row:has-text("T cells")', { button: 'right' });
await page.click('.menu-item:has-text("Export events")');
const fcsPath = await dl(() => page.click('.menu-sub .menu-item:has-text("FCS file")'));
const head = fcsPath ? fs.readFileSync(fcsPath).subarray(0, 6).toString() : '';
check('population exported as FCS', head === 'FCS3.1', fcsPath ? `${path.basename(fcsPath)} ${fs.statSync(fcsPath).size} bytes` : 'no file');
await page.keyboard.press('Escape');
const pngPath = await dl(async () => {
  await (await page.$$('.plot-card .ibtn[aria-label="Plot options"]'))[0].click();
  await page.click('.menu-item:has-text("Export image (PNG)")');
});
check('plot exported as PNG', !!pngPath && fs.readFileSync(pngPath).subarray(1, 4).toString() === 'PNG');
const svgPath = await dl(async () => {
  await (await page.$$('.plot-card .ibtn[aria-label="Plot options"]'))[0].click();
  await page.click('.menu-item:has-text("Export image (SVG)")');
});
const svg = svgPath ? fs.readFileSync(svgPath, 'utf8') : '';
check('plot exported as SVG with vector gates', svg.startsWith('<?xml') && svg.includes('<path') && svg.includes('<image'));

// ---- apply the template to a fresh workspace
await page.click('.ws-menu');
await page.click('.menu-item:has-text("New workspace")');
await page.waitForTimeout(800);
const empty = await page.$('.empty-title');
check('new workspace starts empty', !!empty);

// ---- layout + dark mode + phone width screenshots
await page.goto(url);
await page.waitForTimeout(500);
await page.click('.ws-menu');
await page.click('.menu-item:has-text("Open saved workspace")');
await page.waitForSelector('.ws-row');
const rows = await page.$$eval('.ws-row b', (els) => els.map((e) => e.textContent));
check('workspace library lists saved workspaces', rows.includes('My PBMC analysis'), rows.join(', '));
await page.click('.ws-row:has-text("My PBMC analysis") .btn-primary');
await ready();
await page.screenshot({ path: path.join(shots, '05-reopened.png') });

const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const dp = await dark.newPage();
await dp.goto(url);
await dp.waitForSelector('.plot-card');
await dp.waitForTimeout(2500);
await dp.screenshot({ path: path.join(shots, '06-dark.png') });
await dark.close();

const phone = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const pp = await phone.newPage();
await pp.goto(url);
await pp.waitForSelector('.plot-card');
await pp.waitForTimeout(2500);
const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('no horizontal page scroll at phone width', overflow <= 0, `overflow ${overflow}px`);
await pp.screenshot({ path: path.join(shots, '07-phone.png'), fullPage: false });
await phone.close();

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
