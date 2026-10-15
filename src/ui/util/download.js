// Saving files. Inside a hosted artifact the page asks the viewer through the
// `downloads` capability (only some file types are allowed, so others are
// wrapped in a .zip); a standalone copy uses an ordinary download link.

import { makeZip } from '../../core/zip.js';

const ALLOWED = new Set(['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mov', 'txt', 'json', 'md', 'docx', 'pptx', 'epub', 'csv', 'ttf', 'html', 'svg', 'pdf', 'xlsx', 'zip']);

let dlPromise = null;

export function hostedArtifact() {
  return typeof window !== 'undefined' && !!(window.claude && typeof window.claude.use === 'function');
}

function getDownloads() {
  if (!hostedArtifact()) return Promise.resolve(null);
  if (!dlPromise) {
    dlPromise = Promise.resolve()
      .then(() => window.claude.use('downloads'))
      .catch(() => null);
  }
  return dlPromise;
}

export function prewarmDownloads() {
  getDownloads();
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return null;
}

const MIME = { json: 'application/json', csv: 'text/csv', svg: 'image/svg+xml', png: 'image/png', xml: 'application/xml', fcs: 'application/vnd.isac.fcs', zip: 'application/zip', txt: 'text/plain' };

/**
 * Offer a file to the user.
 * @returns {Promise<{ok:boolean, wrapped?:boolean, code?:string, message?:string}>}
 */
export async function saveFile(filename, data) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const dl = await getDownloads();
  if (dl) {
    let name = filename;
    let payload = data;
    let wrapped = false;
    if (!ALLOWED.has(ext)) {
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : toBytes(data);
      payload = new Blob([makeZip([{ name: filename, data: bytes }])], { type: 'application/zip' });
      name = filename.replace(/\.[^.]+$/, '') + '.zip';
      wrapped = true;
    } else if (!(payload instanceof Blob)) {
      payload = new Blob([payload], { type: MIME[ext] || 'application/octet-stream' });
    }
    try {
      await dl.save({ filename: name, data: payload });
      return { ok: true, wrapped };
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'unavailable', message: (e && e.message) || String(e) };
    }
  }
  try {
    const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext] || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'unavailable', message: e.message || String(e) };
  }
}

/**
 * A portable file name: ASCII only (some browsers drop non-ASCII download
 * names), no characters that are illegal on common file systems.
 */
export function safeName(s) {
  let t = String(s || 'export').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  t = t
    .replace(/[\u00b7\u2022\u2219]/g, '-')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00b5\u03bc]/g, 'u')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/(\s*-\s*){2,}/g, ' - ')
    .trim();
  return t.slice(0, 120) || 'export';
}

/** Read a user-chosen file as text. */
export function readText(file) {
  return file.text();
}

/** Open a file picker and resolve with the chosen files. */
export function pickFiles({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files || [])]));
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}
