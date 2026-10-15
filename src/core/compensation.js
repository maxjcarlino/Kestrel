// Compensation: spillover matrices, inversion and application.
//
// A spillover matrix S has one row per fluorochrome and one column per
// detector: S[i][j] is the fraction of fluorochrome i's signal (measured in
// its primary detector) that appears in detector j. Diagonal entries are 1.
// Compensated events are  c = r · S⁻¹  where r is the raw detector vector.

export { parseSpillover } from './fcs-parse.js';
export { spilloverToString } from './fcs-write.js';

export class CompensationError extends Error {}

export function identity(n) {
  const m = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(0);
    row[i] = 1;
    m.push(row);
  }
  return m;
}

/** Gauss-Jordan inversion with partial pivoting. */
export function invertMatrix(m) {
  const n = m.length;
  const a = m.map((r) => Float64Array.from(r));
  const inv = identity(n).map((r) => Float64Array.from(r));
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r][col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-12) throw new CompensationError('The spillover matrix cannot be inverted (it is singular).');
    if (piv !== col) {
      [a[piv], a[col]] = [a[col], a[piv]];
      [inv[piv], inv[col]] = [inv[col], inv[piv]];
    }
    const p = a[col][col];
    for (let c = 0; c < n; c++) {
      a[col][c] /= p;
      inv[col][c] /= p;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let c = 0; c < n; c++) {
        a[r][c] -= f * a[col][c];
        inv[r][c] -= f * inv[col][c];
      }
    }
  }
  return inv.map((r) => Array.from(r));
}

export function multiply(a, b) {
  const n = a.length;
  const m = b[0].length;
  const k = b.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(m).fill(0);
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let t = 0; t < k; t++) s += a[i][t] * b[t][j];
      row[j] = s;
    }
    out.push(row);
  }
  return out;
}

/**
 * Map spillover names to channel indices. Tries exact detector names,
 * case-insensitive names, names without a "Comp-" prefix, and finally stain
 * labels. Returns -1 for names that cannot be matched.
 */
export function matchChannels(names, channels) {
  const byName = new Map();
  const byLower = new Map();
  const byLabel = new Map();
  channels.forEach((ch, i) => {
    byName.set(ch.name, i);
    byLower.set(ch.name.toLowerCase(), i);
    if (ch.label) byLabel.set(ch.label.toLowerCase(), i);
  });
  return names.map((raw) => {
    const name = String(raw).trim();
    if (byName.has(name)) return byName.get(name);
    const lower = name.toLowerCase();
    if (byLower.has(lower)) return byLower.get(lower);
    const stripped = lower.replace(/^comp-/, '');
    if (byLower.has(stripped)) return byLower.get(stripped);
    if (/^\d+$/.test(name)) {
      const k = parseInt(name, 10) - 1;
      if (k >= 0 && k < channels.length) return k;
    }
    if (byLabel.has(lower)) return byLabel.get(lower);
    return -1;
  });
}

/** Stable key used to cache compensated data. */
export function matrixKey(m) {
  if (!m) return 'none';
  let h = 2166136261;
  const s = m.names.join('\u0001') + '|' + m.matrix.map((r) => r.map((v) => v.toPrecision(10)).join(',')).join(';');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'm' + (h >>> 0).toString(36) + ':' + m.names.length;
}

/**
 * Apply compensation to columns.
 * @param {Float32Array[]} columns raw columns of the sample
 * @param {number[]} idx channel index for each matrix row/column
 * @param {number[][]} inv inverse spillover matrix
 * @param {number} N number of events
 * @returns {Float32Array[]} compensated columns, aligned with idx
 */
export function compensateColumns(columns, idx, inv, N) {
  const n = idx.length;
  const out = [];
  for (let j = 0; j < n; j++) {
    const dst = new Float32Array(N);
    for (let k = 0; k < n; k++) {
      const coef = inv[k][j];
      if (coef === 0) continue;
      const src = columns[idx[k]];
      if (coef === 1) {
        for (let i = 0; i < N; i++) dst[i] += src[i];
      } else {
        for (let i = 0; i < N; i++) dst[i] += src[i] * coef;
      }
    }
    out.push(dst);
  }
  return out;
}

/**
 * Build a spillover matrix from single-stain control measurements.
 * @param {string[]} names detector names (matrix order)
 * @param {{primary:string, pos:Record<string,number>, neg:Record<string,number>}[]} controls
 *   median signal of every detector for positive and negative events
 */
export function spilloverFromMedians(names, controls) {
  const n = names.length;
  const m = identity(n);
  const index = new Map(names.map((nm, i) => [nm, i]));
  const notes = [];
  for (const c of controls) {
    const i = index.get(c.primary);
    if (i === undefined) continue;
    const di = c.pos[c.primary] - c.neg[c.primary];
    if (!(di > 0)) {
      notes.push(`${c.primary}: positive and negative events are not separated; row left as identity.`);
      continue;
    }
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const nm = names[j];
      const v = (c.pos[nm] - c.neg[nm]) / di;
      m[i][j] = Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0;
    }
  }
  return { names: names.slice(), matrix: m, notes };
}

export function isIdentity(m) {
  for (let i = 0; i < m.matrix.length; i++) {
    for (let j = 0; j < m.matrix.length; j++) {
      const e = i === j ? 1 : 0;
      if (Math.abs(m.matrix[i][j] - e) > 1e-12) return false;
    }
  }
  return true;
}
