// The Samples tab: add your own columns of sample information, fill them by
// typing, pasting or importing a sheet, and use them like keywords (groups,
// sorting, the Statistics table).
//
//   node e2e/samples-view.mjs

import { chromium } from 'playwright';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file://' + path.join(root, 'dist', 'kestrel.html'));
await page.waitForSelector('.sample-row', { timeout: 30000 });
await page.waitForFunction(() => {
  const s = window.kestrel.state();
  return s.doc.samples.every((x) => (s.meta[x.id] || {}).status === 'ready');
}, null, { timeout: 60000 });

const tabs = await page.$$eval('.view-tab', (els) => els.map((e) => e.textContent.trim()));
check('Samples is the leftmost tab, and there is no Batch tab', tabs[0] === 'Samples' && !tabs.includes('Batch'), tabs.join(', '));
await page.click('.view-tab:has-text("Samples")');
await page.waitForSelector('.samples-table');
const names = await page.$$eval('.samples-table tbody .name-input', (els) => els.map((e) => e.value));
check('one row per sample', names.length === 11, `${names.length}`);

// add a column and name it
await page.click('.vt-right .btn-primary:has-text("Add column")');
await page.waitForSelector('.th-input');
await page.keyboard.type('Treatment');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check('"Add column" makes a column you name straight away', (await page.evaluate(() => window.kestrel.state().doc.metaFields)).join() === 'Treatment');

// type into cells, Enter moves down
await page.click('.samples-table tbody tr:nth-child(1) td.own-col input');
await page.keyboard.type('Stim');
await page.keyboard.press('Enter');
await page.keyboard.type('Unstim');
await page.waitForTimeout(300);
let sm = await page.evaluate(() => {
  const s = window.kestrel.state();
  return s.doc.samples.slice(0, 3).map((x) => ((s.doc.sampleMeta || {})[x.id] || {}).Treatment || '');
});
check('typing fills cells, and Enter moves to the next row', sm.join(',') === 'Stim,Unstim,', sm.join(','));

// paste a block from a spreadsheet: two columns, three rows, starting at row 3 → adds a column
await page.evaluate(() => navigator.clipboard.writeText('Stim\t3\nUnstim\t3\nStim\t4\n'));
await page.click('.samples-table tbody tr:nth-child(3) td.own-col input');
await page.keyboard.press('Control+v');
await page.waitForTimeout(400);
sm = await page.evaluate(() => {
  const s = window.kestrel.state();
  return { fields: s.doc.metaFields, rows: s.doc.samples.slice(0, 5).map((x) => Object.values((s.doc.sampleMeta || {})[x.id] || {}).join('/')) };
});
check('pasting a block fills down and across, adding a column for the extra one', sm.fields.length === 2 && sm.rows.join(',') === 'Stim,Unstim,Stim/3,Unstim/3,Stim/4', JSON.stringify(sm));

// rename the new column from its header menu
await page.click('.samples-table thead th.own-col:nth-of-type(5) .th-btn');
await page.click('.menu-item:has-text("Rename")');
await page.waitForSelector('.th-input');
await page.keyboard.press('Control+a');
await page.keyboard.type('Donor');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
check('a column can be renamed; its values go with it', await page.evaluate(() => {
  const s = window.kestrel.state();
  return s.doc.metaFields.join() === 'Treatment,Donor' && s.doc.sampleMeta[s.doc.samples[2].id].Donor === '3';
}));

// import a sheet: matched by file name, fills an existing and a new column
const tmp = await mkdtemp(path.join(os.tmpdir(), 'kestrel-sheet-'));
const sheet = path.join(tmp, 'plate map.csv');
await writeFile(sheet, 'File,Donor,Day\nPBMC_Donor01.fcs,1,0\nPBMC_Donor02.fcs,2,7\nnot-here.fcs,9,9\n');
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.vt-right .btn:has-text("Import sheet")')]);
await chooser.setFiles(sheet);
await page.waitForTimeout(600);
sm = await page.evaluate(() => {
  const s = window.kestrel.state();
  return { fields: s.doc.metaFields, d1: s.doc.sampleMeta[s.doc.samples[0].id], d2: s.doc.sampleMeta[s.doc.samples[1].id] };
});
check('importing a sheet matches rows to samples and fills the columns', sm.fields.join() === 'Treatment,Donor,Day' && sm.d1.Donor === '1' && sm.d2.Day === '7' && sm.d1.Treatment === 'Stim', JSON.stringify(sm));
const toastText = await page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' / '));
check('…and says what it matched and what it could not', /for 2 of 11 samples/.test(toastText) && /not-here\.fcs/.test(toastText), toastText.slice(0, 160));

// make groups from a column
await page.click('.samples-table thead th.own-col:nth-of-type(4) .th-btn');
await page.click('.menu-item:has-text("Make a group for each value")');
await page.waitForTimeout(300);
const groups = await page.evaluate(() => window.kestrel.state().doc.groups.map((g) => g.name));
check('a column makes a group for each value (and none for blanks)', groups.includes('Stim') && groups.includes('Unstim') && !groups.includes('(none)'), groups.join(', '));

// sort by a column header
await page.click('.samples-table thead th.own-col:nth-of-type(4) .th-btn');
await page.click('.menu-item:has-text("Sort samples by this")');
await page.waitForTimeout(300);
const sorted = await page.$$eval('.samples-table tbody tr', (trs) => trs.slice(0, 5).map((tr) => tr.querySelector('td.own-col input').value));
check('samples can be sorted by a column', sorted.join(',') === 'Stim,Stim,Stim,Unstim,Unstim', sorted.join(','));

// show a file keyword, and make an editable copy that overrides it
await page.click('.vt-right .btn:has-text("Show file keyword")');
await page.click('.menu-item:has-text("TUBE NAME")');
await page.waitForTimeout(200);
check('a file keyword can be shown as a read-only column', (await page.$$eval('.samples-table thead th.kw-col', (els) => els.map((e) => e.textContent.trim()))).some((t) => t.startsWith('TUBE NAME')));

// the column is a keyword everywhere: Statistics table
await page.click('.view-tab:has-text("Statistics")');
await page.waitForTimeout(400);
await page.click('.btn:has-text("Add keyword")');
await page.fill('.adder input.field', 'Treatment');
await page.click('.adder .btn-primary');
await page.waitForTimeout(800);
const kwCells = await page.$$eval('td.kw-cell', (els) => els.map((e) => e.textContent));
check('your column can be added to the Statistics table', kwCells.includes('Stim') && kwCells.includes('Unstim'), kwCells.slice(0, 4).join(','));

// one undo step per action
await page.click('.view-tab:has-text("Samples")');
const before = await page.evaluate(() => window.kestrel.state().doc.metaFields.length);
await page.click('.samples-table thead th.own-col:nth-of-type(6) .th-btn');
await page.click('.menu-item:has-text("Delete column")');
await page.waitForTimeout(200);
const afterDel = await page.evaluate(() => window.kestrel.state().doc.metaFields.length);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const afterUndo = await page.evaluate(() => window.kestrel.state().doc.metaFields.length);
check('deleting a column undoes', afterDel === before - 1 && afterUndo === before, `${before} → ${afterDel} → ${afterUndo}`);

// saved with the workspace file
await page.click('.ws-menu');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.menu-item:has-text("Save workspace file")')]);
const saved = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
check('the columns and values are saved in the workspace file', saved.metaFields.join() === 'Treatment,Donor,Day' && Object.keys(saved.sampleMeta).length >= 5);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await rm(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
