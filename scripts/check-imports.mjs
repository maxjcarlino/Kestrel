// Report imported names that are never used in the importing file.
import fs from 'node:fs';
import path from 'node:path';
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(js|jsx|mjs)$/.test(f)) files.push(p); } };
walk('src');
let n = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const body = src.replace(/^import[\s\S]*?;$/gm, '');
  const re = /^import\s+(?:\{([\s\S]*?)\}|(\w+))\s+from/gm;
  let m;
  while ((m = re.exec(src))) {
    const names = m[1] ? m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean) : [m[2]];
    for (const name of names) {
      const used = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(body);
      if (!used) { console.log(`${f}: ${name}`); n++; }
    }
  }
}
console.log(n ? `${n} unused imports` : 'no unused imports');
