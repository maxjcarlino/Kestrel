// Build Kestrel into single self-contained HTML files.
//
//   node scripts/build.mjs            -> dist/kestrel.html (standalone page)
//                                        dist/artifact.html (body-only variant for hosts
//                                        that supply their own <html>/<head>)
//   node scripts/build.mjs --minify   -> minified output
//   node scripts/build.mjs --watch    -> rebuild on change
//
// The worker bundle is embedded as a string and started from a Blob URL, so the
// output works from file://, any static host, or an embedded frame.

import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const minify = args.has('--minify');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

const TITLE = 'Kestrel Cytometry';
const DESCRIPTION = 'Free, open-source flow cytometry analysis that runs in the browser: FCS files, compensation, Logicle scaling, hierarchical gating, statistics and reusable workflow templates.';
const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@1&display=swap">';

function safeInline(js) {
  return js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

async function build() {
  const t0 = Date.now();
  const common = { bundle: true, format: 'iife', write: false, minify, target: ['es2020', 'chrome90', 'firefox90', 'safari15'], legalComments: 'none', logLevel: 'warning' };
  const worker = await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/engine/worker-entry.js')] });
  const workerCode = worker.outputFiles[0].text;
  const app = await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/ui/main.jsx')],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { __WORKER_SOURCE__: JSON.stringify(workerCode), __APP_VERSION__: JSON.stringify(pkg.version), __APP_HOMEPAGE__: JSON.stringify(pkg.homepage || '') },
  });
  const js = safeInline(app.outputFiles[0].text);
  const css = await fs.readFile(path.join(root, 'src/ui/styles.css'), 'utf8');
  const banner = `<!-- ${TITLE} ${pkg.version} · free and open source under the MIT licence${pkg.homepage ? ` · ${pkg.homepage}` : ''} -->`;
  const body = `<div id="app"></div>\n<script>\n${js}\n</script>\n`;
  const standalone =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n` +
    `<title>${TITLE}</title>\n<meta name="description" content="${DESCRIPTION}">\n${FONTS}\n<style>\n${css}\n</style>\n</head>\n<body>\n${banner}\n${body}</body>\n</html>\n`;
  const artifact =
    `<title>${TITLE}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<meta name="description" content="${DESCRIPTION}">\n` +
    `${FONTS}\n<style>\n${css}\n</style>\n${banner}\n${body}`;
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/kestrel.html'), standalone);
  await fs.writeFile(path.join(root, 'dist/artifact.html'), artifact);
  const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;
  console.log(`built dist/kestrel.html (${kb(standalone)}) and dist/artifact.html in ${Date.now() - t0} ms`);
}

await build();

if (args.has('--watch')) {
  let timer = null;
  fsWatch(path.join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e.message)), 120);
  });
  console.log('watching src/ for changes…');
}
