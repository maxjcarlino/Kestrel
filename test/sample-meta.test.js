import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyDoc, sampleKeywords, lookupKeyword } from '../src/ui/state/doc.js';
import { matchSheet, pasteBlock, findSample } from '../src/ui/state/sample-meta.js';
import { parseTable } from '../src/core/csv.js';
import { sortSamples, sortableKeywords } from '../src/ui/state/sample-sort.js';

function fixture() {
  const doc = emptyDoc('Meta');
  const s = (id, name, fileName) => ({ id, name, fileName, nEvents: 100, channels: [], groupIds: [] });
  doc.samples = [s('a', 'Donor01 stim', 'D01_stim.fcs'), s('b', 'Donor01 unstim', 'D01_unstim.fcs'), s('c', 'Donor02 stim', 'D02_stim.FCS')];
  const meta = { a: { keywords: { 'TUBE NAME': 'T1', $DATE: '01-JAN-2026' } }, b: { keywords: { 'TUBE NAME': 'T2' } }, c: { keywords: {} } };
  return { doc, meta };
}

test('your columns sit over the file keywords: a value wins, a blank shows the file through', () => {
  const { doc, meta } = fixture();
  doc.metaFields = ['Treatment', 'Tube name'];
  doc.sampleMeta = { a: { Treatment: 'Stim', 'Tube name': 'tube A' }, b: { Treatment: 'Unstim', 'Tube name': '' } };
  assert.equal(lookupKeyword(doc, meta, 'a', 'treatment'), 'Stim', 'matched regardless of case');
  assert.equal(lookupKeyword(doc, meta, 'a', 'TUBE NAME'), 'tube A', 'your value replaces the keyword of the same name');
  assert.equal(lookupKeyword(doc, meta, 'b', 'TUBE NAME'), 'T2', 'a blank lets the file value through');
  assert.equal(lookupKeyword(doc, meta, 'c', 'Treatment'), undefined);
  assert.equal(Object.keys(sampleKeywords(doc, meta, 'a')).filter((k) => k.toUpperCase() === 'TUBE NAME').length, 1);
  // sorting and the keyword lists see them, first
  assert.deepEqual(sortSamples(doc, meta, doc.samples, { by: 'kw', key: 'Treatment' }).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(sortableKeywords(doc, meta).slice(0, 2), ['Treatment', 'Tube name']);
});

test('parses CSV, TSV and semicolon sheets, with quotes', () => {
  assert.deepEqual(parseTable('a,b\n1,"x, y"\n'), [['a', 'b'], ['1', 'x, y']]);
  assert.deepEqual(parseTable('a\tb\r\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseTable('a;b\n"say ""hi""";2\n'), [['a', 'b'], ['say "hi"', '2']]);
});

test('a sheet is matched to samples by name or file name, with or without the extension', () => {
  const { doc } = fixture();
  assert.equal(findSample(doc, 'd02_stim').id, 'c');
  assert.equal(findSample(doc, 'Donor01 Unstim').id, 'b');
  const r = matchSheet(doc, parseTable('File,Treatment,Donor\nD01_stim.fcs,Stim,1\nD02_stim,Stim,2\nmystery.fcs,?,9\n'));
  assert.equal(r.keyHeader, 'File');
  assert.deepEqual(r.fields, ['Treatment', 'Donor']);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.unmatched, ['mystery.fcs']);
  assert.deepEqual(r.entries.filter((e) => e[0] === 'c'), [['c', 'Treatment', 'Stim'], ['c', 'Donor', '2']]);
  // no recognisable header: the first column that names samples is the key
  const r2 = matchSheet(doc, parseTable('Tube,Dose\nDonor02 stim,10\n'));
  assert.equal(r2.keyHeader, 'Tube');
  assert.equal(r2.matched, 1);
  assert.equal(matchSheet(doc, parseTable('x,y\n1,2\n')).keyHeader, null);
});

test('a pasted block fills down and across from the cell, adding columns it runs past', () => {
  const { entries, newFields } = pasteBlock(parseTable('Stim\t1\nUnstim\t2\n'), ['a', 'b', 'c'], ['Treatment'], 1, 0);
  assert.deepEqual(newFields, ['Column 2']);
  assert.deepEqual(entries, [['b', 'Treatment', 'Stim'], ['b', 'Column 2', '1'], ['c', 'Treatment', 'Unstim'], ['c', 'Column 2', '2']]);
  // rows past the last sample are ignored
  assert.equal(pasteBlock(parseTable('x\ny\nz\n'), ['a', 'b'], ['F'], 1, 0).entries.length, 1);
});
