#!/usr/bin/env node
// Apply a Kestrel workflow template to FCS (or CSV) files and write the
// statistics table as CSV, without opening the app.
//
//   node scripts/kestrel-batch.mjs --template panel.template.json data/*.fcs > stats.csv
//   node scripts/kestrel-batch.mjs -t workspace.kestrel.json -o stats.csv data/
//
// Options
//   -t, --template FILE   template (.template.json) or workspace (.kestrel.json)
//   -o, --out FILE        write CSV here instead of standard output
//       --tsv             tab-separated output
//   -q, --quiet           no progress messages
//
// Directories are searched (not recursively) for .fcs, .lmd and .csv files.

import fs from 'node:fs';
import path from 'node:path';
import { runTemplate } from '../src/engine/batch.js';
import { toCSV, toTSV } from '../src/core/csv.js';

function usage(msg) {
  if (msg) console.error(`kestrel-batch: ${msg}\n`);
  console.error('usage: kestrel-batch --template FILE [--out FILE] [--tsv] FILES_OR_DIRS...');
  process.exit(msg ? 2 : 0);
}

const args = process.argv.slice(2);
let tpl = null;
let out = null;
let tsv = false;
let quiet = false;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-t' || a === '--template') tpl = args[++i];
  else if (a === '-o' || a === '--out') out = args[++i];
  else if (a === '--tsv') tsv = true;
  else if (a === '-q' || a === '--quiet') quiet = true;
  else if (a === '-h' || a === '--help') usage();
  else if (a.startsWith('-')) usage(`unknown option ${a}`);
  else inputs.push(a);
}
if (!tpl) usage('a template is required (--template FILE)');
if (!inputs.length) usage('no data files given');

const files = [];
for (const p of inputs) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) usage(`not found: ${p}`);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p).sort()) if (/\.(fcs|lmd|csv)$/i.test(f)) files.push(path.join(p, f));
  } else files.push(p);
}
if (!files.length) usage('no .fcs, .lmd or .csv files found');

let template;
try {
  template = JSON.parse(fs.readFileSync(tpl, 'utf8'));
} catch (e) {
  usage(`could not read ${tpl}: ${e.message}`);
}

const t0 = Date.now();
const res = runTemplate(
  template,
  files.map((f) => {
    const b = fs.readFileSync(f);
    return { name: path.basename(f), buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
  }),
  { onFile: (name, i, n) => !quiet && process.stderr.write(`[${i + 1}/${n}] ${name}\n`) },
);
const text = (tsv ? toTSV : toCSV)([res.header, ...res.rows]);
if (out) fs.writeFileSync(out, text);
else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
if (!quiet) {
  for (const w of res.warnings) process.stderr.write(`note: ${w}\n`);
  process.stderr.write(`${res.rows.length} file${res.rows.length === 1 ? '' : 's'}, ${res.header.length - 1} column${res.header.length === 2 ? '' : 's'} in ${((Date.now() - t0) / 1000).toFixed(1)} s${out ? ` → ${out}` : ''}\n`);
}
