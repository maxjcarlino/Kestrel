// Population statistics.

export const STATS = {
  count: { label: 'Count', channel: false, short: 'Count' },
  freqParent: { label: 'Frequency of parent', channel: false, unit: '%', short: '% Parent' },
  freqGrandparent: { label: 'Frequency of grandparent', channel: false, unit: '%', short: '% Grandparent' },
  freqTotal: { label: 'Frequency of total', channel: false, unit: '%', short: '% Total' },
  median: { label: 'Median', channel: true, short: 'Median' },
  mean: { label: 'Mean', channel: true, short: 'Mean' },
  geomean: { label: 'Geometric mean', channel: true, short: 'gMean' },
  sd: { label: 'Standard deviation', channel: true, short: 'SD' },
  cv: { label: 'Coefficient of variation', channel: true, unit: '%', short: 'CV' },
  rsd: { label: 'Robust SD', channel: true, short: 'rSD' },
  rcv: { label: 'Robust CV', channel: true, unit: '%', short: 'rCV' },
  mode: { label: 'Mode', channel: true, short: 'Mode' },
  min: { label: 'Minimum', channel: true, short: 'Min' },
  max: { label: 'Maximum', channel: true, short: 'Max' },
  percentile: { label: 'Percentile', channel: true, arg: 'p', short: 'P' },
};

export const STAT_ORDER = ['count', 'freqParent', 'freqGrandparent', 'freqTotal', 'median', 'mean', 'geomean', 'sd', 'cv', 'rsd', 'rcv', 'mode', 'min', 'max', 'percentile'];

export function statLabel(stat, arg) {
  const s = STATS[stat];
  if (!s) return stat;
  if (stat === 'percentile') return `P${arg ?? 50}`;
  return s.short;
}

/** Extract finite values of a channel for a population. */
export function subset(values, idx) {
  const out = new Float32Array(idx.length);
  let m = 0;
  for (let k = 0; k < idx.length; k++) {
    const v = values[idx[k]];
    if (v === v && v !== Infinity && v !== -Infinity) out[m++] = v;
  }
  return m === idx.length ? out : out.slice(0, m);
}

/** Linear-interpolated percentile of a sorted array (R type 7). */
export function percentileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const f = pos - lo;
  return sorted[lo] + f * (sorted[hi] - sorted[lo]);
}

/**
 * Compute channel statistics for one population.
 * @param {Float32Array} values channel values (all events)
 * @param {Uint32Array} idx population event indices
 * @param {{stat:string,arg?:number}[]} wanted
 * @param {Float32Array|null} scaled display-scale values (for mode)
 * @param {{inverse:(s:number)=>number}|null} transform channel transform (for mode)
 */
export function channelStats(values, idx, wanted, scaled = null, transform = null) {
  const res = {};
  const vals = subset(values, idx);
  const n = vals.length;
  let sorted = null;
  const getSorted = () => {
    if (!sorted) {
      sorted = vals.slice();
      sorted.sort();
    }
    return sorted;
  };
  let mean = NaN;
  let sd = NaN;
  if (n > 0) {
    let s = 0;
    for (let i = 0; i < n; i++) s += vals[i];
    mean = s / n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = vals[i] - mean;
      ss += d * d;
    }
    sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  }
  for (const w of wanted) {
    const key = w.stat === 'percentile' ? `percentile:${w.arg ?? 50}` : w.stat;
    if (n === 0) {
      res[key] = NaN;
      continue;
    }
    switch (w.stat) {
      case 'mean': res[key] = mean; break;
      case 'sd': res[key] = sd; break;
      case 'cv': res[key] = mean !== 0 ? (100 * sd) / Math.abs(mean) : NaN; break;
      case 'median': res[key] = percentileSorted(getSorted(), 50); break;
      case 'min': res[key] = getSorted()[0]; break;
      case 'max': res[key] = getSorted()[n - 1]; break;
      case 'percentile': res[key] = percentileSorted(getSorted(), w.arg ?? 50); break;
      case 'rsd': {
        const so = getSorted();
        res[key] = (percentileSorted(so, 84.13) - percentileSorted(so, 15.87)) / 2;
        break;
      }
      case 'rcv': {
        const so = getSorted();
        const med = percentileSorted(so, 50);
        const r = (percentileSorted(so, 84.13) - percentileSorted(so, 15.87)) / 2;
        res[key] = med !== 0 ? (100 * r) / Math.abs(med) : NaN;
        break;
      }
      case 'geomean': {
        let s = 0;
        let c = 0;
        for (let i = 0; i < n; i++) {
          const v = vals[i];
          if (v > 0) {
            s += Math.log(v);
            c++;
          }
        }
        res[key] = c > 0 ? Math.exp(s / c) : NaN;
        break;
      }
      case 'mode': {
        if (scaled && transform) {
          const bins = 256;
          const h = new Float64Array(bins);
          for (let k = 0; k < idx.length; k++) {
            let s = scaled[idx[k]];
            if (!(s >= 0)) s = 0;
            if (s > 1) s = 1;
            h[Math.min(bins - 1, (s * bins) | 0)]++;
          }
          let best = 0;
          for (let b = 1; b < bins; b++) if (h[b] > h[best]) best = b;
          res[key] = transform.inverse((best + 0.5) / bins);
        } else {
          res[key] = percentileSorted(getSorted(), 50);
        }
        break;
      }
      default:
        res[key] = NaN;
    }
  }
  return res;
}

/** Format a statistic value for display. */
export function formatStat(stat, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  if (stat === 'count') return Math.round(v).toLocaleString('en-US');
  const s = STATS[stat];
  if (s && s.unit === '%') return v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

/**
 * Population frequencies from a counts table ({root, [gateId]: n}).
 * @param {Record<string,{parent?:string}>} gates gate definitions by id
 * @param {string} stat count | freqParent | freqGrandparent | freqTotal
 */
export function populationFrequency(gates, counts, id, stat) {
  if (!counts) return NaN;
  const ROOT_ID = 'root';
  const n = id === ROOT_ID ? counts.root : counts[id];
  if (n === undefined) return NaN;
  if (stat === 'count') return n;
  if (stat === 'freqTotal') return counts.root ? (100 * n) / counts.root : NaN;
  const parentOf = (gid) => (gates[gid] ? gates[gid].parent || ROOT_ID : null);
  const p = id === ROOT_ID ? null : parentOf(id);
  if (stat === 'freqParent') {
    if (p === null) return 100;
    const pn = p === ROOT_ID ? counts.root : counts[p];
    return pn ? (100 * n) / pn : NaN;
  }
  if (stat === 'freqGrandparent') {
    if (p === null) return 100;
    const gp = p === ROOT_ID ? ROOT_ID : parentOf(p);
    const gn = gp === ROOT_ID ? counts.root : counts[gp];
    return gn ? (100 * n) / gn : NaN;
  }
  return NaN;
}
