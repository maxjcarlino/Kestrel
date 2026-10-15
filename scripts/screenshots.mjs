// Regenerate the screenshots in docs/images from the built app (needs Playwright).
//   npm run build && node scripts/screenshots.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'docs', 'images');
fs.mkdirSync(out, { recursive: true });
const url = 'file://' + path.join(root, 'dist', 'kestrel.html');

const browser = await chromium.launch();

async function open(colorScheme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('.plot-card', { timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.plot-foot .num')].every((e) => !e.textContent.includes('…')), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  return { ctx, page };
}

async function view(page, tab) {
  await page.click(`.view-tab:has-text("${tab}")`);
  await page.waitForTimeout(1800);
}

{
  const { ctx, page } = await open('light');
  // select a gate so the inspector shows its statistics
  const row = await page.$('.tree-row:has-text("T cells")');
  if (row) await row.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'gating.png') });
  await view(page, 'Compensation');
  await page.screenshot({ path: path.join(out, 'compensation.png') });
  await view(page, 'Statistics');
  await page.waitForFunction(() => ![...document.querySelectorAll('.stats-table td')].some((td) => td.textContent === '…'), null, { timeout: 30000 });
  await page.screenshot({ path: path.join(out, 'statistics.png') });
  await view(page, 'Layout');
  await page.screenshot({ path: path.join(out, 'layout.png') });
  await view(page, 'Gating');
  // axis menu with the scale editor
  const axis = (await page.$$('.axis-x'))[5];
  await axis.scrollIntoViewIfNeeded();
  await axis.click();
  await page.waitForTimeout(500);
  const menu = await (await page.$('.axis-menu')).boundingBox();
  const card = await (await page.$$('.plot-card'))[5].boundingBox();
  const x0 = Math.max(0, Math.min(menu.x, card.x) - 16);
  const y0 = Math.max(0, Math.min(menu.y, card.y) - 16);
  const x1 = Math.min(1440, Math.max(menu.x + menu.width, card.x + card.width) + 16);
  const y1 = Math.min(900, Math.max(menu.y + menu.height, card.y + card.height) + 16);
  await page.screenshot({ path: path.join(out, 'axis-menu.png'), clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  await ctx.close();
}
{
  const { ctx, page } = await open('dark');
  await page.screenshot({ path: path.join(out, 'gating-dark.png') });
  await ctx.close();
}
await browser.close();
for (const f of fs.readdirSync(out)) console.log(`${f}  ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`);
