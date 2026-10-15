// Gating template for the simulated PBMC demo. It doubles as an example of a
// complete workflow template (see examples/ in the repository).

import { newId, makeQuadrant, quadrantNames, GATE_COLORS } from '../../core/gate-geometry.js';
import { ROOT } from '../../core/gates.js';
import { DEFAULT_SETTINGS } from './doc.js';

export function buildDemoTemplate(doc) {
  const C = GATE_COLORS;
  const g = (name, parent, type, x, y, geom, color) => ({ id: newId('g'), name, parent, type, x, y, color, ...geom });
  const cells = g('Cells', ROOT, 'polygon', 'FSC-A', 'SSC-A', {
    polygon: [[34000, 3500], [178000, 3500], [236000, 118000], [236000, 236000], [118000, 236000], [34000, 64000]],
  }, C[0]);
  const singlets = g('Singlets', cells.id, 'polygon', 'FSC-A', 'FSC-H', {
    polygon: [[20000, 14000], [250000, 182000], [250000, 238000], [20000, 19500]],
  }, C[1]);
  const live = g('Live', singlets.id, 'rect', 'BV510-A', 'SSC-A', { rect: { x0: null, x1: 4200, y0: null, y1: null } }, C[2]);
  const lymph = g('Lymphocytes', live.id, 'polygon', 'FSC-A', 'SSC-A', {
    polygon: [[43000, 7800], [86000, 8500], [93000, 29000], [74000, 36000], [47000, 31000]],
  }, C[3]);
  const mono = g('Monocytes', live.id, 'rect', 'BV421-A', 'SSC-A', { rect: { x0: 6000, x1: null, y0: 26000, y1: 125000 } }, C[4]);
  const tcells = g('T cells', lymph.id, 'rect', 'FITC-A', 'APC-A', { rect: { x0: 2200, x1: null, y0: null, y1: 1100 } }, C[5]);
  const bcells = g('B cells', lymph.id, 'rect', 'FITC-A', 'APC-A', { rect: { x0: null, x1: 1300, y0: 1700, y1: null } }, C[6]);
  const nonTB = g('Non-T/B', lymph.id, 'rect', 'FITC-A', 'APC-A', { rect: { x0: null, x1: 1300, y0: null, y1: 1100 } }, C[7]);
  const quads = makeQuadrant({
    parent: tcells.id,
    x: 'PE-Cy7-A',
    y: 'PerCP-Cy5-5-A',
    center: [2200, 3200],
    names: quadrantNames('CD4', 'CD8'),
    colors: [C[8], C[9], C[10], C[11]],
  });
  const nk = g('NK cells', nonTB.id, 'range', 'PE-A', null, { range: { lo: 2000, hi: null } }, C[1]);

  const gates = [cells, singlets, live, lymph, mono, tcells, bcells, nonTB, ...quads, nk];
  const byName = (n) => gates.find((x) => x.name === n);
  const p = (pop, x, y, type = 'pseudo', extra = {}) => ({ id: newId('p'), pop, x, y, type, overlay: 'none', ...extra });
  const plots = [
    p(ROOT, 'FSC-A', 'SSC-A'),
    p(cells.id, 'FSC-A', 'FSC-H'),
    p(singlets.id, 'BV510-A', 'SSC-A'),
    p(live.id, 'FSC-A', 'SSC-A'),
    p(live.id, 'BV421-A', 'SSC-A'),
    p(lymph.id, 'FITC-A', 'APC-A'),
    p(tcells.id, 'PE-Cy7-A', 'PerCP-Cy5-5-A'),
    p(nonTB.id, 'PE-A', null, 'hist'),
  ];

  const col = (pop, stat, channel = null, arg = undefined) => ({ id: newId('c'), kind: 'stat', pop, stat, channel, ...(arg !== undefined ? { arg } : {}) });
  const cd4 = byName('CD4+ CD8−');
  const cd8 = byName('CD4− CD8+');
  const columns = [
    col(lymph.id, 'count'),
    col(live.id, 'freqParent'),
    col(lymph.id, 'freqParent'),
    col(mono.id, 'freqParent'),
    col(tcells.id, 'freqParent'),
    col(bcells.id, 'freqParent'),
    col(nk.id, 'freqGrandparent'),
    col(cd4.id, 'freqParent'),
    col(cd8.id, 'freqParent'),
    col(cd4.id, 'median', 'PE-Cy7-A'),
    col(cd8.id, 'median', 'PerCP-Cy5-5-A'),
  ];

  const sampleGroup = doc.groups.find((x) => x.name === 'Samples');
  const donors = doc.samples.filter((s) => sampleGroup && (s.groupIds || []).includes(sampleGroup.id));
  const overlays = [
    {
      id: newId('o'),
      title: 'CD4 on T cells',
      channel: 'PE-Cy7-A',
      pop: tcells.id,
      sampleIds: donors.map((s) => s.id),
      mode: 'offset',
      normalize: 'mode',
    },
  ];

  return {
    gates: Object.fromEntries(gates.map((x) => [x.id, x])),
    gateOrder: gates.map((x) => x.id),
    plots,
    table: { columns, groupId: sampleGroup ? sampleGroup.id : null },
    layout: { plotIds: [plots[5].id, plots[6].id, plots[7].id], groupId: sampleGroup ? sampleGroup.id : null, size: 220, transpose: false, overlays },
    settings: { ...DEFAULT_SETTINGS },
    transforms: {},
    comp: { matrices: [], default: 'file', perSample: {} },
  };
}
