// Verifies the "double-click a .kestrel.json to open it" workflow end to
// end: runs the real launcher script against a real workspace file, then
// drives a real (headless) browser to the URL it prints, the way Windows
// opening a browser tab would, and checks the workspace actually loads.
//
//   node e2e/open-workspace.mjs

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyDoc } from '../src/ui/state/doc.js';
import { workspaceFile } from '../src/ui/state/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'kestrel-open-'));
const wsPath = path.join(tmp, 'My double-click test.kestrel.json');
const doc = emptyDoc('My double-click test');
await writeFile(wsPath, JSON.stringify(workspaceFile(doc)));

const child = spawn('node', [path.join(root, 'scripts', 'open-workspace.mjs'), wsPath], {
  cwd: root,
  env: { ...process.env, KESTREL_NO_OPEN: '1' },
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));

const url = await new Promise((resolve, reject) => {
  let out = '';
  const timeout = setTimeout(() => reject(new Error(`launcher never printed a URL. stderr: ${stderr}`)), 10000);
  child.stdout.on('data', (d) => {
    out += d;
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?openWorkspace=1/);
    if (m) {
      clearTimeout(timeout);
      resolve(m[0]);
    }
  });
});
check('the launcher starts a local server and prints its URL', /^http:\/\/127\.0\.0\.1:\d+\/\?openWorkspace=1$/.test(url), url);

// This sandbox routes all outbound traffic through an agent proxy, which
// otherwise also swallows requests to the launcher's own 127.0.0.1 server.
// A real machine has no such proxy in the way.
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForSelector('.topbar', { timeout: 15000 });
// Loading the demo workspace (restoreLast's fallback, since this fresh
// browser profile has no saved workspace) and then swapping in the
// double-clicked file both take a few seconds.
await page.waitForTimeout(6000);
const name = await page.$eval('.ws-name-text', (el) => el.textContent).catch(() => null);
check('the double-clicked workspace opens with its name', name === 'My double-click test', name);
check('the query string is cleared after opening (so a reload does not reopen it)', new URL(page.url()).search === '', page.url());
check('no page errors while opening', errors.length === 0, errors.join(' | '));

await browser.close();
const exited = await new Promise((resolve) => {
  if (child.exitCode !== null) return resolve(true);
  child.on('exit', () => resolve(true));
  setTimeout(() => resolve(false), 6000);
});
check('the launcher process exits on its own once the page has the file', exited);

await rm(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
