// Choosing the samples for Batch and Layout: all, a group, or a hand-picked
// list in any order (arrows, drag, or a sort), saved with the workspace.
//
//   node e2e/sample-select.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file://' + path.join(root, 'dist', 'kestrel.html'));
await page.waitForSelector('.sample-row', { timeout: 30000 });
await page.waitForFunction(() => {
  const s = window.kestrel.state();
  return s.doc.samples.every((x) => (s.meta[x.id] || {}).status === 'ready');
}, null, { timeout: 60000 });

const batchRows = () => page.$$eval('.batch-all .batch-row', (els) => els.map((e) => e.textContent));
await page.click('.view-tab:has-text("Batch")');
await page.waitForTimeout(800);
const start = await batchRows();
check('Batch starts with the Samples group', start.join(',') === 'PBMC_Donor01,PBMC_Donor02,PBMC_Donor03', start.join(','));

// the Batch rows follow the sample list's sort (set in the Gating view's sidebar)
await page.click('.view-tab:has-text("Gating")');
await page.click('.sort-btn');
await page.click('.menu-item:has-text("Name")');
await page.click('.sort-btn');
await page.click('.menu-item:has-text("Descending")');
await page.click('.view-tab:has-text("Batch")');
await page.waitForTimeout(800);
check('sorting the sample list re-orders the Batch rows', (await batchRows()).join(',') === 'PBMC_Donor03,PBMC_Donor02,PBMC_Donor01', (await batchRows()).join(','));
await page.click('.view-tab:has-text("Gating")');
await page.click('.sort-note .link-btn');
await page.click('.view-tab:has-text("Batch")');
await page.waitForTimeout(500);

// hand-pick: Donor03, then a compensation control, then Donor01
await page.click('.batch-bar .sample-select-btn');
await page.waitForSelector('.sample-chooser');
await page.selectOption('.sample-chooser select', 'custom');
await page.waitForTimeout(200);
const chosen = () => page.$$eval('.sample-chooser .ss-row.is-chosen .ss-name', (els) => els.map((e) => e.textContent));
check('"Samples I choose" starts from what was shown', (await chosen()).join(',') === 'PBMC_Donor01,PBMC_Donor02,PBMC_Donor03', (await chosen()).join(','));
await page.click('.sample-chooser .ss-row:has-text("PBMC_Donor02") input');
await page.click('.sample-chooser .ss-row:has-text("Comp_FITC-A") input');
await page.waitForTimeout(200);
check('ticking and unticking samples picks them', (await chosen()).join(',') === 'PBMC_Donor01,PBMC_Donor03,Comp_FITC-A', (await chosen()).join(','));
await page.click('.sample-chooser .ss-row:has-text("PBMC_Donor03") .ibtn[aria-label^="Move PBMC_Donor03 up"]');
await page.waitForTimeout(200);
check('the arrows move a sample', (await chosen()).join(',') === 'PBMC_Donor03,PBMC_Donor01,Comp_FITC-A', (await chosen()).join(','));
// drag the control to the top
await page.dragAndDrop('.sample-chooser .ss-row:has-text("Comp_FITC-A")', '.sample-chooser .ss-row:has-text("PBMC_Donor03")');
await page.waitForTimeout(200);
check('dragging moves a sample', (await chosen()).join(',') === 'Comp_FITC-A,PBMC_Donor03,PBMC_Donor01', (await chosen()).join(','));
// the "Sort…" menu opens inside the chooser without closing it
await page.click('.sample-chooser .link-btn:has-text("Sort")');
await page.click('.menu-item:has-text("Name")');
await page.waitForTimeout(300);
check('Sort… orders the chosen samples (and the chooser stays open)', (await chosen()).join(',') === 'Comp_FITC-A,PBMC_Donor01,PBMC_Donor03', (await chosen()).join(','));
await page.click('.sample-chooser .link-btn:has-text("Sort")');
await page.click('.menu-item:has-text("Reverse")');
await page.waitForTimeout(300);
const order = await chosen();
await page.mouse.click(5, 995);
await page.waitForTimeout(1500);
check('the Batch grid shows exactly the chosen samples, in that order', (await batchRows()).join(',') === order.join(','), (await batchRows()).join(','));
check('the button says how many were chosen', (await page.$eval('.batch-bar .sample-select-btn', (e) => e.textContent)) === '3 chosen samples');
const panels = await page.$$eval('.batch-all .batch-cell', (e) => e.length);
const cols = await page.$$eval('.batch-all .batch-col', (e) => e.length);
check('…each with every plot', panels === cols * 3, `${panels} panels`);

// Layout has the same chooser, separately
await page.click('.view-tab:has-text("Layout")');
await page.waitForTimeout(600);
await page.click('.layout-side .sample-select-btn');
await page.selectOption('.sample-chooser select', 'custom');
await page.click('.sample-chooser .link-btn:has-text("None")');
for (const n of ['PBMC_Donor02', 'PBMC_Donor01']) await page.click(`.sample-chooser .ss-row:has-text("${n}") input`);
await page.mouse.click(5, 995);
await page.waitForTimeout(1500);
const layoutRows = await page.$$eval('.layout-main .batch-row', (els) => els.map((e) => e.textContent));
check('Layout shows its own hand-picked samples in the order picked', layoutRows.join(',') === 'PBMC_Donor02,PBMC_Donor01', layoutRows.join(','));
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
check('Layout\'s choice undoes', (await page.$$eval('.layout-main .batch-row', (els) => els.map((e) => e.textContent))).join(',') === 'PBMC_Donor02', 'one step back');

// both are saved with the workspace
await page.reload();
await page.waitForSelector('.topbar', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.click('.view-tab:has-text("Batch")');
await page.waitForTimeout(1500);
check('the Batch choice and order are saved with the workspace', (await batchRows()).join(',') === order.join(','), (await batchRows()).join(','));
// back to a group
await page.click('.batch-bar .sample-select-btn');
await page.selectOption('.sample-chooser select', { label: 'All samples' });
await page.mouse.click(5, 995);
await page.waitForTimeout(1500);
check('switching back to "All samples" shows every loaded sample', (await batchRows()).length === 11, `${(await batchRows()).length}`);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
