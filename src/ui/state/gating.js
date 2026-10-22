// Gating actions used by plots, the population tree and menus.

import { store } from './store.js';
import {
  addGates, addPlot, setUI, toast, deleteGate, newGateBase, defaultGateName, patchGate, convertToPolygon,
  clearOverride, makeOverride, applyOverrideToAll, hasOverride, undo, effectiveGate, useDisplayScale,
} from './doc.js';
import { suggestAxes, gatesForPlot, channelShort, popPath, allChannels, effectiveComp } from './derived.js';
import { makeQuadrant, makeSplit, quadrantNames, GATE_COLORS, canConvertToPolygon, nextColor } from '../../core/gate-geometry.js';
import { descendants, ROOT } from '../../core/gates.js';
import { request } from './bridge.js';
import { saveFile, safeName } from '../util/download.js';
import { openDialog } from '../components/ui.jsx';

const S = () => store.get();

/** Create a gate from drawn geometry on a plot. */
export function createGate(plot, type, geom) {
  const doc = S().doc;
  const base = newGateBase(doc, { parent: plot.pop, x: plot.x, y: plot.y, type, name: defaultGateName(doc) });
  if (type === 'range') {
    base.name = `${channelShort(doc, plot.x)}+`;
    base.y = null;
  }
  const g = { ...base, ...geom };
  addGates([g]);
  setUI({ editingName: { gateId: g.id, plotId: plot.id }, tool: 'select' });
  return g.id;
}

export function createQuadrant(plot, center) {
  const doc = S().doc;
  const names = quadrantNames(channelShort(doc, plot.x), channelShort(doc, plot.y));
  const start = GATE_COLORS.indexOf(nextColor(doc.gates));
  const colors = [0, 1, 2, 3].map((i) => GATE_COLORS[(Math.max(0, start) + i) % GATE_COLORS.length]);
  const gates = makeQuadrant({ parent: plot.pop, x: plot.x, y: plot.y, center, names, colors });
  addGates(gates);
  setUI({ tool: 'select', selectedGate: gates[1].id });
}

export function createSplit(plot, threshold) {
  const doc = S().doc;
  const label = channelShort(doc, plot.x);
  const start = GATE_COLORS.indexOf(nextColor(doc.gates));
  const colors = [0, 1].map((i) => GATE_COLORS[(Math.max(0, start) + i) % GATE_COLORS.length]);
  const gates = makeSplit({ parent: plot.pop, x: plot.x, threshold, names: [`${label}−`, `${label}+`], colors });
  addGates(gates);
  setUI({ tool: 'select', selectedGate: gates[1].id });
}

/** Open a plot of a population (or bring an existing one into view). */
export function drillDown(gateId) {
  const doc = S().doc;
  if (!doc.gates[gateId]) return;
  const existing = doc.plots.find((p) => p.pop === gateId);
  if (existing) {
    setUI({ focusPlot: existing.id, flashPlot: existing.id, selectedGate: gateId, view: 'gating' });
    return;
  }
  const [x, y] = suggestAxes(doc, gateId);
  if (!x) {
    toast('Load a data file first.', { kind: 'warn' });
    return;
  }
  const host = doc.plots.find((p) => gatesForPlot(doc, p).some((g) => g.id === gateId));
  addPlot({ pop: gateId, x, y, type: y ? 'pseudo' : 'hist' }, { after: host ? host.id : doc.plots.length ? doc.plots[doc.plots.length - 1].id : null });
  setUI({ selectedGate: gateId, view: 'gating' });
}

export function removeGate(id) {
  const doc = S().doc;
  const g = doc.gates[id];
  if (!g) return;
  const n = deleteGate(id);
  toast(n > 1 ? `Deleted "${g.name}" and ${n - 1} dependent gate${n > 2 ? 's' : ''}` : `Deleted "${g.name}"`, {
    action: { label: 'Undo', onClick: () => undo() },
  });
}

export function convertGate(id) {
  const doc = S().doc;
  const g = doc.gates[id];
  if (!canConvertToPolygon(g)) return;
  const wasQuad = g.link && g.link.kind === 'quad';
  convertToPolygon(id, S().ui.sampleId);
  toast(wasQuad ? `"${g.name}" is now a polygon and moves independently of the other quadrants.` : `"${g.name}" is now a polygon. Drag its corners to reshape it.`);
}

/** Items for the gate context menu (plots and population tree). */
export function gateMenuItems(id) {
  const s = S();
  const doc = s.doc;
  const g = doc.gates[id];
  if (!g) return [];
  const sampleId = s.ui.sampleId;
  const own = hasOverride(doc, sampleId, id);
  const sampleName = (doc.samples.find((x) => x.id === sampleId) || {}).name || 'this sample';
  const isQuad = g.link && g.link.kind === 'quad';
  const convertible = canConvertToPolygon(g);
  return [
    { label: 'Drill down', icon: 'drill', hint: 'Double-click', onClick: () => drillDown(id) },
    { label: 'Rename', icon: 'pencil', onClick: () => setUI({ editingName: { gateId: id, plotId: null, tree: true } }) },
    {
      label: isQuad ? 'Convert quadrant to polygon' : 'Convert to polygon',
      icon: 'convert',
      disabled: !convertible,
      why: g.type === 'polygon' ? 'Already a polygon' : 'Only rectangle, ellipse and quadrant gates can be converted',
      onClick: () => convertGate(id),
    },
    g.scale ? { label: 'Evaluate on the plot’s current scale', icon: 'sliders', onClick: () => useDisplayScale(id) } : null,
    { swatches: GATE_COLORS, value: g.color, onPick: (c) => patchGate(id, { color: c }) },
    { divider: true },
    own
      ? { label: `Use the shared gate for ${sampleName}`, icon: 'link', onClick: () => clearOverride(id, sampleId) }
      : { label: `Adjust for ${sampleName} only`, icon: 'sliders', disabled: !sampleId || g.type === 'boolean', onClick: () => makeOverride(id, sampleId) },
    own ? { label: `Apply ${sampleName}'s version to all samples`, icon: 'copy', onClick: () => applyOverrideToAll(id, sampleId) } : null,
    {
      label: `Apply ${sampleName}'s version to other samples…`,
      icon: 'copy',
      disabled: !sampleId || doc.samples.length < 2 || g.type === 'boolean',
      why: g.type === 'boolean' ? 'Boolean gates follow their referenced populations' : doc.samples.length < 2 ? 'No other samples in this workspace' : undefined,
      onClick: () => openDialog('applyGate', { gateId: id, sourceSampleId: sampleId }),
    },
    { label: 'New boolean gate…', icon: 'gates', onClick: () => openDialog('boolean', { parent: g.parent || ROOT, seed: id }) },
    {
      label: 'Export events',
      icon: 'download',
      submenu: [
        { label: `FCS file (${sampleName})`, onClick: () => exportPopulation(sampleId, id, 'fcs') },
        { label: `CSV table (${sampleName})`, onClick: () => exportPopulation(sampleId, id, 'csv') },
        { label: 'FCS files for all samples (.zip)', onClick: () => exportPopulationAll(id) },
      ],
    },
    { divider: true },
    { label: 'Delete gate', icon: 'trash', danger: true, hint: 'Del', onClick: () => removeGate(id) },
  ];
}

export async function exportPopulation(sampleId, popId, format) {
  const s = S();
  const smp = s.doc.samples.find((x) => x.id === sampleId);
  if (!smp) return;
  const path = popPath(s.doc, popId);
  const base = safeName(`${smp.name} - ${popId === ROOT ? 'All events' : s.doc.gates[popId].name}`);
  try {
    if (format === 'csv') {
      const r = await request(sampleId, 'exportCSV', { pop: popId, header: 'both' });
      const res = await saveFile(`${base}.csv`, r.buffer);
      report(res, `${r.n.toLocaleString()} events exported`);
    } else {
      const comp = effectiveComp(store.get(), sampleId);
      const spill = comp ? { names: comp.names, matrix: comp.matrix } : null;
      const r = await request(sampleId, 'exportFCS', { pop: popId, spillover: spill, extra: { KESTREL_POPULATION: path, $FIL: `${base}.fcs` } });
      const res = await saveFile(`${base}.fcs`, r.buffer);
      report(res, `${r.n.toLocaleString()} events exported`);
    }
  } catch (e) {
    toast(`Export failed: ${e.message}`, { kind: 'error' });
  }
}

export async function exportPopulationAll(popId) {
  const s = S();
  const { makeZip } = await import('../../core/zip.js');
  const files = [];
  const name = popId === ROOT ? 'All events' : s.doc.gates[popId].name;
  const path = popPath(s.doc, popId);
  for (const smp of s.doc.samples) {
    if ((s.meta[smp.id] || {}).status !== 'ready') continue;
    try {
      const comp = effectiveComp(store.get(), smp.id);
      const r = await request(smp.id, 'exportFCS', { pop: popId, spillover: comp ? { names: comp.names, matrix: comp.matrix } : null, extra: { KESTREL_POPULATION: path } });
      files.push({ name: safeName(`${smp.name} - ${name}`) + '.fcs', data: new Uint8Array(r.buffer) });
    } catch (e) {
      /* skip */
    }
  }
  if (!files.length) return toast('No loaded samples to export.', { kind: 'warn' });
  const res = await saveFile(safeName(`${name} - ${files.length} samples`) + '.zip', makeZip(files));
  report(res, `${files.length} FCS files exported`);
}

export function report(res, okMessage) {
  if (res.ok) {
    toast(res.wrapped ? `${okMessage} (packaged as .zip so it can be saved here)` : okMessage);
  } else if (res.code !== 'declined') {
    toast(`Could not save the file: ${res.message || res.code}`, { kind: 'error' });
  }
}

/** Gates on the current sample that are adjusted relative to the shared template. */
export function overriddenSet(doc, sampleId) {
  return new Set(Object.keys((sampleId && doc.overrides[sampleId]) || {}));
}

export { effectiveGate, descendants, allChannels };
