#!/usr/bin/env node
// Lets Windows (or macOS/Linux) "Open with" a .kestrel.json or
// .template.json file by double-clicking it: this script serves
// dist/kestrel.html, the file itself, and the workspace's data files (when
// they sit next to it) from a short-lived local server, opens it in the
// default browser, and exits once the page has everything.
//
// It exists only because a browser page has no way to read a file Windows
// just double-clicked — a double-click hands the *path* to whatever program
// is registered for the extension, not to a web page. This script is that
// program: it reads the files itself and serves them to the page over
// http://127.0.0.1, which the page is allowed to fetch (a direct file://
// fetch of another local file is blocked by the browser).
//
// Data files: a workspace file lists its samples' file names but doesn't
// contain the (large) FCS data. This script looks for those names in the
// workspace's own folder, then in its immediate subfolders, matching names
// without regard to case, and offers whatever it finds to the page, which
// loads them as if they'd been dropped onto the window. Anything still
// missing, the page asks for with a "choose the folder" dialog.
//
// Nothing is installed and nothing keeps running: the server exits as soon
// as the page says it's done (GET /__done), or after a spell with no
// requests if the page never says so.
//
// Set up once, on Windows: see README.md, "Open workspace files by
// double-clicking (Windows)".
//
// Usage: node scripts/open-workspace.mjs <path-to-workspace-or-template.json>
//
// Endpoints (all GET, 127.0.0.1 only):
//   /                      kestrel.html
//   /__workspace           the double-clicked file (X-Kestrel-Filename header)
//   /__manifest            {"dir", "found": [names], "missing": [names]}
//   /__data/<name>         the bytes of one found data file, by the name the
//                          workspace uses for it
//   /__done                the page has everything; the server exits

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distHtml = path.join(here, '..', 'dist', 'kestrel.html');

// How long to wait for the browser to ask for the workspace at all, and how
// long to linger with no requests once it has (if it never says /__done).
const FIRST_REQUEST_MS = Number(process.env.KESTREL_FIRST_REQUEST_MS) || 60000;
const IDLE_MS = Number(process.env.KESTREL_IDLE_MS) || 30000;

function openInBrowser(url) {
  const plat = process.platform;
  const cmd = plat === 'win32' ? 'cmd' : plat === 'darwin' ? 'open' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** File names the workspace's samples were loaded from (demo samples have none on disk). */
export function sampleFileNames(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return [];
  }
  const samples = (obj && (obj.samples || (obj.doc && obj.doc.samples))) || [];
  const names = [];
  for (const s of samples) {
    if (!s || !s.fileName) continue;
    if (s.source && s.source.type === 'demo') continue;
    if (!names.includes(s.fileName)) names.push(s.fileName);
  }
  return names;
}

/**
 * Find each wanted name in `dir`, then in its immediate subfolders. Names
 * match without regard to case (Windows file names aren't case-sensitive,
 * and a renamed folder copy often changes case). Returns Map(wanted -> path).
 */
export async function findDataFiles(dir, wanted) {
  const found = new Map();
  const want = new Map(wanted.map((n) => [n.toLowerCase(), n]));
  const scan = async (d) => {
    let entries = [];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    const subdirs = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') subdirs.push(path.join(d, e.name));
        continue;
      }
      const key = e.name.toLowerCase();
      if (want.has(key) && !found.has(want.get(key))) found.set(want.get(key), path.join(d, e.name));
    }
    return subdirs;
  };
  const subdirs = await scan(dir);
  for (const sub of subdirs) {
    if (found.size === want.size) break;
    await scan(sub);
  }
  return found;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node open-workspace.mjs <path-to-.kestrel.json>');
    process.exit(1);
  }
  const ok = await stat(target).then((s) => s.isFile(), () => false);
  if (!ok) {
    console.error(`Can't read "${target}".`);
    process.exit(1);
  }
  const [html, workspace] = await Promise.all([readFile(distHtml, 'utf8'), readFile(target)]);
  const fileName = path.basename(target);
  const dir = path.dirname(path.resolve(target));
  const wanted = sampleFileNames(workspace.toString('utf8'));
  const found = await findDataFiles(dir, wanted);
  const missing = wanted.filter((n) => !found.has(n));
  console.log(`Found ${found.size} of ${wanted.length} data file${wanted.length === 1 ? '' : 's'} in ${dir}`);

  let servedWorkspace = false;
  let inFlight = 0;
  let idleTimer = null;
  const quit = (code = 0) => {
    clearTimeout(idleTimer);
    server.close();
    // close() waits for keep-alive sockets; don't let them hold the window open
    setTimeout(() => process.exit(code), 200).unref();
    server.closeAllConnections?.();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (inFlight > 0) return;
    idleTimer = setTimeout(() => quit(servedWorkspace ? 0 : 1), servedWorkspace ? IDLE_MS : FIRST_REQUEST_MS);
  };

  const server = createServer((req, res) => {
    inFlight++;
    clearTimeout(idleTimer);
    res.on('close', () => {
      inFlight--;
      armIdle();
    });
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/__workspace') {
      servedWorkspace = true;
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Kestrel-Filename': encodeURIComponent(fileName), 'Cache-Control': 'no-store' });
      res.end(workspace);
    } else if (p === '/__manifest') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ dir, found: [...found.keys()], missing }));
    } else if (p.startsWith('/__data/')) {
      const name = decodeURIComponent(p.slice('/__data/'.length));
      const file = found.get(name);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      stat(file).then(
        (st) => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
          createReadStream(file).on('error', () => res.destroy()).pipe(res);
        },
        () => {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        },
      );
    } else if (p === '/__done') {
      res.writeHead(204);
      res.end();
      res.on('finish', () => quit(0));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/?openWorkspace=1`;
    console.log(url);
    if (!process.env.KESTREL_NO_OPEN) openInBrowser(url);
    armIdle();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
