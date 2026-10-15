// FCS 2.0 / 3.0 / 3.1 / 3.2 reader.
//
// Returns column-oriented Float32Array data (one array per parameter) plus
// parsed metadata. Handles escaped delimiters, supplemental TEXT segments,
// large-file offsets stored in TEXT, multiple data sets ($NEXTDATA), integer
// bit masks, log-amplified integer channels ($PnE) and amplifier gain ($PnG).

export class FCSError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FCSError';
  }
}

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('windows-1252');

/** Keyword lookup that is case-insensitive, as the standard requires. */
export function keywordGetter(keywords) {
  const upper = new Map();
  for (const k of Object.keys(keywords)) upper.set(k.toUpperCase(), keywords[k]);
  return (name) => {
    const v = upper.get(name.toUpperCase());
    return v === undefined ? undefined : v;
  };
}

function readHeader(bytes, base) {
  if (bytes.length < base + 58) throw new FCSError('File is too short to be an FCS file.');
  const ascii = (s, e) => {
    let out = '';
    for (let i = base + s; i < base + e; i++) out += String.fromCharCode(bytes[i]);
    return out;
  };
  const version = ascii(0, 6);
  if (!/^FCS\d\.\d$/.test(version)) {
    throw new FCSError('This is not an FCS file: the header does not start with "FCS".');
  }
  const num = (s, e) => {
    const t = ascii(s, e).trim();
    if (t === '') return 0;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    version,
    textStart: num(10, 18),
    textEnd: num(18, 26),
    dataStart: num(26, 34),
    dataEnd: num(34, 42),
    analysisStart: num(42, 50),
    analysisEnd: num(50, 58),
  };
}

function decodeText(bytes) {
  // FCS 3.1+ mandates UTF-8; older files are effectively Latin-1. Use UTF-8
  // when it decodes cleanly.
  const s = utf8.decode(bytes);
  if (s.indexOf('�') >= 0) return latin1.decode(bytes);
  return s;
}

/**
 * Split a TEXT segment into keyword/value pairs. When `escapes` is true a
 * doubled delimiter is read as a literal delimiter character (the standard);
 * otherwise every delimiter separates tokens (needed for some writers that
 * emit empty values).
 */
function splitText(str, escapes) {
  const delim = str[0];
  const tokens = [];
  let cur = '';
  let i = 1;
  const n = str.length;
  while (i < n) {
    const j = str.indexOf(delim, i);
    if (j < 0) {
      cur += str.slice(i);
      break;
    }
    cur += str.slice(i, j);
    if (escapes && j + 1 < n && str[j + 1] === delim) {
      cur += delim;
      i = j + 2;
      continue;
    }
    tokens.push(cur);
    cur = '';
    i = j + 1;
  }
  if (cur.length > 0) tokens.push(cur);
  return { tokens, delim };
}

function tokensToKeywords(tokens) {
  const kw = {};
  let odd = tokens.length % 2 === 1;
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const key = tokens[i].trim();
    if (key === '') continue;
    kw[key] = tokens[i + 1];
  }
  return { kw, odd };
}

function scoreKeywords(kw, delim) {
  let bad = 0;
  for (const k of Object.keys(kw)) {
    if (k.indexOf(delim) >= 0) bad += 2;
    if (/[\x00-\x1f]/.test(k)) bad += 1;
  }
  const get = keywordGetter(kw);
  for (const req of ['$PAR', '$DATATYPE', '$BYTEORD']) if (get(req) === undefined) bad += 5;
  return bad;
}

function hasRequired(kw) {
  const get = keywordGetter(kw);
  return ['$PAR', '$DATATYPE', '$BYTEORD'].every((k) => get(k) !== undefined);
}

export function parseTextSegment(bytes) {
  const str = decodeText(bytes);
  if (str.length < 2) return {};
  const a = splitText(str, true);
  const ka = tokensToKeywords(a.tokens);
  // The standard (escaped) reading wins whenever it is self-consistent.
  if (!ka.odd && hasRequired(ka.kw)) return ka.kw;
  const sa = scoreKeywords(ka.kw, a.delim) + (ka.odd ? 1 : 0);
  const b = splitText(str, false);
  const kb = tokensToKeywords(b.tokens);
  const sb = scoreKeywords(kb.kw, b.delim) + (kb.odd ? 1 : 0);
  return sb < sa ? kb.kw : ka.kw;
}

function intOr(v, d) {
  if (v === undefined || v === null) return d;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : d;
}
function floatOr(v, d) {
  if (v === undefined || v === null) return d;
  const n = parseFloat(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : d;
}

/** Parse a spillover / compensation keyword value into names and matrix. */
export function parseSpillover(value) {
  if (!value) return null;
  const parts = String(value).split(',').map((s) => s.trim());
  const n = parseInt(parts[0], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (parts.length < 1 + n + n * n) return null;
  const names = parts.slice(1, 1 + n);
  const vals = parts.slice(1 + n, 1 + n + n * n).map((s) => parseFloat(s));
  if (vals.some((x) => !Number.isFinite(x))) return null;
  const matrix = [];
  for (let i = 0; i < n; i++) matrix.push(vals.slice(i * n, (i + 1) * n));
  return { names, matrix };
}

function findSpillover(get) {
  for (const key of ['$SPILLOVER', 'SPILL', '$SPILL', 'SPILLOVER']) {
    const v = get(key);
    if (v) {
      const s = parseSpillover(v);
      if (s) return { ...s, keyword: key };
    }
  }
  return null;
}

function byteOrder(str, nbytes) {
  const parts = String(str || '1,2,3,4').split(',').map((s) => parseInt(s.trim(), 10)).filter((x) => Number.isFinite(x));
  if (parts.length === 0) return { little: true, perm: null };
  const little = parts[0] === 1 || (parts.length > 1 && parts[0] < parts[parts.length - 1]);
  // A full permutation for unusual orders such as 3,4,1,2
  let perm = null;
  if (parts.length === nbytes) {
    const isLE = parts.every((p, i) => p === i + 1);
    const isBE = parts.every((p, i) => p === nbytes - i);
    if (!isLE && !isBE) perm = parts.map((p) => p - 1);
  }
  return { little, perm };
}

/**
 * Classify a channel from its name for sensible defaults.
 * Returns 'scatter' | 'time' | 'mass' | 'fluor' | 'other'.
 */
export function classifyChannel(name, label) {
  const n = String(name || '').trim();
  if (/^time$/i.test(n) || /^(hdr-t|time[\s_-]?(lsw|msw)?)$/i.test(n)) return 'time';
  if (/^(b|v|r|y)?-?(fsc|ssc|fs|ss)(\b|[-_ \d]|$)/i.test(n) || /scatter/i.test(n) || /^(fsc|ssc)/i.test(n)) return 'scatter';
  if (/^(event[\s_#-]*(length|num|number|count)?|eventnum|event_length|original_?id|cell[\s_]?id|index|residual|offset|width|center|gaussian.*|cell_length|beadDist)$/i.test(n)) return 'other';
  if (/^\(?[A-Z][a-z]?\d{2,3}\)?D[di]$/.test(n) || /^\d{2,3}[A-Z][a-z]?(_|$)/.test(n)) return 'mass';
  if (/(sample|well|tube)/i.test(n) && !label) return 'other';
  return 'fluor';
}

/**
 * Parse an FCS file.
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{dataset?: number, applyGain?: boolean, maxEvents?: number}} options
 */
export function parseFCS(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { dataset = 0, applyGain = true, maxEvents = 0 } = options;
  if (options.dataset !== undefined && !(Number.isInteger(dataset) && dataset >= 0)) throw new FCSError('Invalid data set index.');
  const warnings = [];

  // Walk the $NEXTDATA chain
  const offsets = [0];
  {
    let base = 0;
    for (let guard = 0; guard < 1000; guard++) {
      let next = 0;
      try {
        const h = readHeader(bytes, base);
        const kw = readKeywords(bytes, base, h, warnings, true);
        next = intOr(keywordGetter(kw)('$NEXTDATA'), 0);
      } catch (e) {
        if (base === 0) throw e;
        break;
      }
      if (next > 0 && base + next + 58 <= bytes.length) {
        base += next;
        offsets.push(base);
      } else break;
    }
  }
  const datasetCount = offsets.length;
  // Without an explicit choice, read the data set with the newest FCS version
  // (Beckman Coulter LMD files carry an FCS 2.0 copy followed by full-resolution FCS 3.0 data).
  let chosen = dataset;
  if (options.dataset === undefined && offsets.length > 1) {
    let best = -1;
    offsets.forEach((off, i) => {
      try {
        const v = parseFloat(readHeader(bytes, off).version.slice(3));
        if (v > best) {
          best = v;
          chosen = i;
        }
      } catch (e) {
        /* ignore unreadable data sets */
      }
    });
  }
  if (chosen >= offsets.length) throw new FCSError(`Data set ${chosen + 1} not found; the file has ${offsets.length}.`);
  const base = offsets[chosen];
  const header = readHeader(bytes, base);
  const keywords = readKeywords(bytes, base, header, warnings, false);
  const get = keywordGetter(keywords);

  const P = intOr(get('$PAR'), 0);
  if (!(P > 0)) throw new FCSError('The file does not declare how many parameters it has ($PAR).');
  const datatype = String(get('$DATATYPE') || '').trim().toUpperCase();
  if (!['I', 'F', 'D', 'A'].includes(datatype)) throw new FCSError(`Unsupported data type "${datatype}" ($DATATYPE).`);
  const mode = String(get('$MODE') || 'L').trim().toUpperCase();
  if (mode !== 'L') throw new FCSError(`Only list-mode data is supported; this file uses $MODE ${mode}.`);

  const totDeclared = intOr(get('$TOT'), -1);

  // Data segment location
  let dStart = header.dataStart;
  let dEnd = header.dataEnd;
  if (dStart === 0 || dEnd === 0 || dEnd < dStart) {
    dStart = intOr(get('$BEGINDATA'), 0);
    dEnd = intOr(get('$ENDDATA'), 0);
  }
  const empty = totDeclared === 0;
  if (!empty) {
    if (!(dEnd >= dStart) || dStart <= 0) throw new FCSError('Could not find the data segment in this file.');
    dStart += base;
    dEnd += base;
    if (dEnd >= bytes.length) {
      warnings.push('The data segment extends past the end of the file; the file may be truncated.');
      dEnd = bytes.length - 1;
    }
  }

  // Parameters
  const channels = [];
  for (let p = 1; p <= P; p++) {
    const name = String(get(`$P${p}N`) ?? `P${p}`).trim();
    const label = String(get(`$P${p}S`) ?? '').trim();
    // FCS 3.2: $PnDATATYPE overrides $DATATYPE for one parameter (I, F or D)
    const own = String(get(`$P${p}DATATYPE`) ?? '').trim().toUpperCase();
    const type = datatype !== 'A' && ['I', 'F', 'D'].includes(own) ? own : datatype;
    const bitsRaw = String(get(`$P${p}B`) ?? '').trim();
    const bits = bitsRaw === '*' ? '*' : intOr(bitsRaw, type === 'F' ? 32 : type === 'D' ? 64 : 16);
    const range = floatOr(get(`$P${p}R`), 0);
    const ampStr = String(get(`$P${p}E`) ?? '0,0');
    const ampParts = ampStr.split(',').map((s) => parseFloat(s));
    let f1 = Number.isFinite(ampParts[0]) ? ampParts[0] : 0;
    let f2 = Number.isFinite(ampParts[1]) ? ampParts[1] : 0;
    if (f1 > 0 && f2 === 0) f2 = 1;
    const gain = floatOr(get(`$P${p}G`), 1);
    const voltage = floatOr(get(`$P${p}V`), null);
    const display = String(get(`$P${p}D`) ?? '').trim();
    channels.push({
      index: p - 1,
      name,
      label,
      type,
      bits,
      range,
      amp: [f1, f2],
      gain,
      voltage,
      display,
      kind: classifyChannel(name, label),
    });
  }

  let columns;
  let nEvents;

  if (empty) {
    columns = channels.map(() => new Float32Array(0));
    nEvents = 0;
  } else if (datatype === 'A') {
    ({ columns, nEvents } = readAscii(bytes, dStart, dEnd, channels, totDeclared));
  } else {
    ({ columns, nEvents } = readBinary(bytes, dStart, dEnd, channels, datatype, get('$BYTEORD'), totDeclared, warnings));
  }

  if (datasetCount > 1) warnings.push(`This file contains ${datasetCount} data sets; showing data set ${chosen + 1} (${header.version}).`);

  if (maxEvents > 0 && nEvents > maxEvents) {
    columns = columns.map((c) => c.slice(0, maxEvents));
    nEvents = maxEvents;
    warnings.push(`Loaded the first ${maxEvents.toLocaleString()} events only.`);
  }

  // Channel value conversion
  for (const ch of channels) {
    const col = columns[ch.index];
    const [f1, f2] = ch.amp;
    if (f1 > 0 && (ch.type === 'I' || ch.type === 'A')) {
      const r = ch.range > 0 ? ch.range : Math.pow(2, typeof ch.bits === 'number' ? ch.bits : 16);
      const k = f1 / r;
      for (let i = 0; i < nEvents; i++) col[i] = Math.pow(10, k * col[i]) * f2;
      ch.logAmplified = true;
      ch.originalRange = ch.range;
      ch.range = f2 * Math.pow(10, f1);
    } else if (f1 > 0) {
      warnings.push(`${ch.name}: ignored log amplification for floating point data.`);
    } else if (applyGain && ch.gain && ch.gain !== 1 && ch.gain > 0 && ch.kind !== 'time') {
      const g = 1 / ch.gain;
      for (let i = 0; i < nEvents; i++) col[i] *= g;
      ch.gainApplied = ch.gain;
    }
  }

  // Observed min / max per channel (cheap, useful for defaults)
  for (const ch of channels) {
    const col = columns[ch.index];
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < nEvents; i++) {
      const v = col[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    ch.min = nEvents ? mn : 0;
    ch.max = nEvents ? mx : 0;
    if (!(ch.range > 0)) ch.range = mx > 0 ? mx : 1;
  }

  const spillover = findSpillover(get);

  return {
    version: header.version,
    keywords,
    channels,
    nEvents,
    columns,
    spillover,
    datasetCount,
    datasetIndex: chosen,
    warnings,
  };
}

function readKeywords(bytes, base, h, warnings, quiet) {
  let tStart = h.textStart;
  let tEnd = h.textEnd;
  if (!(tEnd > tStart) || base + tEnd >= bytes.length) {
    throw new FCSError('The TEXT segment offsets in the header are invalid.');
  }
  const kw = parseTextSegment(bytes.subarray(base + tStart, base + tEnd + 1));
  const get = keywordGetter(kw);
  // Supplemental TEXT
  const sStart = intOr(get('$BEGINSTEXT'), 0);
  const sEnd = intOr(get('$ENDSTEXT'), 0);
  if (sStart > 0 && sEnd > sStart && base + sEnd < bytes.length && (sStart > tEnd || sEnd < tStart)) {
    try {
      const sup = parseTextSegment(bytes.subarray(base + sStart, base + sEnd + 1));
      for (const k of Object.keys(sup)) if (!(k in kw)) kw[k] = sup[k];
    } catch (e) {
      if (!quiet) warnings.push('Could not read the supplemental TEXT segment.');
    }
  }
  return kw;
}

function readBinary(bytes, dStart, dEnd, channels, datatype, byteord, totDeclared, warnings) {
  const P = channels.length;
  const types = channels.map((ch) => ch.type || datatype);
  const widths = channels.map((ch, p) => {
    if (types[p] === 'F') return 4;
    if (types[p] === 'D') return 8;
    const b = ch.bits;
    if (typeof b !== 'number' || b % 8 !== 0 || b <= 0 || b > 64) {
      throw new FCSError(`${ch.name}: ${b}-bit integer values are not supported.`);
    }
    return b / 8;
  });
  const eventBytes = widths.reduce((a, b) => a + b, 0);
  const available = dEnd - dStart + 1;
  let n = Math.floor(available / eventBytes);
  if (totDeclared >= 0) {
    if (totDeclared > n) {
      // Some writers record ENDDATA exclusively; allow one byte of slack.
      const n2 = Math.floor((available + 1) / eventBytes);
      if (totDeclared <= n2 && dStart + totDeclared * eventBytes <= bytes.length) n = totDeclared;
      else warnings.push(`File declares ${totDeclared} events but only ${n} are present.`);
    } else n = totDeclared;
  }
  const columns = channels.map(() => new Float32Array(n));
  if (n === 0) return { columns, nEvents: 0 };

  const uniform = widths.every((w) => w === widths[0]) && types.every((t) => t === types[0]);
  const w0 = widths[0];
  datatype = types[0];
  const order = byteOrder(byteord, w0);
  const nbytes = n * eventBytes;

  // Copy into an aligned buffer, normalising byte order to little endian
  const buf = new ArrayBuffer(nbytes);
  const u8 = new Uint8Array(buf);
  u8.set(bytes.subarray(dStart, dStart + nbytes));

  if (uniform && (datatype === 'F' || datatype === 'D' || w0 === 2 || w0 === 4 || w0 === 1)) {
    if (w0 > 1) normaliseOrder(u8, w0, order);
    let view;
    if (datatype === 'F') view = new Float32Array(buf);
    else if (datatype === 'D') view = new Float64Array(buf);
    else if (w0 === 1) view = u8;
    else if (w0 === 2) view = new Uint16Array(buf);
    else view = new Uint32Array(buf);
    const masks = datatype === 'I' ? channels.map((ch) => intMask(ch, w0 * 8)) : null;
    for (let p = 0; p < P; p++) {
      const col = columns[p];
      const m = masks ? masks[p] : 0;
      if (m) {
        for (let i = 0, k = p; i < n; i++, k += P) col[i] = (view[k] & m) >>> 0;
      } else {
        for (let i = 0, k = p; i < n; i++, k += P) col[i] = view[k];
      }
    }
    return { columns, nEvents: n };
  }

  // Generic path: mixed widths or mixed data types (FCS 3.2)
  const dv = new DataView(buf);
  const little = order.little;
  const offs = [];
  let acc = 0;
  for (const w of widths) { offs.push(acc); acc += w; }
  const masks = channels.map((ch, p) => (types[p] === 'I' ? intMask(ch, widths[p] * 8) : 0));
  for (let i = 0; i < n; i++) {
    const base = i * eventBytes;
    for (let p = 0; p < P; p++) {
      const o = base + offs[p];
      if (types[p] === 'F') {
        columns[p][i] = dv.getFloat32(o, little);
        continue;
      }
      if (types[p] === 'D') {
        columns[p][i] = dv.getFloat64(o, little);
        continue;
      }
      let v;
      switch (widths[p]) {
        case 1: v = dv.getUint8(o); break;
        case 2: v = dv.getUint16(o, little); break;
        case 4: v = dv.getUint32(o, little); break;
        case 8: v = Number(dv.getBigUint64(o, little)); break;
        default: {
          v = 0;
          const w = widths[p];
          for (let b = 0; b < w; b++) {
            const byte = dv.getUint8(o + b);
            v += byte * Math.pow(256, little ? b : w - 1 - b);
          }
        }
      }
      const m = masks[p];
      if (m && widths[p] <= 4) v = (v & m) >>> 0;
      columns[p][i] = v;
    }
  }
  return { columns, nEvents: n };
}

function intMask(ch, bits) {
  // Mask unused high bits when the declared range needs fewer bits
  const r = ch.range;
  if (!(r > 0) || bits > 32) return 0;
  const need = Math.ceil(Math.log2(r));
  if (need >= bits || need <= 0) return 0;
  return (Math.pow(2, need) - 1) >>> 0;
}

function normaliseOrder(u8, w, order) {
  const n = u8.length;
  if (order.perm) {
    const perm = order.perm;
    const tmp = new Uint8Array(w);
    for (let i = 0; i < n; i += w) {
      for (let b = 0; b < w; b++) tmp[perm[b]] = u8[i + b];
      for (let b = 0; b < w; b++) u8[i + b] = tmp[b];
    }
    return;
  }
  if (order.little) return;
  for (let i = 0; i < n; i += w) {
    for (let a = i, b = i + w - 1; a < b; a++, b--) {
      const t = u8[a];
      u8[a] = u8[b];
      u8[b] = t;
    }
  }
}

function readAscii(bytes, dStart, dEnd, channels, totDeclared) {
  const P = channels.length;
  const text = latin1.decode(bytes.subarray(dStart, dEnd + 1));
  const delimited = channels.some((ch) => ch.bits === '*');
  let values;
  if (delimited) {
    values = text.split(/[\s,]+/).filter((s) => s.length > 0).map(Number);
  } else {
    values = [];
    let pos = 0;
    const widths = channels.map((ch) => ch.bits);
    const clean = text.replace(/[\r\n]/g, '');
    while (pos < clean.length) {
      for (let p = 0; p < P && pos < clean.length; p++) {
        values.push(Number(clean.substr(pos, widths[p])));
        pos += widths[p];
      }
    }
  }
  let n = Math.floor(values.length / P);
  if (totDeclared >= 0 && totDeclared < n) n = totDeclared;
  const columns = channels.map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let p = 0; p < P; p++) columns[p][i] = values[i * P + p];
  return { columns, nEvents: n };
}

/** A small, display-friendly subset of keywords. */
export function summaryKeywords(keywords) {
  const get = keywordGetter(keywords);
  const pick = ['$FIL', '$DATE', '$BTIM', '$ETIM', '$CYT', '$CYTSN', '$SRC', '$OP', '$INST', 'TUBE NAME', 'EXPERIMENT NAME', '$PROJ', '$SMNO', '$WELLID', '$PLATENAME'];
  const out = {};
  for (const k of pick) {
    const v = get(k);
    if (v !== undefined && String(v).trim() !== '') out[k] = String(v).trim();
  }
  return out;
}
