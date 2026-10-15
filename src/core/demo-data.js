// Simulated PBMC immunophenotyping data for demos and tests.
//
// Events are generated from a physical model: each cell carries true
// fluorochrome amounts; detectors see the spillover-weighted sum plus
// autofluorescence, photon-counting noise and electronic noise. This
// reproduces the spreading error seen after compensation.

import { writeFCS } from './fcs-write.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalGen(rand) {
  let spare = null;
  return function normal() {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u <= 1e-12) u = rand();
    v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export const DEMO_DYES = ['BV421', 'BV510', 'FITC', 'PE', 'PerCP-Cy5.5', 'PE-Cy7', 'APC'];
export const DEMO_DETECTORS = ['BV421-A', 'BV510-A', 'FITC-A', 'PE-A', 'PerCP-Cy5-5-A', 'PE-Cy7-A', 'APC-A'];
export const DEMO_MARKERS = ['CD14', 'Viability', 'CD3', 'CD56', 'CD8', 'CD4', 'CD19'];

// True spillover (rows: dyes, columns: detectors)
export const DEMO_SPILL = [
  [1, 0.22, 0.03, 0.005, 0.002, 0.001, 0],
  [0.03, 1, 0.18, 0.04, 0.01, 0.003, 0.001],
  [0, 0.02, 1, 0.24, 0.06, 0.008, 0.001],
  [0, 0.002, 0.012, 1, 0.16, 0.03, 0.003],
  [0, 0, 0, 0.01, 1, 0.18, 0.06],
  [0, 0, 0, 0.02, 0.04, 1, 0.012],
  [0, 0, 0, 0.002, 0.12, 0.02, 1],
];

// The "acquisition" matrix written into the files is slightly off, as is common.
export const DEMO_SPILL_ACQ = DEMO_SPILL.map((row, i) => row.map((v, j) => {
  if (i === 2 && j === 3) return 0.205;
  if (i === 4 && j === 5) return 0.15;
  if (i === 0 && j === 1) return 0.19;
  return v;
}));

const AUTO = { lymph: [140, 260, 180, 70, 55, 35, 25], mono: [320, 520, 380, 160, 110, 70, 50], gran: [520, 800, 640, 260, 170, 110, 80], dead: [600, 900, 500, 260, 200, 150, 120], debris: [90, 160, 110, 50, 40, 25, 20], bead: [220, 300, 260, 120, 90, 70, 60] };

const DONORS = [
  { name: 'PBMC_Donor01', seed: 101, cd4: 0.63, cd8: 0.28, t: 0.7, b: 0.11, nk: 0.13, dead: 0.05, mono: 0.16 },
  { name: 'PBMC_Donor02', seed: 202, cd4: 0.48, cd8: 0.43, t: 0.62, b: 0.15, nk: 0.17, dead: 0.08, mono: 0.12 },
  { name: 'PBMC_Donor03', seed: 303, cd4: 0.71, cd8: 0.2, t: 0.74, b: 0.09, nk: 0.1, dead: 0.03, mono: 0.21 },
];

const CH = [
  { name: 'FSC-A', label: '', range: 262144, voltage: 380 },
  { name: 'FSC-H', label: '', range: 262144, voltage: 380 },
  { name: 'SSC-A', label: '', range: 262144, voltage: 260 },
  { name: 'SSC-H', label: '', range: 262144, voltage: 260 },
  ...DEMO_DETECTORS.map((d, i) => ({ name: d, label: DEMO_MARKERS[i], range: 262144, voltage: [420, 440, 480, 520, 560, 600, 540][i] })),
  { name: 'Time', label: '', range: 262144 },
];

const MAX = 262143;

class Sim {
  constructor(seed) {
    this.rand = mulberry32(seed);
    this.normal = normalGen(this.rand);
  }
  ln(median, sigma) {
    return median * Math.exp(sigma * this.normal());
  }
  pick(weights) {
    const r = this.rand();
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r < acc) return i;
    }
    return weights.length - 1;
  }
}

/** One cell: [fsc, ssc, dyes[7], autoType] */
function makeCell(sim, type, d) {
  const dyes = new Float64Array(7);
  let fsc;
  let ssc;
  let auto = AUTO.lymph;
  switch (type) {
    case 'debris':
      fsc = Math.min(30000, 2000 + sim.rand() * 16000 + Math.abs(sim.normal()) * 6000);
      ssc = sim.ln(7000, 0.65);
      auto = AUTO.debris;
      if (sim.rand() < 0.3) dyes[1] = sim.ln(9000, 0.8);
      break;
    case 'dead':
      fsc = 40000 + sim.normal() * 9000;
      ssc = sim.ln(30000, 0.32);
      auto = AUTO.dead;
      dyes[1] = sim.ln(42000, 0.35);
      if (sim.rand() < 0.5) dyes[2] = sim.ln(4000, 0.6);
      break;
    case 'gran':
      fsc = 118000 + sim.normal() * 13000;
      ssc = sim.ln(140000, 0.14);
      auto = AUTO.gran;
      dyes[0] = sim.ln(900, 0.5);
      break;
    case 'mono': {
      fsc = 102000 + sim.normal() * 12000;
      ssc = sim.ln(56000, 0.2);
      auto = AUTO.mono;
      const classical = sim.rand() < 0.85;
      dyes[0] = classical ? sim.ln(32000, 0.32) : sim.ln(3500, 0.45);
      dyes[5] = sim.ln(1400, 0.4);
      break;
    }
    default: {
      // lymphocyte subsets
      fsc = 62000 + sim.normal() * 6500;
      ssc = sim.ln(17500, 0.17);
      auto = AUTO.lymph;
      const sub = sim.pick([d.t, d.b, d.nk, 1 - d.t - d.b - d.nk]);
      if (sub === 0) {
        dyes[2] = sim.ln(12500, 0.3);
        const t = sim.pick([d.cd4, d.cd8, 0.025, Math.max(0, 1 - d.cd4 - d.cd8 - 0.025)]);
        if (t === 0) dyes[5] = sim.ln(8500, 0.28);
        else if (t === 1) dyes[4] = sim.ln(26000, 0.3);
        else if (t === 2) {
          dyes[5] = sim.ln(6000, 0.3);
          dyes[4] = sim.ln(14000, 0.35);
        }
        if (sim.rand() < 0.04) dyes[3] = sim.ln(4200, 0.4);
      } else if (sub === 1) {
        dyes[6] = sim.ln(9500, 0.3);
        fsc += 3000;
      } else if (sub === 2) {
        const bright = sim.rand() < 0.1;
        dyes[3] = bright ? sim.ln(32000, 0.25) : sim.ln(6500, 0.35);
        if (sim.rand() < 0.35) dyes[4] = sim.ln(2200, 0.4);
        ssc *= 1.15;
      }
      break;
    }
  }
  return { fsc: Math.max(200, fsc), ssc: Math.max(200, ssc), dyes, auto };
}

function detect(sim, cell, spill, out, k) {
  // Fluorescence
  for (let j = 0; j < 7; j++) {
    let s = cell.auto[j] * Math.exp(0.25 * sim.normal());
    for (let i = 0; i < 7; i++) {
      const a = cell.dyes[i];
      if (a > 0) s += a * spill[i][j];
    }
    const sd = Math.sqrt(45 * 45 + 3.2 * Math.max(0, s));
    let v = s + sd * sim.normal();
    if (v > MAX) v = MAX;
    out[4 + j][k] = v;
  }
}

/** Generate one sample as FCS bytes. */
export function generateSample(kind, opts = {}) {
  const spec = typeof kind === 'string' ? { kind, ...opts } : kind;
  const sim = new Sim(spec.seed || 1);
  const n = spec.events || 50000;
  const cols = CH.map(() => new Float32Array(n));
  const donor = DONORS.find((dd) => dd.name === spec.donor) || DONORS[0];

  if (spec.kind === 'bead') {
    // Single-stain capture beads: one scatter cluster, negative + positive peaks.
    const dye = spec.dye;
    for (let k = 0; k < n; k++) {
      const fsc = 82000 + sim.normal() * 4500;
      const ssc = 31000 * Math.exp(0.07 * sim.normal());
      const dyes = new Float64Array(7);
      const positive = dye >= 0 && sim.rand() < 0.55;
      if (positive) dyes[dye] = sim.ln(dye === 1 ? 52000 : 38000, 0.22);
      const cell = { fsc, ssc, dyes, auto: AUTO.bead };
      scatter(sim, cell, cols, k, false);
      detect(sim, cell, DEMO_SPILL, cols, k);
    }
  } else {
    const d = donor;
    const fr = { debris: 0.07, dead: d.dead, gran: 0.03, mono: d.mono, doublet: 0.04 };
    const lymph = Math.max(0.2, 1 - fr.debris - fr.dead - fr.gran - fr.mono - fr.doublet);
    const types = ['debris', 'dead', 'gran', 'mono', 'doublet', 'lymph'];
    const weights = [fr.debris, fr.dead, fr.gran, fr.mono, fr.doublet, lymph];
    for (let k = 0; k < n; k++) {
      const t = types[sim.pick(weights)];
      if (t === 'doublet') {
        const a = makeCell(sim, sim.rand() < 0.8 ? 'lymph' : 'mono', d);
        const b = makeCell(sim, sim.rand() < 0.85 ? 'lymph' : 'mono', d);
        const dyes = new Float64Array(7);
        for (let i = 0; i < 7; i++) dyes[i] = a.dyes[i] + b.dyes[i];
        const auto = a.auto.map((v, i) => v + b.auto[i]);
        const cell = { fsc: a.fsc + b.fsc, ssc: a.ssc + b.ssc, dyes, auto, hMax: Math.max(a.fsc, b.fsc), sMax: Math.max(a.ssc, b.ssc) };
        scatter(sim, cell, cols, k, true);
        detect(sim, cell, DEMO_SPILL, cols, k);
      } else {
        const cell = makeCell(sim, t, d);
        scatter(sim, cell, cols, k, false);
        detect(sim, cell, DEMO_SPILL, cols, k);
      }
    }
  }

  // Time: steady acquisition with slow drift in rate
  const tcol = cols[CH.length - 1];
  let t = 0;
  const duration = spec.kind === 'bead' ? 1800 : 6200;
  const step = duration / n;
  for (let k = 0; k < n; k++) {
    t += step * (0.6 + 0.8 * sim.rand()) * (1 + 0.15 * Math.sin((k / n) * 6.283));
    tcol[k] = t;
  }

  const keywords = {
    $CYT: 'Kestrel Simulator',
    $CYTSN: 'SIM-0001',
    $DATE: '18-SEP-2026',
    $BTIM: '10:12:00',
    $ETIM: '10:13:04',
    $FIL: `${spec.name}.fcs`,
    $SRC: spec.kind === 'bead' ? 'Compensation' : 'PBMC',
    $TIMESTEP: '0.01',
    'TUBE NAME': spec.name,
    'EXPERIMENT NAME': 'Demo 7-colour PBMC panel',
    'SAMPLE ID': spec.kind === 'bead' ? 'Comp beads' : spec.donor,
    $OP: 'Kestrel demo',
    CREATOR: 'Kestrel demo generator',
  };
  return writeFCS({
    channels: CH,
    columns: cols,
    nEvents: n,
    keywords,
    spillover: { names: DEMO_DETECTORS.slice(), matrix: DEMO_SPILL_ACQ },
  });
}

function scatter(sim, cell, cols, k, doublet) {
  const clip = (v) => (v > MAX ? MAX : v);
  const fscA = cell.fsc * (1 + 0.02 * sim.normal()) + 150 * sim.normal();
  const sscA = cell.ssc * (1 + 0.02 * sim.normal()) + 120 * sim.normal();
  let fscH;
  let sscH;
  if (doublet) {
    fscH = cell.hMax * (1.18 + 0.06 * sim.normal());
    sscH = cell.sMax * (1.2 + 0.07 * sim.normal());
  } else {
    fscH = fscA * (0.84 + 0.025 * sim.normal());
    sscH = sscA * (0.86 + 0.03 * sim.normal());
  }
  cols[0][k] = clip(fscA);
  cols[1][k] = clip(fscH);
  cols[2][k] = clip(sscA);
  cols[3][k] = clip(sscH);
}

/** The full demo experiment: three donors plus single-stain controls. */
export function demoManifest({ donorEvents = 120000, controlEvents = 15000 } = {}) {
  const items = DONORS.map((d) => ({ name: d.name, kind: 'cells', donor: d.name, seed: d.seed, events: donorEvents, group: 'Samples' }));
  items.push({ name: 'Comp_Unstained', kind: 'bead', dye: -1, seed: 900, events: controlEvents, group: 'Compensation' });
  DEMO_DETECTORS.forEach((det, i) => {
    items.push({ name: `Comp_${det}`, kind: 'bead', dye: i, seed: 910 + i, events: controlEvents, group: 'Compensation' });
  });
  return items;
}
