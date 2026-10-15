// Performance check: load a large FCS file, gate it with the demo template, time each stage.
//   node e2e/perf.mjs [events]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSample } from '../src/core/demo-data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = parseInt(process.argv[2] || '1000000', 10);
const t0 = Date.now();
const bytes = generateSample({ kind: 'cells', donor: 'PBMC_Donor02', seed: 777, events: N, name: 'Big' });
console.log(`generated ${N.toLocaleString()} events (${(bytes.length / 1e6).toFixed(1)} MB) in ${Date.now() - t0} ms`);

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/big.fcs')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  }
  const f = path.join(root, 'dist', 'kestrel.html');
  res.writeHead(200, { 'content-type': 'text/html' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${port}/`);
await page.waitForSelector('.plot-card');
await page.waitForFunction(() => [...document.querySelectorAll('.plot-foot .num')].every((e) => !e.textContent.includes('…')), null, { timeout: 60000 });
// work on a copy of the demo so the big file is gated by the demo template
await page.click('.ws-menu');
await page.click('.menu-item:has-text("Duplicate this workspace")');
await page.waitForFunction(() => window.kestrel.state().doc.name.endsWith('(copy)'));
await page.waitForFunction(() => { const st = window.kestrel.state(); return st.doc.samples.every((x) => (st.meta[x.id] || {}).status === 'ready'); }, null, { timeout: 60000 });
await page.waitForFunction(() => [...document.querySelectorAll('.plot-foot .num')].every((e) => !e.textContent.includes('…')), null, { timeout: 60000 });
await page.evaluate((n) => { window.__N = n; }, N >= 1e6 ? `${N / 1e6}M` : `${N / 1e3}K`);
const tag = N >= 1e6 ? `${N / 1e6}M` : `${N / 1e3}K`;
const res = await page.evaluate(async () => {
  const T = performance.now();
  const r = await fetch('/big.fcs');
  const blob = await r.blob();
  const tFetch = performance.now() - T;
  const t1 = performance.now();
  await window.kestrel.addFiles([new File([blob], 'Big_' + (window.__N || 'X') + '.fcs')]);
  const tLoad = performance.now() - t1;
  const st = window.kestrel.state();
  const id = st.doc.samples.find((s) => s.name === 'Big_' + window.__N).id;
  return { tFetch, tLoad, id };
});
console.log(`fetch ${res.tFetch.toFixed(0)} ms; parse + transfer + load ${res.tLoad.toFixed(0)} ms`);
// switch to the big sample and time until every plot has rendered
const t2 = Date.now();
await page.click('.sample-pick');
await page.click(`.menu-item:has-text("Big_${tag}")`);
await page.waitForFunction((n) => {
  const nums = [...document.querySelectorAll('.plot-foot .num')].map((e) => e.textContent);
  return nums.length && nums.every((t) => !t.includes('…')) && nums[0].replace(/,/g, '').startsWith(String(n));
}, N, { timeout: 120000 }).catch((e) => console.log('wait failed', e.message));
await page.waitForFunction(() => document.querySelectorAll('.tree-row .num').length > 0 && ![...document.querySelectorAll('.tree-row .num')].some((e) => e.textContent === '–'), null, { timeout: 120000 }).catch(() => {});
console.log(`switch sample -> all 8 plots + 13 populations ready: ${Date.now() - t2} ms`);
// change a display scale (FITC Logicle width) and time until every plot has re-rendered
const t4 = Date.now();
await page.click('.axis-x:has-text("FITC-A")');
await page.waitForSelector('.axis-menu input[type="range"]');
await page.$eval('.axis-menu input[type="range"]', (el) => { el.value = '1.1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.keyboard.press('Escape');
await page.waitForTimeout(50);
await page.waitForFunction(() => [...document.querySelectorAll('.plot-foot .num')].every((e) => !e.textContent.includes('…')), null, { timeout: 60000 });
await page.waitForTimeout(100);
console.log(`re-scale FITC (Logicle W) and redraw: ${Date.now() - t4} ms`);
await page.screenshot({ path: process.env.SHOT || '/tmp/perf.png' });
const mem = await page.evaluate(() => (performance.memory ? (performance.memory.usedJSHeapSize / 1e6).toFixed(0) + ' MB main-thread heap' : 'n/a'));
console.log('memory:', mem);
await browser.close();
server.close();
