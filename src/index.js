// Kestrel as a library: the analysis core without the user interface.
//
//   import { parseFCS, makeTransform, Engine, runTemplate } from './src/index.js';
//
// Everything here runs in Node and in browsers and has no dependencies.

export { parseFCS, parseSpillover, keywordGetter, classifyChannel, FCSError } from './core/fcs-parse.js';
export { writeFCS, spilloverToString } from './core/fcs-write.js';
export { makeTransform, normalizeSpec, transformKey, TRANSFORM_TYPES, TRANSFORM_LABELS } from './core/transforms.js';
export { Logicle, FastLogicle, estimateLogicleW } from './core/logicle.js';
export { Hyperlog, FastHyperlog } from './core/hyperlog.js';
export { invertMatrix, compensateColumns, matchChannels, spilloverFromMedians } from './core/compensation.js';
export { evaluateGate, orderGates, ancestors, descendants, ROOT } from './core/gates.js';
export { toPolygon, makeQuadrant, makeSplit } from './core/gate-geometry.js';
export { importGatingML, exportGatingML } from './core/gatingml.js';
export { channelStats, populationFrequency, STATS, STAT_ORDER } from './core/stats.js';
export { parseEventTable, toCSV, toTSV } from './core/csv.js';
export { makeZip, listZip } from './core/zip.js';
export { generateSample, demoManifest } from './core/demo-data.js';
export { Engine } from './engine/engine.js';
export { runTemplate, asTemplate, templateColumns } from './engine/batch.js';
