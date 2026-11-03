// Layout panel styling: each plot in a figure can have its own size, text
// size and visible elements, over defaults set for the whole figure; the
// figure's grid and its PNG export follow them, and changes undo.
//
//   node e2e/layout-style.mjs

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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file://' + path.join(root, 'dist', 'kestrel.html'));
await page.waitForSelector('.sample-row', { timeout: 30000 });
await page.waitForFunction(() => {
  const s = window.kestrel.state();
  return s.doc.samples.every((x) => (s.meta[x.id] || {}).status === 'ready');
}, null, { timeout: 60000 });
await page.click('.view-tab:has-text("Layout")');
await page.waitForTimeout(800);
// a figure of the gating path: All events, Cells, Singlets (in that order), nothing else
await page.evaluate(() => 0);
for (const label of await page.$$eval('.layout-side .plot-pick', (rows) => rows.filter((r) => r.querySelector('input').checked).map((r) => r.textContent))) {
  await page.click(`.layout-side .plot-pick:has-text("${label.split(' · ')[0]} · ") input`);
}
for (const n of ['All events', 'Cells', 'Singlets']) await page.click(`.layout-side .plot-pick:has-text("${n} · ") input`);
await page.waitForTimeout(2000);
const widths = () => page.$$eval('.layout-main .panel-btn canvas', (els) => els.slice(0, 3).map((c) => Math.round(c.getBoundingClientRect().width)));
const heights = () => page.$$eval('.layout-main .panel-btn canvas', (els) => els.slice(0, 3).map((c) => Math.round(c.getBoundingClientRect().height)));
check('the figure has the three plots, at the figure\'s panel size', JSON.stringify(await widths()) === '[220,220,220]', JSON.stringify(await widths()));

// click the first plot in the figure: its own settings
await page.click('.layout-main .panel-btn >> nth=0');
await page.waitForSelector('.panel-style-pop', { timeout: 3000 });
check('clicking a plot in the figure opens its settings', /All events/.test(await page.$eval('.panel-style-head', (e) => e.textContent)));
const setRange = (label, v) => page.$eval(`.panel-style-pop input[aria-label="${label}"]`, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const h0 = (await heights())[0];
await setRange('Panel size', 130);
await page.waitForTimeout(400);
const w1 = await widths();
check('a plot can be made smaller, in every row, without changing the others', w1[0] === 130 && w1[1] === 220 && w1[2] === 220, JSON.stringify(w1));
const colW = await page.$eval('.layout-main .layout-grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ')[1]);
check('…and its column narrows to fit', colW === '130px', colW);
const hSmall = (await heights())[0];
await page.click('.panel-style-pop .check-row:has-text("Axis numbers") input');
await page.waitForTimeout(400);
const hBare = (await heights())[0];
check('hiding axis numbers gives the room to the data (bigger square plot at the same width)', hBare > hSmall && (await widths())[0] === 130, `${hSmall} → ${hBare}px tall`);
await page.click('.panel-style-pop .seg button[title="The number only"]');
await setRange('Text size', 0.8);
await page.waitForTimeout(300);
let st = await page.evaluate(() => {
  const s = window.kestrel.state();
  const L = s.doc.layout;
  return (L.plotStyles || {})[L.plotIds[0]];
});
check('the plot\'s own settings are saved with the workspace', st && st.size === 130 && st.tickLabels === false && st.gateLabels === 'value' && st.font === 0.8, JSON.stringify(st));
const ownMarks = await page.$$eval('.panel-style-pop .is-own', (els) => els.length);
check('each setting the plot changed is marked', ownMarks >= 4, `${ownMarks} marked`);
// put one back
await page.click('.panel-style-pop .check-row:has-text("Axis numbers") .own-mark');
await page.waitForTimeout(300);
st = await page.evaluate(() => {
  const L = window.kestrel.state().doc.layout;
  return L.plotStyles[L.plotIds[0]];
});
check('one setting can be put back to the figure\'s', st.tickLabels === undefined && st.size === 130, JSON.stringify(st));
await page.mouse.click(5, 995);
await page.waitForTimeout(300);
check('the settings close when clicking elsewhere', !(await page.$('.panel-style-pop')));

// figure-wide default: bigger text everywhere, except where a plot has its own
await page.$eval('.layout-side input[aria-label="Text size"]', (el) => { el.value = 1.4; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForTimeout(500);
const hs = await heights();
check('the figure\'s text size changes every plot that doesn\'t set its own', hs[1] !== h0, JSON.stringify(hs));
const fonts = await page.evaluate(() => {
  const L = window.kestrel.state().doc.layout;
  return [L.panel.font, L.plotStyles[L.plotIds[0]].font];
});
check('…and the plot with its own text size keeps it', fonts[0] === 1.4 && fonts[1] === 0.8, JSON.stringify(fonts));
// the list marks the plot that has its own settings
const marked = await page.$$eval('.layout-side .plot-pick .ibtn.is-active', (els) => els.length);
check('the plot list marks plots with their own settings', marked === 1, `${marked}`);

// undo the figure-wide text size in one step (the slider's drags coalesce)
await page.keyboard.press('Control+z');
await page.waitForTimeout(400);
check('undo reverts the change', await page.evaluate(() => (window.kestrel.state().doc.layout.panel || {}).font !== 1.4));

// reset the plot completely from its settings
await page.click('.layout-side .plot-pick .ibtn.is-active');
await page.waitForSelector('.panel-style-pop');
await page.click('.panel-style-reset');
await page.waitForTimeout(300);
check('"Use the figure\'s settings" clears all of a plot\'s own settings', await page.evaluate(() => {
  const L = window.kestrel.state().doc.layout;
  return !(L.plotStyles || {})[L.plotIds[0]];
}));
await page.mouse.click(5, 995);

// export follows the styles: make the first plot small again, export, check the image width
await page.click('.layout-main .panel-btn >> nth=0');
await page.waitForSelector('.panel-style-pop');
await setRange('Panel size', 120);
await page.mouse.click(5, 995);
await page.waitForTimeout(800);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('.layout-side .btn:has-text("Export PNG")')]);
const file = await dl.path();
const { readFile } = await import('node:fs/promises');
const png = await readFile(file);
const pngW = png.readUInt32BE(16);
// 150 row heading + (120 + 220 + 220) panels + 3 × 12 gaps, at 2× for print
check('the PNG export lays panels out at their own sizes', pngW === 2 * (150 + 120 + 220 + 220 + 3 * 12), `${pngW}px wide`);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
