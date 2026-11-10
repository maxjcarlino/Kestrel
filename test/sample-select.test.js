import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyDoc } from '../src/ui/state/doc.js';
import { resolveSamples, selectionLabel, moveId } from '../src/ui/state/sample-select.js';

function fixture() {
  const doc = emptyDoc('Sel');
  doc.groups = [{ id: 'g1', name: 'Stim' }];
  const s = (id, name, groupIds = []) => ({ id, name, fileName: `${name}.fcs`, nEvents: 100, channels: [], groupIds });
  doc.samples = [s('a', 'Donor 10', ['g1']), s('b', 'Donor 2'), s('c', 'Donor 1', ['g1'])];
  return { doc, meta: {} };
}
const ids = (l) => l.map((x) => x.id).join('');

test('all samples or a group follow the sample list\'s order', () => {
  const { doc, meta } = fixture();
  assert.equal(ids(resolveSamples(doc, meta, {})), 'abc');
  assert.equal(ids(resolveSamples(doc, meta, { groupId: 'g1' })), 'ac');
  doc.settings = { ...doc.settings, sampleSort: { by: 'name' } };
  assert.equal(ids(resolveSamples(doc, meta, {})), 'cba', 'sorting the sample list re-orders the figure');
  assert.equal(ids(resolveSamples(doc, meta, { groupId: 'g1' })), 'ca');
});

test('hand-picked samples show exactly those, in the order given; removed samples drop out', () => {
  const { doc, meta } = fixture();
  assert.equal(ids(resolveSamples(doc, meta, { ids: ['c', 'a'] })), 'ca');
  assert.equal(ids(resolveSamples(doc, meta, { ids: ['c', 'gone', 'a', 'c'] })), 'ca');
  assert.equal(ids(resolveSamples(doc, meta, { ids: [] })), '', 'an empty choice shows nothing (not everything)');
  assert.equal(selectionLabel(doc, { ids: ['c', 'gone'] }), '1 chosen sample');
  assert.equal(selectionLabel(doc, { groupId: 'g1' }), 'Stim');
  assert.equal(selectionLabel(doc, {}), 'All samples');
});

test('moving a sample in the order', () => {
  assert.deepEqual(moveId(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'x', 0), ['a', 'b', 'c']);
});
