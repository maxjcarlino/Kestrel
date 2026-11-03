import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyDoc } from '../src/ui/state/doc.js';
import { sortSamples, sortableKeywords, sortValue } from '../src/ui/state/sample-sort.js';

function fixture() {
  const doc = emptyDoc('Sort');
  doc.groups = [{ id: 'gS', name: 'Stim' }, { id: 'gU', name: 'Unstim' }];
  const s = (id, name, groupIds, nEvents) => ({ id, name, fileName: `${name}.fcs`, nEvents, channels: [], groupIds });
  doc.samples = [
    s('a', 'Donor 10', ['gU'], 5000),
    s('b', 'donor 2', ['gS'], 20000),
    s('c', 'Donor 1', [], 0),
    s('d', 'Donor 3', ['gS', 'gU'], 12000),
  ];
  const meta = {
    a: { status: 'ready', keywords: { $DATE: '02-OCT-2026', 'TUBE NAME': 'T7', $P1N: 'FSC-A', $TOT: '5000' } },
    b: { status: 'ready', keywords: { $DATE: '15-SEP-2026', 'Tube Name': 'T12', $TOT: '20000' } },
    c: { status: 'missing' },
    d: { status: 'ready', keywords: { $DATE: '01-JAN-2027', 'TUBE NAME': 'T1', $TOT: '12000', 'WELL ID': 'B2' } },
  };
  return { doc, meta };
}
const ids = (list) => list.map((x) => x.id).join('');

test('sorts by name naturally (Donor 2 before Donor 10), case ignored, either direction', () => {
  const { doc, meta } = fixture();
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'name' })), 'cbda');
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'name', desc: true })), 'adbc');
});

test('file order is the default and keeps the order samples were added', () => {
  const { doc, meta } = fixture();
  assert.equal(ids(sortSamples(doc, meta, doc.samples)), 'abcd');
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'file', desc: true })), 'dcba');
});

test('sorts by group in the order groups were made, by name within one, ungrouped last', () => {
  const { doc, meta } = fixture();
  // Stim: donor 2, Donor 3 (first group of d) — Unstim: Donor 10 — none: Donor 1
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'group' })), 'bdac');
  // descending flips the groups; samples with no group stay last
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'group', desc: true })).slice(-1), 'c');
});

test('sorts by event count; samples not loaded go last', () => {
  const { doc, meta } = fixture();
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'events' })), 'adbc');
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'events', desc: true })), 'bdac');
});

test('sorts by a keyword: dates as dates, numbers as numbers, names naturally, any key case; missing last', () => {
  const { doc, meta } = fixture();
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'kw', key: '$DATE' })), 'badc');
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'kw', key: '$DATE', desc: true })), 'dabc');
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'kw', key: '$TOT' })), 'adbc');
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'kw', key: 'TUBE NAME' })), 'dabc', 'T1, T7, T12; matched regardless of key case');
  assert.equal(ids(sortSamples(doc, meta, doc.samples, { by: 'kw', key: 'WELL ID' })), 'dabc', 'only d has it; the rest keep file order after it');
  assert.equal(sortValue(doc, meta, doc.samples[1], { by: 'kw', key: 'TUBE NAME' }), 'T12');
  assert.equal(sortValue(doc, meta, doc.samples[2], { by: 'kw', key: 'TUBE NAME' }), null);
});

test('offers the useful keywords, familiar ones first, not per-parameter ones', () => {
  const { doc, meta } = fixture();
  const kws = sortableKeywords(doc, meta);
  assert.equal(kws[0], '$DATE');
  assert.ok(kws.includes('TUBE NAME') && kws.includes('WELL ID') && kws.includes('$TOT'));
  assert.ok(!kws.some((k) => /^\$P\d/.test(k)));
  assert.equal(kws.filter((k) => k.toUpperCase() === 'TUBE NAME').length, 1, 'one entry per keyword whatever its case');
});
