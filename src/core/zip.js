// Minimal ZIP writer (stored entries, no compression). Used to bundle exports
// such as several FCS files, or file types a host may not save directly.

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return enc.encode(String(data));
}

/**
 * @param {{name:string, data:Uint8Array|ArrayBuffer|string}[]} files
 * @returns {Uint8Array}
 */
export function makeZip(files, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const entries = [];
  let offset = 0;
  const used = new Set();
  for (const f of files) {
    let name = String(f.name).replace(/^\/+/, '');
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      let k = 2;
      let cand;
      do {
        cand = dot > 0 ? `${name.slice(0, dot)} (${k})${name.slice(dot)}` : `${name} (${k})`;
        k++;
      } while (used.has(cand));
      name = cand;
    }
    used.add(name);
    const nameBytes = enc.encode(name);
    const data = toBytes(f.data);
    const crc = crc32(data);
    entries.push({ nameBytes, data, crc, offset });
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = entries.reduce((a, e) => a + 46 + e.nameBytes.length, 0);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  for (const e of entries) {
    dv.setUint32(p, 0x04034b50, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 0x0800, true);
    dv.setUint16(p + 8, 0, true);
    dv.setUint16(p + 10, time, true);
    dv.setUint16(p + 12, day, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.data.length, true);
    dv.setUint32(p + 22, e.data.length, true);
    dv.setUint16(p + 26, e.nameBytes.length, true);
    dv.setUint16(p + 28, 0, true);
    out.set(e.nameBytes, p + 30);
    out.set(e.data, p + 30 + e.nameBytes.length);
    p += 30 + e.nameBytes.length + e.data.length;
  }
  const cdStart = p;
  for (const e of entries) {
    dv.setUint32(p, 0x02014b50, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 20, true);
    dv.setUint16(p + 8, 0x0800, true);
    dv.setUint16(p + 10, 0, true);
    dv.setUint16(p + 12, time, true);
    dv.setUint16(p + 14, day, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.data.length, true);
    dv.setUint32(p + 24, e.data.length, true);
    dv.setUint16(p + 28, e.nameBytes.length, true);
    dv.setUint16(p + 30, 0, true);
    dv.setUint16(p + 32, 0, true);
    dv.setUint16(p + 34, 0, true);
    dv.setUint16(p + 36, 0, true);
    dv.setUint32(p + 38, 0, true);
    dv.setUint32(p + 42, e.offset, true);
    out.set(e.nameBytes, p + 46);
    p += 46 + e.nameBytes.length;
  }
  dv.setUint32(p, 0x06054b50, true);
  dv.setUint16(p + 4, 0, true);
  dv.setUint16(p + 6, 0, true);
  dv.setUint16(p + 8, entries.length, true);
  dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, cdSize, true);
  dv.setUint32(p + 16, cdStart, true);
  dv.setUint16(p + 20, 0, true);
  return out;
}

/** Read a stored or deflated ZIP (stored entries only are decoded here). */
export function listZip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const lnlen = dv.getUint16(loff + 26, true);
    const lxlen = dv.getUint16(loff + 28, true);
    const start = loff + 30 + lnlen + lxlen;
    out.push({ name, method, data: method === 0 ? u8.slice(start, start + csize) : null, compressed: method !== 0 ? u8.slice(start, start + csize) : null });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
