// Verifies the "double-click a .kestrel.json to open it" workflow end to
// end: runs the real launcher script against a real workspace file, then
// drives a real (headless) browser to the URL it prints, the way Windows
// opening a browser tab would, and checks that:
//   - the workspace opens (without first loading the last one),
//   - data files sitting next to it load on their own (names matched
//     without regard to case, subfolders included),
//   - the launcher exits by itself as soon as the page has the files, so
//     its console window closes,
//   - anything not found brings up a "choose the folder" dialog, which
//     loads the files from the folder picked and then closes itself.
//
//   node e2e/open-workspace.mjs

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyDoc } from '../src/ui/state/doc.js';
import { workspaceFile } from '../src/ui/state/loader.js';
import { generateSample } from '../src/core/demo-data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'kestrel-open-'));
const sample = (id, fileName) => ({ id, name: fileName.replace(/\.fcs$/i, ''), fileName, size: 0, nEvents: 0, channels: [], groupIds: [], source: { type: 'file' } });
const fcs = (donor, seed) => generateSample({ kind: 'cells', donor, seed, events: 20000, name: donor });

// The workspace lists three data files:
//   Donor_A.fcs  — right next to it, but saved as "donor_a.FCS"
//   Donor_B.fcs  — in a "fcs" subfolder next to it
//   Donor_C.fcs  — somewhere else entirely (found via the folder dialog)
const doc = emptyDoc('My double-click test');
doc.samples = [sample('sA', 'Donor_A.fcs'), sample('sB', 'Donor_B.fcs'), sample('sC', 'Donor_C.fcs')];
const wsDir = path.join(tmp, 'experiment');
await mkdir(path.join(wsDir, 'fcs'), { recursive: true });
const elsewhere = path.join(tmp, 'elsewhere', 'raw');
await mkdir(elsewhere, { recursive: true });
await writeFile(path.join(wsDir, 'donor_a.FCS'), fcs('PBMC_Donor01', 11));
await writeFile(path.join(wsDir, 'fcs', 'Donor_B.fcs'), fcs('PBMC_Donor02', 12));
await writeFile(path.join(elsewhere, 'Donor_C.fcs'), fcs('PBMC_Donor03', 13));
await writeFile(path.join(elsewhere, 'unrelated.fcs'), fcs('PBMC_Donor03', 14));
const wsPath = path.join(wsDir, 'My double-click test.kestrel.json');
await writeFile(wsPath, JSON.stringify(workspaceFile(doc)));

const child = spawn('node', [path.join(root, 'scripts', 'open-workspace.mjs'), wsPath], {
  cwd: root,
  env: { ...process.env, KESTREL_NO_OPEN: '1' },
});
let stdout = '';
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
let exitedAt = null;
child.on('exit', () => (exitedAt = Date.now()));

const url = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`launcher never printed a URL. stderr: ${stderr}`)), 10000);
  child.stdout.on('data', (d) => {
    stdout += d;
    const m = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?openWorkspace=1/);
    if (m) {
      clearTimeout(timeout);
      resolve(m[0]);
    }
  });
});
check('the launcher starts a local server and prints its URL', /^http:\/\/127\.0\.0\.1:\d+\/\?openWorkspace=1$/.test(url), url);
check('the launcher finds the data files next to the workspace (any case, subfolders too)', /Found 2 of 3 data files/.test(stdout), stdout.split('\n')[0]);

// This sandbox routes all outbound traffic through an agent proxy, which
// otherwise also swallows requests to the launcher's own 127.0.0.1 server.
// A real machine has no such proxy in the way.
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage();
// The native folder picker can't be driven headless; hide it so the dialog
// uses its folder-upload input, which Playwright can fill with a folder.
await page.addInitScript(() => {
  delete window.showDirectoryPicker;
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForSelector('.topbar', { timeout: 15000 });
const status = () => page.evaluate(() => {
  const s = window.kestrel.state();
  return Object.fromEntries(s.doc.samples.map((x) => [x.fileName, (s.meta[x.id] || {}).status]));
});
await page.waitForFunction(() => {
  const s = window.kestrel.state();
  return s.doc.name === 'My double-click test' && s.doc.samples.length === 3 && s.doc.samples.filter((x) => (s.meta[x.id] || {}).status === 'ready').length === 2;
}, null, { timeout: 20000 }).catch(() => {});
const name = await page.$eval('.ws-name-text', (el) => el.textContent).catch(() => null);
check('the double-clicked workspace opens with its name', name === 'My double-click test', name);
const st1 = await status();
check('the data files found next to it load on their own', st1['Donor_A.fcs'] === 'ready' && st1['Donor_B.fcs'] === 'ready', JSON.stringify(st1));
check('the demo was not loaded first (the workspace opens straight away)', !(await page.evaluate(() => window.kestrel.state().doc.samples.some((x) => x.source && x.source.type === 'demo'))));
check('the query string is cleared after opening (so a reload does not reopen it)', new URL(page.url()).search === '', page.url());

// The launcher should be gone already: the page told it it had everything.
await new Promise((r) => setTimeout(r, 1500));
check('the launcher exits by itself once the page has the files (its window closes)', exitedAt !== null && child.exitCode === 0, `exit code ${child.exitCode}`);

// Donor_C wasn't anywhere near the workspace: the folder dialog asks for it.
await page.waitForSelector('.locate-dialog', { timeout: 5000 }).catch(() => {});
const listed = await page.$$eval('.locate-list li', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
check('a dialog asks for the folder holding the files that weren\'t found', listed.length === 1 && listed[0] === 'Donor_C.fcs', listed.join(', '));
const dirShown = await page.$eval('.locate-dir', (e) => e.textContent).catch(() => '');
check('the dialog says where it already looked', dirShown === wsDir, dirShown);

const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('.locate-dialog .btn-primary')]);
await chooser.setFiles(path.join(tmp, 'elsewhere'));
await page.waitForSelector('.locate-dialog', { state: 'detached', timeout: 10000 }).catch(() => {});
check('choosing the folder (searched with its subfolders) closes the dialog by itself', !(await page.$('.locate-dialog')));
await page.waitForFunction(() => {
  const s = window.kestrel.state();
  return s.doc.samples.every((x) => (s.meta[x.id] || {}).status === 'ready');
}, null, { timeout: 15000 }).catch(() => {});
const st2 = await status();
check('…and loads the missing file from it, ignoring unrelated ones', Object.values(st2).every((v) => v === 'ready') && Object.keys(st2).length === 3, JSON.stringify(st2));
check('no page errors while opening', errors.length === 0, errors.join(' | '));

await browser.close();
if (child.exitCode === null) child.kill();
await rm(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
