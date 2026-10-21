#!/usr/bin/env node
// Lets Windows (or macOS/Linux) "Open with" a .kestrel.json or
// .template.json file by double-clicking it: this script serves
// dist/kestrel.html plus the file itself from a short-lived local server,
// opens it in the default browser, and exits once the page has it.
//
// It exists only because a browser page has no way to read a file Windows
// just double-clicked — a double-click hands the *path* to whatever program
// is registered for the extension, not to a web page. This script is that
// program: it reads the file itself and serves it to the page over
// http://127.0.0.1, which the page is allowed to fetch (a direct file://
// fetch of another local file is blocked by the browser). Nothing is
// installed and nothing keeps running: the server exits a few seconds after
// the browser has fetched the file, or after 20s if nothing ever asked.
//
// Set up once, on Windows:
//   1. Right-click a .kestrel.json file -> Open with -> Choose another app.
//   2. "More apps" -> "Look for another app on this PC" (the picker may
//      default to showing only .exe files -- switch its file-type filter to
//      "All files" if open-kestrel-workspace.bat isn't selectable).
//   3. Browse to this repository's scripts\open-kestrel-workspace.bat.
//   4. Check "Always use this app to open .json files" -- or leave it
//      unchecked to be asked each time, since .json is also claimed by
//      other apps. (The README's `#open-workspace-files-by-double-clicking-windows`
//      section covers associating only `.kestrel.json` so this doesn't take
//      over every .json file on the machine.)
//
// Usage: node scripts/open-workspace.mjs <path-to-workspace-or-template.json>

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distHtml = path.join(here, '..', 'dist', 'kestrel.html');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node open-workspace.mjs <path-to-.kestrel.json>');
  process.exit(1);
}

function openInBrowser(url) {
  const plat = process.platform;
  const cmd = plat === 'win32' ? 'cmd' : plat === 'darwin' ? 'open' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  await stat(target).catch(() => {
    console.error(`Can't read "${target}".`);
    process.exit(1);
  });
  const [html, workspace] = await Promise.all([readFile(distHtml, 'utf8'), readFile(target)]);
  const fileName = path.basename(target);

  let served = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__workspace') {
      served = true;
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Kestrel-Filename': encodeURIComponent(fileName) });
      res.end(workspace);
      // kestrel.html is self-contained, so once it has the file it never
      // asks this server for anything else. Give it a moment, then exit.
      setTimeout(() => server.close(() => process.exit(0)), 3000);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/?openWorkspace=1`;
    console.log(url);
    if (!process.env.KESTREL_NO_OPEN) openInBrowser(url);
  });

  // Fall back to exiting even if the browser never shows up (blocked
  // pop-up, no default browser, etc.) so this doesn't linger forever.
  setTimeout(() => {
    if (!served) {
      console.error('Opened a browser tab, but it never asked for the file. Leaving the window open? Closing the helper.');
      server.close(() => process.exit(1));
    }
  }, 20000);
}

main();
