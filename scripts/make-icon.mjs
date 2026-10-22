#!/usr/bin/env node
// Builds the Windows file icon (scripts/kestrel.ico) from the app's logo, the
// pencil-sketch kestrel in src/ui/assets/kestrel-mark.js, drawn on a small
// paper-coloured tile so it reads on both light and dark Explorer themes.
// Each size is rendered from the vector logo at that size (not scaled down
// from a large bitmap); the smallest ones drop the pencil grain, which is
// noise at 16-32 pixels, and are drawn darker and larger to stay legible. Also writes docs/images/kestrel-icon.png.
//
// The .ico is committed, so this only needs re-running if the logo changes:
//   node scripts/make-icon.mjs

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KESTREL_SVG, KESTREL_CSS } from '../src/ui/assets/kestrel-mark.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

function page(size) {
  const small = size <= 32;
  const svg = small ? KESTREL_SVG.replace(' filter="url(#k-pencil)"', '') : KESTREL_SVG;
  const pad = Math.max(1, Math.round(size * 0.04));
  const radius = Math.round(size * 0.2);
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: transparent; }
    .tile {
      ${small ? '--k1: #15181b; --k2: #2c3036; --k3: #4b5158; --k4: #737980; --k5: #d6d9dd;' : '--k1: #1b1e22; --k2: #3d424a; --k3: #6a7078; --k4: #a3a8ae; --k5: #e4e6e9;'}
      box-sizing: border-box; width: ${size}px; height: ${size}px; margin: 0;
      border-radius: ${radius}px; background: #f5f1e8;
      border: ${Math.max(1, Math.round(size / 64))}px solid #b9b1a2;
      display: flex; align-items: center; justify-content: center; overflow: hidden;
      padding: ${pad}px;
    }
    .tile svg { width: ${small ? 132 : 118}%; height: auto; flex: none; margin-left: ${small ? -16 : -9}%; margin-top: ${Math.round(size * 0.04)}px; }
    ${KESTREL_CSS}
  </style></head><body><div class="tile">${svg}</div></body></html>`;
}

/** Pack PNGs into a .ico (PNG-compressed entries; Windows Vista and later). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const browser = await chromium.launch();
const images = [];
for (const size of SIZES) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(page(size));
  const png = await p.locator('.tile').screenshot({ omitBackground: true });
  images.push({ size, png });
  await p.close();
}
await browser.close();

await writeFile(path.join(root, 'scripts', 'kestrel.ico'), ico(images));
await writeFile(path.join(root, 'docs', 'images', 'kestrel-icon.png'), images.find((i) => i.size === 256).png);
console.log(`wrote scripts/kestrel.ico (${SIZES.join(', ')} px) and docs/images/kestrel-icon.png`);
