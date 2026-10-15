// Workspace-level commands: files, templates, Gating-ML.

import { store } from './store.js';
import { updateDoc, toast, addMatrix, setUI, RATIO_SPEC } from './doc.js';
import { makeTemplate, workspaceFile, applyTemplate, openWorkspaceDoc, migrateTemplate, legacyFormat } from './loader.js';
import { effectiveComp } from './derived.js';
import { saveNow } from './persist.js';
import { saveFile, safeName, pickFiles } from '../util/download.js';
import { report } from './gating.js';
import { exportGatingML, importGatingML } from '../../core/gatingml.js';
import { orderGates } from '../../core/gates.js';
import { normalizeSpec } from '../../core/transforms.js';
import { APP } from './doc.js';

const S = () => store.get();

export async function saveWorkspaceFile() {
  await saveNow();
  const doc = S().doc;
  const json = JSON.stringify(workspaceFile(doc), null, 2);
  report(await saveFile(`${safeName(doc.name)}.kestrel.json`, json), 'Workspace file saved');
}

export async function saveTemplateFile() {
  const doc = S().doc;
  const tpl = makeTemplate(doc);
  report(await saveFile(`${safeName(doc.name)}.template.json`, JSON.stringify(tpl, null, 2)), 'Template saved');
}

async function readJsonFile(accept = '.json,application/json') {
  const [file] = await pickFiles({ accept, multiple: false });
  if (!file) return null;
  const text = await file.text();
  try {
    return { name: file.name, data: legacyFormat(JSON.parse(text)) };
  } catch (e) {
    throw new Error(`${file.name} is not valid JSON.`);
  }
}

export async function importWorkspaceFile() {
  try {
    const f = await readJsonFile();
    if (!f) return;
    if (f.data && f.data.format === 'kestrel-template') {
      applyTemplate(f.data);
      toast(`Applied template from ${f.name}`);
      return;
    }
    await saveNow();
    const { missing } = await openWorkspaceDoc(f.data, { fromLibrary: false });
    if (missing.length) toast(`Opened "${S().doc.name}". Add its ${missing.length} data file${missing.length > 1 ? 's' : ''} from the Samples panel to see the data.`, { timeout: 9000 });
    else toast(`Opened "${S().doc.name}"`);
  } catch (e) {
    toast(e.message, { kind: 'error', timeout: 8000 });
  }
}

export async function applyTemplateFile() {
  try {
    const f = await readJsonFile();
    if (!f) return;
    migrateTemplate(f.data);
    applyTemplate(f.data);
    toast(`Applied template "${f.data.name || f.name}" to ${S().doc.samples.length} sample${S().doc.samples.length === 1 ? '' : 's'}.`);
  } catch (e) {
    toast(e.message, { kind: 'error', timeout: 8000 });
  }
}

export async function exportGatingMLFile() {
  const s = S();
  const doc = s.doc;
  if (!Object.keys(doc.gates).length) {
    toast('There are no gates to export yet.', { kind: 'warn' });
    return;
  }
  const choice = doc.comp.default;
  let compensation = { mode: 'none' };
  if (choice === 'file') {
    const first = doc.samples.find((x) => effectiveComp(s, x.id));
    const c = first ? effectiveComp(s, first.id) : null;
    compensation = { mode: 'file', fileNames: c ? c.names : [] };
  } else if (choice !== 'none') {
    const m = doc.comp.matrices.find((x) => x.id === choice);
    if (m) compensation = { mode: 'matrix', matrix: m };
  }
  const xml = exportGatingML({ gates: orderGates(doc.gates).ordered, transforms: doc.transforms, compensation, derived: doc.derived || [], appName: `${APP.name} ${APP.version}` });
  report(await saveFile(`${safeName(doc.name)}.gating-ml.xml`, xml), 'Gating-ML file saved');
}

/** Merge a parsed Gating-ML document (gates, scales, ratios, matrix) into the workspace. */
export function applyGatingML(text, fileName) {
  const res = importGatingML(text);
  if (!res.gates.length) {
    toast(`No gates were found in ${fileName}.`, { kind: 'warn' });
    return;
  }
  updateDoc((d) => {
    const gates = { ...d.gates };
    for (const g of res.gates) gates[g.id] = g;
    const transforms = { ...d.transforms };
    for (const [ch, spec] of Object.entries(res.transforms)) transforms[ch] = normalizeSpec(spec);
    const names = new Set((res.derived || []).map((x) => x.name));
    const derived = [...(d.derived || []).filter((x) => !names.has(x.name)), ...(res.derived || [])];
    for (const x of res.derived || []) if (!transforms[x.name]) transforms[x.name] = normalizeSpec(RATIO_SPEC);
    return { ...d, gates, gateOrder: [...d.gateOrder, ...res.gates.map((g) => g.id)], transforms, derived };
  });
  if (res.compensation && res.compensation.mode === 'matrix') {
    addMatrix({ name: res.compensation.matrix.name || 'Imported matrix', names: res.compensation.matrix.names, matrix: res.compensation.matrix.matrix, source: 'gating-ml' }, { assign: true });
  }
  const extra = res.warnings.length ? ` ${res.warnings.length} note${res.warnings.length > 1 ? 's' : ''}: ${res.warnings[0]}` : '';
  toast(`Imported ${res.gates.length} gate${res.gates.length > 1 ? 's' : ''} from ${fileName}.${extra}`, { timeout: 9000 });
  setUI({ view: 'gating' });
}

export async function importGatingMLFile() {
  const [file] = await pickFiles({ accept: '.xml,application/xml,text/xml', multiple: false });
  if (!file) return;
  try {
    applyGatingML(await file.text(), file.name);
  } catch (e) {
    toast(`Could not import ${file.name}: ${e.message}`, { kind: 'error', timeout: 9000 });
  }
}
