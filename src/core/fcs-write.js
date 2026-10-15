// FCS 3.1 writer (32-bit float, list mode).

const STRUCTURAL = new Set([
  '$BEGINANALYSIS', '$ENDANALYSIS', '$BEGINSTEXT', '$ENDSTEXT', '$BEGINDATA', '$ENDDATA',
  '$NEXTDATA', '$PAR', '$TOT', '$DATATYPE', '$BYTEORD', '$MODE', '$COMP', '$UNICODE',
  '$SPILLOVER', 'SPILL', '$SPILL', 'SPILLOVER', '$CRC',
]);

const littleEndianPlatform = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const encoder = new TextEncoder();

function esc(s, d) {
  let v = String(s);
  if (v.length === 0) v = ' ';
  return v.split(d).join(d + d);
}

function pad8(n) {
  const s = String(n);
  if (s.length > 8) throw new Error('Header offset too large');
  return ' '.repeat(8 - s.length) + s;
}

/** Serialise a spillover matrix as the $SPILLOVER keyword value. */
export function spilloverToString({ names, matrix }) {
  const parts = [String(names.length), ...names];
  for (const row of matrix) for (const v of row) parts.push(fmt(v));
  return parts.join(',');
}

function fmt(v) {
  if (!Number.isFinite(v)) return '0';
  if (v === 0) return '0';
  return String(Number(v.toPrecision(8)));
}

/**
 * @param {object} o
 * @param {{name:string,label?:string,range?:number,voltage?:number,display?:string}[]} o.channels
 * @param {Float32Array[]} o.columns  one column per channel (full length)
 * @param {number} o.nEvents          length of the columns
 * @param {Uint32Array|null} [o.indices] optional event subset
 * @param {object} [o.keywords]       original keywords to carry over
 * @param {{names:string[],matrix:number[][]}|null} [o.spillover]
 * @param {object} [o.extra]          additional keywords
 * @returns {Uint8Array}
 */
export function writeFCS({ channels, columns, nEvents, indices = null, keywords = {}, spillover = null, extra = {} }) {
  const P = channels.length;
  const n = indices ? indices.length : nEvents;
  const data = new Float32Array(n * P);
  for (let p = 0; p < P; p++) {
    const col = columns[p];
    if (indices) for (let i = 0, k = p; i < n; i++, k += P) data[k] = col[indices[i]];
    else for (let i = 0, k = p; i < n; i++, k += P) data[k] = col[i];
  }
  const dataBytes = new Uint8Array(data.buffer);

  const kw = new Map();
  for (const [k, v] of Object.entries(keywords || {})) {
    const K = k.toUpperCase();
    if (STRUCTURAL.has(K)) continue;
    if (/^\$?P\d+[A-Z_]+$/.test(K)) continue; // parameter keywords are regenerated
    if (v === undefined || v === null) continue;
    kw.set(k, String(v));
  }
  kw.set('$BYTEORD', littleEndianPlatform ? '1,2,3,4' : '4,3,2,1');
  kw.set('$DATATYPE', 'F');
  kw.set('$MODE', 'L');
  kw.set('$NEXTDATA', '0');
  kw.set('$PAR', String(P));
  kw.set('$TOT', String(n));
  kw.set('$BEGINANALYSIS', '0');
  kw.set('$ENDANALYSIS', '0');
  kw.set('$BEGINSTEXT', '0');
  kw.set('$ENDSTEXT', '0');
  channels.forEach((ch, i) => {
    const p = i + 1;
    kw.set(`$P${p}N`, ch.name);
    if (ch.label) kw.set(`$P${p}S`, ch.label);
    kw.set(`$P${p}B`, '32');
    kw.set(`$P${p}E`, '0,0');
    const r = ch.range > 0 ? ch.range : 262144;
    kw.set(`$P${p}R`, String(Math.round(r)));
    if (Number.isFinite(ch.voltage)) kw.set(`$P${p}V`, String(ch.voltage));
    if (ch.display) kw.set(`$P${p}D`, ch.display);
  });
  if (spillover && spillover.names && spillover.names.length) kw.set('$SPILLOVER', spilloverToString(spillover));
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) kw.set(k, String(v));

  const delim = '|';
  const build = () => {
    let s = delim;
    for (const [k, v] of kw) s += esc(k, delim) + delim + esc(v, delim) + delim;
    return encoder.encode(s);
  };

  const textStart = 58;
  let begin = 0;
  let end = 0;
  let text;
  for (let iter = 0; iter < 12; iter++) {
    kw.set('$BEGINDATA', String(begin));
    kw.set('$ENDDATA', String(end));
    text = build();
    const textEnd = textStart + text.length - 1;
    const nb = n > 0 ? textEnd + 1 : 0;
    const ne = n > 0 ? nb + dataBytes.length - 1 : 0;
    if (nb === begin && ne === end) break;
    begin = nb;
    end = ne;
  }
  const textEnd = textStart + text.length - 1;
  const big = end > 99999999;
  const header =
    'FCS3.1    ' +
    pad8(textStart) + pad8(textEnd) +
    pad8(big ? 0 : begin) + pad8(big ? 0 : end) +
    pad8(0) + pad8(0);
  const headerBytes = encoder.encode(header);
  const crc = encoder.encode('00000000');
  const out = new Uint8Array(headerBytes.length + text.length + dataBytes.length + crc.length);
  out.set(headerBytes, 0);
  out.set(text, textStart);
  out.set(dataBytes, textEnd + 1);
  out.set(crc, textEnd + 1 + dataBytes.length);
  return out;
}
