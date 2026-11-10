// Which samples a Batch grid or Layout figure shows, and in what order.
//
// A selection is { groupId, ids }:
//   ids: null       every sample, or those in group `groupId`, in the sample
//                   list's order (so sorting the list re-orders the figure)
//   ids: [...]      exactly these samples, in this order (picked by hand)

import { samplesInGroup } from './doc.js';
import { sortSamples, sortLabel, currentSort } from './sample-sort.js';

/** The samples a selection shows, in order (loaded or not). */
export function resolveSamples(doc, meta, sel = {}) {
  if (Array.isArray(sel.ids)) {
    const byId = new Map(doc.samples.map((s) => [s.id, s]));
    const seen = new Set();
    return sel.ids.map((id) => byId.get(id)).filter((s) => s && !seen.has(s.id) && seen.add(s.id));
  }
  return sortSamples(doc, meta, samplesInGroup(doc, sel.groupId || null));
}

/** Short description of a selection, for the button that opens the chooser. */
export function selectionLabel(doc, sel = {}) {
  if (Array.isArray(sel.ids)) {
    const n = sel.ids.filter((id) => doc.samples.some((s) => s.id === id)).length;
    return `${n} chosen sample${n === 1 ? '' : 's'}`;
  }
  const g = sel.groupId && doc.groups.find((x) => x.id === sel.groupId);
  return g ? g.name : 'All samples';
}

/** How a group/all selection is ordered (it follows the sample list). */
export function orderNote(doc) {
  const sort = currentSort(doc);
  return sort.by === 'file' && !sort.desc ? 'in the order they were added' : `sorted by ${sortLabel(sort)}${sort.desc ? ', descending' : ''}, like the sample list`;
}

/** Move an id within a list (to index `to`, clamped). */
export function moveId(ids, id, to) {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const out = ids.slice();
  out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, id);
  return out;
}
