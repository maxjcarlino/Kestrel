// Write the simulated demo experiment as FCS 3.1 files (for trying Kestrel or other software).
//   node scripts/make-demo-fcs.mjs [output-folder]
import fs from 'node:fs';
import path from 'node:path';
import { generateSample, demoManifest } from '../src/core/demo-data.js';

const dir = path.resolve(process.argv[2] || 'demo-data');
fs.mkdirSync(dir, { recursive: true });
for (const item of demoManifest()) {
  const bytes = generateSample(item);
  fs.writeFileSync(path.join(dir, `${item.name}.fcs`), bytes);
  console.log(`${item.name}.fcs  ${item.events.toLocaleString()} events  ${(bytes.length / 1e6).toFixed(1)} MB`);
}
console.log(`\nWrote ${demoManifest().length} files to ${dir}`);
