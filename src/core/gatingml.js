// Gating-ML 2.0 import and export.
//
// Gate coordinates in Gating-ML are expressed in the scale of the transform
// referenced by each dimension. Internally gates are stored in data units,
// so coordinates are converted with transform.scale() on export and
// transform.inverse() on import.

import { makeTransform, normalizeSpec, transformKey, arcsinhFromGatingML } from './transforms.js';
import { invertMatrix } from './compensation.js';
import { parseXml, attr, kids, kid, escapeXml } from './xml.js';
import { ROOT, orderGates } from './gates.js';
import { newId, GATE_COLORS } from './gate-geometry.js';

const NS = {
  gating: 'http://www.isac-net.org/std/Gating-ML/v2.0/gating',
  transforms: 'http://www.isac-net.org/std/Gating-ML/v2.0/transformations',
  dt: 'http://www.isac-net.org/std/Gating-ML/v2.0/datatypes',
};

function num(v) {
  if (!Number.isFinite(v)) return '0';
  return String(Number(v.toPrecision(12)));
}

function xmlId(s, used) {
  let base = String(s || 'gate').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[^A-Za-z_]+/, '');
  if (!base) base = 'gate';
  let id = base;
  let k = 2;
  while (used.has(id)) id = `${base}_${k++}`;
  used.add(id);
  return id;
}

const IDENTITY = normalizeSpec({ type: 'linear', min: 0, max: 1 });
const isIdentity = (spec) => transformKey(spec) === transformKey(IDENTITY);

function transformLine(spec) {
  switch (spec.type) {
    case 'log':
      return `<transforms:flog transforms:T="${num(spec.max)}" transforms:M="${num(spec.decades)}"/>`;
    case 'logicle':
      return `<transforms:logicle transforms:T="${num(spec.T)}" transforms:W="${num(spec.W)}" transforms:M="${num(spec.M)}" transforms:A="${num(spec.A)}"/>`;
    case 'hyperlog':
      return `<transforms:hyperlog transforms:T="${num(spec.T)}" transforms:W="${num(spec.W)}" transforms:M="${num(spec.M)}" transforms:A="${num(spec.A)}"/>`;
    case 'arcsinh': {
      const p = makeTransform(spec).gatingML();
      return `<transforms:fasinh transforms:T="${num(p.T)}" transforms:M="${num(p.M)}" transforms:A="${num(p.A)}"/>`;
    }
    default:
      return `<transforms:flin transforms:T="${num(spec.max)}" transforms:A="${num(-spec.min)}"/>`;
  }
}

/**
 * @param {object} o
 * @param {object[]} o.gates gate definitions
 * @param {Record<string, object>} o.transforms channel -> transform spec
 * @param {{mode:'none'|'file'|'matrix', matrix?:{name:string,names:string[],matrix:number[][]}, fileNames?:string[]}} o.compensation
 * @param {string} [o.appName]
 * @param {object[]} [o.derived] ratio parameters
 */
export function exportGatingML({ gates, transforms, compensation = { mode: 'none' }, appName = 'Kestrel', derived = [] }) {
  const { ordered } = orderGates(gates);
  const used = new Set();
  const derivedBy = new Map((derived || []).map((d) => [d.name, d]));
  const derivedIds = new Map();
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<gating:Gating-ML xmlns:gating="${NS.gating}" xmlns:transforms="${NS.transforms}" xmlns:data-type="${NS.dt}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
  lines.push(`  <!-- Exported by ${escapeXml(appName)} -->`);

  const compNames = new Set(compensation && compensation.mode === 'matrix' && compensation.matrix ? compensation.matrix.names : []);
  const fileComp = compensation && compensation.mode === 'file' ? new Set(compensation.fileNames || []) : null;
  let compId = null;
  if (compensation && compensation.mode === 'matrix' && compensation.matrix) {
    compId = xmlId(compensation.matrix.name || 'Compensation', used);
    const m = compensation.matrix;
    lines.push(`  <transforms:spectrumMatrix transforms:id="${compId}">`);
    lines.push('    <transforms:fluorochromes>');
    for (const nm of m.names) lines.push(`      <data-type:fcs-dimension data-type:name="${escapeXml(nm)}"/>`);
    lines.push('    </transforms:fluorochromes>');
    lines.push('    <transforms:detectors>');
    for (const nm of m.names) lines.push(`      <data-type:fcs-dimension data-type:name="${escapeXml(nm)}"/>`);
    lines.push('    </transforms:detectors>');
    for (const row of m.matrix) {
      lines.push('    <transforms:spectrum>');
      for (const v of row) lines.push(`      <data-type:coefficient data-type:value="${num(v)}"/>`);
      lines.push('    </transforms:spectrum>');
    }
    lines.push('  </transforms:spectrumMatrix>');
  }

  // Ratio parameters used by gates
  for (const g of ordered) {
    for (const ch of [g.x, g.y]) {
      if (!ch || !derivedBy.has(ch) || derivedIds.has(ch)) continue;
      const d = derivedBy.get(ch);
      const id = xmlId(ch, used);
      derivedIds.set(ch, id);
      lines.push(`  <transforms:transformation transforms:id="${id}">`);
      lines.push(`    <transforms:fratio transforms:A="${num(d.A ?? 1)}" transforms:B="${num(d.B ?? 0)}" transforms:C="${num(d.C ?? 0)}">`);
      lines.push(`      <data-type:fcs-dimension data-type:name="${escapeXml(d.x)}"/>`);
      lines.push(`      <data-type:fcs-dimension data-type:name="${escapeXml(d.y)}"/>`);
      lines.push('    </transforms:fratio>');
      lines.push('  </transforms:transformation>');
    }
  }

  // Scales: one transformation per distinct scale used by a gate dimension
  const specIds = new Map();
  const specFor = (g, axis) => {
    const ch = axis === 'x' ? g.x : g.y;
    if ((g.type === 'polygon' || g.type === 'ellipse') && g.scale && g.scale[axis]) return normalizeSpec(g.scale[axis]);
    return normalizeSpec(transforms[ch]);
  };
  const ensure = (spec, hint) => {
    if (isIdentity(spec)) return null;
    const k = transformKey(spec);
    if (specIds.has(k)) return specIds.get(k);
    const id = xmlId(`T_${hint}`, used);
    specIds.set(k, id);
    lines.push(`  <transforms:transformation transforms:id="${id}">`);
    lines.push(`    ${transformLine(spec)}`);
    lines.push('  </transforms:transformation>');
    return id;
  };
  for (const g of ordered) {
    if (g.x) ensure(specFor(g, 'x'), g.x);
    if (g.y) ensure(specFor(g, 'y'), g.y);
  }

  const gid = new Map();
  for (const g of ordered) gid.set(g.id, xmlId(g.name, used));

  const compRef = (ch) => {
    if (compId && compNames.has(ch)) return compId;
    if (fileComp && fileComp.has(ch)) return 'FCS';
    return 'uncompensated';
  };
  const dim = (g, axis, extra = '') => {
    const ch = axis === 'x' ? g.x : g.y;
    const spec = specFor(g, axis);
    const tid = isIdentity(spec) ? null : specIds.get(transformKey(spec));
    const inner = derivedIds.has(ch)
      ? `<data-type:new-dimension data-type:transformation-ref="${derivedIds.get(ch)}"/>`
      : `<data-type:fcs-dimension data-type:name="${escapeXml(ch)}"/>`;
    const comp = derivedIds.has(ch) ? 'uncompensated' : compRef(ch);
    return `    <gating:dimension gating:compensation-ref="${comp}"${tid ? ` gating:transformation-ref="${tid}"` : ''}${extra}>${inner}</gating:dimension>`;
  };
  const tOf = (g, axis) => makeTransform(specFor(g, axis));
  const custom = (g) =>
    `    <data-type:custom_info><app>${escapeXml(appName)}</app><name>${escapeXml(g.name)}</name><color>${escapeXml(g.color || '')}</color>${g.link ? `<link kind="${escapeXml(g.link.kind)}" group="${escapeXml(g.link.group)}" role="${escapeXml(g.link.role)}"/>` : ''}</data-type:custom_info>`;

  for (const g of ordered) {
    const id = gid.get(g.id);
    const parent = g.parent && g.parent !== ROOT && gid.has(g.parent) ? ` gating:parent_id="${gid.get(g.parent)}"` : '';
    if (g.type === 'rect' || g.type === 'range') {
      lines.push(`  <gating:RectangleGate gating:id="${id}"${parent}>`);
      lines.push(custom(g));
      const bounds = g.type === 'rect' ? [['x', g.rect.x0, g.rect.x1], ['y', g.rect.y0, g.rect.y1]] : [['x', g.range.lo, g.range.hi]];
      for (const [axis, lo, hi] of bounds) {
        const t = tOf(g, axis);
        let extra = '';
        if (lo !== null && lo !== undefined) extra += ` gating:min="${num(t.scale(lo))}"`;
        if (hi !== null && hi !== undefined) extra += ` gating:max="${num(t.scale(hi))}"`;
        lines.push(dim(g, axis, extra));
      }
      lines.push('  </gating:RectangleGate>');
    } else if (g.type === 'polygon') {
      const tx = tOf(g, 'x');
      const ty = tOf(g, 'y');
      lines.push(`  <gating:PolygonGate gating:id="${id}"${parent}>`);
      lines.push(custom(g));
      lines.push(dim(g, 'x'));
      lines.push(dim(g, 'y'));
      for (const [x, y] of g.polygon) {
        lines.push(`    <gating:vertex><gating:coordinate data-type:value="${num(tx.scale(x))}"/><gating:coordinate data-type:value="${num(ty.scale(y))}"/></gating:vertex>`);
      }
      lines.push('  </gating:PolygonGate>');
    } else if (g.type === 'ellipse') {
      const tx = tOf(g, 'x');
      const ty = tOf(g, 'y');
      const e = g.ellipse;
      const c = [tx.scale(e.c[0]), ty.scale(e.c[1])];
      const u = [tx.scale(e.a[0]) - c[0], ty.scale(e.a[1]) - c[1]];
      const v = [tx.scale(e.b[0]) - c[0], ty.scale(e.b[1]) - c[1]];
      // Covariance of the ellipse { c + s u + t v : s^2 + t^2 <= 1 } with distance^2 = 1
      const s00 = u[0] * u[0] + v[0] * v[0];
      const s01 = u[0] * u[1] + v[0] * v[1];
      const s11 = u[1] * u[1] + v[1] * v[1];
      lines.push(`  <gating:EllipsoidGate gating:id="${id}"${parent}>`);
      lines.push(custom(g));
      lines.push(dim(g, 'x'));
      lines.push(dim(g, 'y'));
      lines.push(`    <gating:mean><gating:coordinate data-type:value="${num(c[0])}"/><gating:coordinate data-type:value="${num(c[1])}"/></gating:mean>`);
      lines.push('    <gating:covarianceMatrix>');
      lines.push(`      <gating:row><gating:entry data-type:value="${num(s00)}"/><gating:entry data-type:value="${num(s01)}"/></gating:row>`);
      lines.push(`      <gating:row><gating:entry data-type:value="${num(s01)}"/><gating:entry data-type:value="${num(s11)}"/></gating:row>`);
      lines.push('    </gating:covarianceMatrix>');
      lines.push('    <gating:distanceSquare data-type:value="1"/>');
      lines.push('  </gating:EllipsoidGate>');
    } else if (g.type === 'boolean') {
      const spec = g.boolean || { op: 'and', refs: [] };
      const refs = (spec.refs || []).filter((r) => gid.has(r.id));
      lines.push(`  <gating:BooleanGate gating:id="${id}"${parent}>`);
      lines.push(custom(g));
      if (refs.length === 1 && refs[0].not && spec.op !== 'or') {
        lines.push(`    <gating:not><gating:gateReference gating:ref="${gid.get(refs[0].id)}"/></gating:not>`);
      } else {
        const op = spec.op === 'or' ? 'or' : 'and';
        lines.push(`    <gating:${op}>`);
        for (const r of refs) {
          lines.push(`      <gating:gateReference gating:ref="${gid.get(r.id)}"${r.not ? ' gating:use-as-complement="true"' : ''}/>`);
        }
        lines.push(`    </gating:${op}>`);
      }
      lines.push('  </gating:BooleanGate>');
    }
  }
  lines.push('</gating:Gating-ML>');
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------ import

function parseTransformNode(node) {
  const f = node.children[0];
  if (!f) return null;
  const p = (k, d) => {
    const v = parseFloat(attr(f, k));
    return Number.isFinite(v) ? v : d;
  };
  switch (f.local) {
    case 'flin': {
      const T = p('T', 262144);
      const A = p('A', 0);
      return normalizeSpec({ type: 'linear', min: -A, max: T });
    }
    case 'flog':
      return normalizeSpec({ type: 'log', max: p('T', 262144), decades: p('M', 4.5) });
    case 'logicle':
      return normalizeSpec({ type: 'logicle', T: p('T', 262144), W: p('W', 0.5), M: p('M', 4.5), A: p('A', 0) });
    case 'hyperlog':
      return normalizeSpec({ type: 'hyperlog', T: p('T', 262144), W: p('W', 1), M: p('M', 4.5), A: p('A', 0) });
    case 'fasinh':
      return arcsinhFromGatingML(p('T', 262144), p('M', 4.5), p('A', 0));
    default:
      return { unsupported: f.local };
  }
}

function dimInfo(d, fluoroMaps) {
  const fd = kid(d, 'fcs-dimension');
  const nd = kid(d, 'new-dimension');
  let name = fd ? attr(fd, 'name') : nd ? attr(nd, 'transformation-ref') : undefined;
  let comp = attr(d, 'compensation-ref') || 'uncompensated';
  if (name && /^comp-/i.test(name)) {
    name = name.replace(/^comp-/i, '');
    if (comp === 'uncompensated') comp = 'FCS';
  }
  // With a spectrum matrix, dimensions are named by fluorochrome; use its detector.
  if (name && fluoroMaps && fluoroMaps.has(comp)) {
    const det = fluoroMaps.get(comp).get(name);
    if (det) name = det;
  }
  const min = attr(d, 'min');
  const max = attr(d, 'max');
  return {
    name,
    comp,
    trans: attr(d, 'transformation-ref') || null,
    min: min !== undefined ? parseFloat(min) : null,
    max: max !== undefined ? parseFloat(max) : null,
  };
}

function customInfo(node) {
  const ci = kid(node, 'custom_info');
  if (!ci) return {};
  const out = {};
  const nm = kids(ci).find((c) => c.local === 'name');
  if (nm) out.name = nm.text.trim();
  const col = kids(ci).find((c) => c.local === 'color');
  if (col && /^#[0-9a-f]{3,8}$/i.test(col.text.trim())) out.color = col.text.trim();
  const link = kids(ci).find((c) => c.local === 'link');
  if (link) out.link = { kind: attr(link, 'kind'), group: attr(link, 'group'), role: attr(link, 'role') };
  return out;
}

function cholesky2(a, b, c) {
  // [[a b][b c]] = L L^T
  const l00 = Math.sqrt(Math.max(a, 0));
  const l10 = l00 > 0 ? b / l00 : 0;
  const l11 = Math.sqrt(Math.max(c - l10 * l10, 0));
  return [[l00, 0], [l10, l11]];
}

/**
 * Parse Gating-ML 2.0.
 * @returns {{gates:object[], transforms:Record<string,object>, compensation:object|null, warnings:string[]}}
 */
export function importGatingML(xml) {
  const doc = parseXml(xml);
  const rootEl = doc.children.find((c) => c.local === 'Gating-ML');
  if (!rootEl) throw new Error('This file is not Gating-ML: no <Gating-ML> root element.');
  const warnings = [];
  const transformsById = new Map();
  const matrices = new Map();
  const fluoroMaps = new Map();
  const derived = [];
  for (const c of rootEl.children) {
    if (c.local === 'transformation' && c.children[0] && c.children[0].local === 'fratio') {
      const f = c.children[0];
      const dims = kids(f, 'fcs-dimension').map((d) => attr(d, 'name'));
      const num = (k, dflt) => {
        const v = parseFloat(attr(f, k));
        return Number.isFinite(v) ? v : dflt;
      };
      derived.push({ name: attr(c, 'id'), kind: 'ratio', x: dims[0], y: dims[1], A: num('A', 1), B: num('B', 0), C: num('C', 0) });
    } else if (c.local === 'transformation') {
      const id = attr(c, 'id');
      const spec = parseTransformNode(c);
      if (spec && spec.unsupported) warnings.push(`Transform ${id} (${spec.unsupported}) is not supported and was treated as linear.`);
      transformsById.set(id, spec && !spec.unsupported ? spec : null);
    } else if (c.local === 'spectrumMatrix') {
      const id = attr(c, 'id');
      const fl = kids(kid(c, 'fluorochromes'), 'fcs-dimension').map((d) => attr(d, 'name'));
      const det = kids(kid(c, 'detectors'), 'fcs-dimension').map((d) => attr(d, 'name'));
      let rows = kids(c, 'spectrum').map((s) => kids(s, 'coefficient').map((k) => parseFloat(attr(k, 'value'))));
      if (String(attr(c, 'matrix-inverted-already')) === 'true') {
        try {
          rows = invertMatrix(rows);
        } catch (e) {
          warnings.push(`Compensation ${id} could not be inverted.`);
        }
      }
      if (fl.length !== det.length) warnings.push(`Compensation ${id} has different fluorochrome and detector counts; using detector names.`);
      matrices.set(id, { id, name: id, names: det.length ? det : fl, matrix: rows });
      const map = new Map();
      fl.forEach((f, i) => det[i] && f && map.set(f, det[i]));
      fluoroMaps.set(id, map);
    }
  }

  const channelTransforms = {};
  const compUsed = new Set();
  const rawGates = [];
  const idMap = new Map();
  const toRaw = (dim, v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    const spec = dim.trans ? transformsById.get(dim.trans) : null;
    if (dim.name && spec && !channelTransforms[dim.name]) channelTransforms[dim.name] = spec;
    if (!spec) return v;
    return makeTransform(spec).inverse(v);
  };
  const noteDim = (dim) => {
    if (dim.comp && dim.comp !== 'uncompensated') compUsed.add(dim.comp);
    if (dim.name && dim.trans && transformsById.get(dim.trans) && !channelTransforms[dim.name]) {
      channelTransforms[dim.name] = transformsById.get(dim.trans);
    }
  };
  let colorIdx = 0;
  const color = (info) => info.color || GATE_COLORS[colorIdx++ % GATE_COLORS.length];
  // the scale a dimension's coordinates are expressed in (identity when none is named)
  const specOf = (dim) => (dim.trans && transformsById.get(dim.trans)) || IDENTITY;

  for (const el of rootEl.children) {
    const xid = attr(el, 'id');
    const parentX = attr(el, 'parent_id') || null;
    const info = customInfo(el);
    const dims = kids(el, 'dimension').map((d) => dimInfo(d, fluoroMaps));
    dims.forEach(noteDim);
    const base = { xid, parentX, name: info.name || xid, color: color(info) };
    if (el.local === 'RectangleGate') {
      if (dims.length === 1) {
        rawGates.push({ ...base, type: 'range', x: dims[0].name, y: null, range: { lo: toRaw(dims[0], dims[0].min), hi: toRaw(dims[0], dims[0].max) }, link: info.link || null });
      } else if (dims.length === 2) {
        rawGates.push({
          ...base, type: 'rect', x: dims[0].name, y: dims[1].name,
          rect: { x0: toRaw(dims[0], dims[0].min), x1: toRaw(dims[0], dims[0].max), y0: toRaw(dims[1], dims[1].min), y1: toRaw(dims[1], dims[1].max) },
          link: info.link || null,
        });
      } else warnings.push(`Rectangle gate ${xid} has ${dims.length} dimensions; only 1 or 2 are supported.`);
    } else if (el.local === 'PolygonGate') {
      if (dims.length !== 2) {
        warnings.push(`Polygon gate ${xid} must have 2 dimensions.`);
        continue;
      }
      const verts = kids(el, 'vertex').map((v) => kids(v, 'coordinate').map((c) => parseFloat(attr(c, 'value'))));
      rawGates.push({ ...base, type: 'polygon', x: dims[0].name, y: dims[1].name, polygon: verts.map((v) => [toRaw(dims[0], v[0]), toRaw(dims[1], v[1])]), evalSpecs: [specOf(dims[0]), specOf(dims[1])] });
    } else if (el.local === 'EllipsoidGate') {
      if (dims.length !== 2) {
        warnings.push(`Ellipsoid gate ${xid} must have 2 dimensions.`);
        continue;
      }
      const mean = kids(kid(el, 'mean'), 'coordinate').map((c) => parseFloat(attr(c, 'value')));
      const rows = kids(kid(el, 'covarianceMatrix'), 'row').map((r) => kids(r, 'entry').map((e) => parseFloat(attr(e, 'value'))));
      const d2 = parseFloat(attr(kid(el, 'distanceSquare'), 'value'));
      const k = Number.isFinite(d2) ? d2 : 1;
      const L = cholesky2(rows[0][0] * k, rows[0][1] * k, rows[1][1] * k);
      const c = mean;
      const a = [c[0] + L[0][0], c[1] + L[1][0]];
      const b = [c[0] + L[0][1], c[1] + L[1][1]];
      const tx = transformsById.get(dims[0].trans);
      const ty = transformsById.get(dims[1].trans);
      const ix = (v) => (tx ? makeTransform(tx).inverse(v) : v);
      const iy = (v) => (ty ? makeTransform(ty).inverse(v) : v);
      rawGates.push({ ...base, type: 'ellipse', x: dims[0].name, y: dims[1].name, ellipse: { c: [ix(c[0]), iy(c[1])], a: [ix(a[0]), iy(a[1])], b: [ix(b[0]), iy(b[1])] }, evalSpecs: [specOf(dims[0]), specOf(dims[1])] });
    } else if (el.local === 'QuadrantGate') {
      const dividers = new Map();
      for (const dv of kids(el, 'divider')) {
        const di = dimInfo(dv, fluoroMaps);
        noteDim(di);
        const values = kids(dv, 'value').map((v) => parseFloat(v.text)).filter(Number.isFinite).sort((p, q) => p - q);
        dividers.set(attr(dv, 'id'), { dim: di, values, order: dividers.size });
      }
      const quads = kids(el, 'Quadrant');
      const group = newId('q');
      const isClassic = dividers.size === 2 && [...dividers.values()].every((d) => d.values.length === 1) && quads.length === 4;
      for (const q of quads) {
        const qid = attr(q, 'id');
        const bounds = [];
        for (const pos of kids(q, 'position')) {
          const d = dividers.get(attr(pos, 'divider_ref'));
          if (!d) continue;
          const loc = parseFloat(attr(pos, 'location'));
          let lo = null;
          let hi = null;
          for (const v of d.values) {
            if (v <= loc) lo = v;
            else if (hi === null) hi = v;
          }
          bounds.push({ dim: d.dim, lo, hi, order: d.order });
        }
        bounds.sort((p, q) => p.order - q.order);
        const qbase = { xid: qid, parentX, name: qid, color: GATE_COLORS[colorIdx++ % GATE_COLORS.length] };
        if (bounds.length === 2) {
          const [bx, by] = bounds;
          let role = null;
          if (isClassic) role = `${by.lo !== null ? 'U' : 'L'}${bx.lo !== null ? 'R' : 'L'}`;
          rawGates.push({
            ...qbase, type: 'rect', x: bx.dim.name, y: by.dim.name,
            rect: { x0: toRaw(bx.dim, bx.lo), x1: toRaw(bx.dim, bx.hi), y0: toRaw(by.dim, by.lo), y1: toRaw(by.dim, by.hi) },
            link: role ? { kind: 'quad', group, role } : null,
          });
        } else if (bounds.length === 1) {
          rawGates.push({ ...qbase, type: 'range', x: bounds[0].dim.name, y: null, range: { lo: toRaw(bounds[0].dim, bounds[0].lo), hi: toRaw(bounds[0].dim, bounds[0].hi) } });
        } else if (bounds.length > 2) {
          // A region in three or more dimensions becomes the AND of 2-D and 1-D parts.
          const parts = [];
          for (let i = 0; i < bounds.length; i += 2) {
            const [bx, by] = [bounds[i], bounds[i + 1]];
            const pid = `${qid}\u0000part${parts.length + 1}`;
            const pname = by ? `${qid} (${bx.dim.name} × ${by.dim.name})` : `${qid} (${bx.dim.name})`;
            const pbase = { xid: pid, parentX, name: pname, color: qbase.color };
            if (by) {
              rawGates.push({ ...pbase, type: 'rect', x: bx.dim.name, y: by.dim.name, rect: { x0: toRaw(bx.dim, bx.lo), x1: toRaw(bx.dim, bx.hi), y0: toRaw(by.dim, by.lo), y1: toRaw(by.dim, by.hi) } });
            } else {
              rawGates.push({ ...pbase, type: 'range', x: bx.dim.name, y: null, range: { lo: toRaw(bx.dim, bx.lo), hi: toRaw(bx.dim, bx.hi) } });
            }
            parts.push(pid);
          }
          rawGates.push({ ...qbase, type: 'boolean', x: null, y: null, boolean: { op: 'and', xrefs: parts.map((xref) => ({ xref, not: false })) } });
          warnings.push(`Quadrant ${qid} spans ${bounds.length} dimensions, so it was imported as the AND of ${parts.length} simpler gates.`);
        } else warnings.push(`Quadrant ${qid} has no positions and was skipped.`);
      }
    } else if (el.local === 'BooleanGate') {
      const opEl = el.children.find((c) => c.local === 'and' || c.local === 'or' || c.local === 'not');
      if (!opEl) {
        warnings.push(`Boolean gate ${xid} has no operator.`);
        continue;
      }
      const refs = kids(opEl, 'gateReference').map((r) => ({ xref: attr(r, 'ref'), not: String(attr(r, 'use-as-complement')) === 'true' }));
      if (opEl.local === 'not') refs.forEach((r) => (r.not = !r.not));
      rawGates.push({ ...base, type: 'boolean', x: null, y: null, boolean: { op: opEl.local === 'or' ? 'or' : 'and', xrefs: refs } });
    }
  }

  for (const g of rawGates) idMap.set(g.xid, newId('g'));
  const groupMap = new Map();
  const gates = [];
  for (const g of rawGates) {
    const out = { ...g, id: idMap.get(g.xid), parent: g.parentX && idMap.has(g.parentX) ? idMap.get(g.parentX) : ROOT };
    if (out.link && out.link.group) {
      if (!groupMap.has(out.link.group)) groupMap.set(out.link.group, newId(out.link.kind === 'split' ? 's' : 'q'));
      out.link = { ...out.link, group: groupMap.get(out.link.group) };
    } else if (out.link) out.link = null;
    if (g.parentX && !idMap.has(g.parentX)) warnings.push(`Gate ${g.xid} refers to an unknown parent ${g.parentX}; placed at the top level.`);
    if (g.type === 'boolean') {
      out.boolean = { op: g.boolean.op, refs: g.boolean.xrefs.filter((r) => idMap.has(r.xref)).map((r) => ({ id: idMap.get(r.xref), not: r.not })) };
    }
    if (g.evalSpecs) {
      // Keep the gate's own scales only where they differ from the display scale chosen for the channel.
      const [ex, ey] = g.evalSpecs;
      const same = (spec, ch) => channelTransforms[ch] && transformKey(channelTransforms[ch]) === transformKey(spec);
      if (!(same(ex, g.x) && same(ey, g.y))) out.scale = { x: ex, y: ey };
    }
    delete out.evalSpecs;
    delete out.xid;
    delete out.parentX;
    gates.push(out);
  }

  let compensation = null;
  if (compUsed.size > 0) {
    const ids = [...compUsed];
    const mid = ids.find((i) => matrices.has(i));
    if (mid) compensation = { mode: 'matrix', matrix: matrices.get(mid) };
    else if (ids.includes('FCS')) compensation = { mode: 'file' };
    if (ids.filter((i) => i !== 'FCS').length > 1) warnings.push('Several compensation matrices are referenced; only the first was imported.');
  } else if (matrices.size > 0) {
    compensation = { mode: 'matrix', matrix: [...matrices.values()][0] };
  }

  return { gates, transforms: channelTransforms, compensation, derived, warnings };
}
