// Finding a workspace's data files after the workspace itself was opened from
// a file: a .kestrel.json lists its samples' file names, not their (large) data.
// Files are matched to samples by name, without regard to case.

import { store } from './store.js';
import { toast } from './doc.js';
import { addFiles } from './loader.js';

/** Samples whose data file isn't loaded. */
export function missingSamples(s = store.get()) {
  return s.doc.samples.filter((x) => (s.meta[x.id] || {}).status === 'missing' && !(x.source && x.source.type === 'demo'));
}

/**
 * Load whichever of `files` (File or Blob with a name) belong to a sample that
 * is missing its data. A file is renamed to the name the workspace knows it
 * by, so "pbmc_donor01.FCS" on disk still lands on "PBMC_Donor01.fcs".
 * Returns how many were matched.
 */
export async function loadMatching(files) {
  const want = new Map(missingSamples().map((smp) => [smp.fileName.toLowerCase(), smp.fileName]));
  const picked = [];
  const seen = new Set();
  for (const f of files) {
    const key = (f.name || '').toLowerCase();
    if (!want.has(key) || seen.has(key)) continue;
    seen.add(key);
    const name = want.get(key);
    picked.push(f.name === name && f instanceof File ? f : new File([f], name, { type: f.type || 'application/octet-stream', lastModified: f.lastModified || Date.now() }));
  }
  if (picked.length) await addFiles(picked);
  return picked.length;
}

/**
 * Let the person choose a folder, and collect the files in it (and in its
 * subfolders, a few levels down) whose names match a missing sample. Uses the
 * File System Access API where the browser has it, which reads only the
 * matching files; otherwise a folder-upload file input.
 * Resolves to an array of Files, or null if the person cancelled.
 */
export async function pickFolderMatches(maxDepth = 3) {
  const want = new Set(missingSamples().map((smp) => smp.fileName.toLowerCase()));
  if (typeof window.showDirectoryPicker === 'function') {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'kestrel-data', mode: 'read' });
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      dir = null; // blocked here (e.g. in a sandboxed frame): fall through to the input
    }
    if (dir) {
      const out = [];
      const walk = async (handle, depth) => {
        for await (const entry of handle.values()) {
          if (entry.kind === 'file') {
            if (want.has(entry.name.toLowerCase())) out.push(await entry.getFile());
          } else if (depth < maxDepth && !entry.name.startsWith('.')) {
            await walk(entry, depth + 1);
          }
        }
      };
      await walk(dir, 0);
      return out;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files || [])].filter((f) => want.has(f.name.toLowerCase()))));
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

/**
 * The "open with Kestrel" launcher (scripts/open-workspace.mjs) looks for the
 * workspace's data files next to it and serves the ones it finds. Fetch and
 * load them, then tell the launcher it can exit. Resolves to the launcher's
 * manifest ({dir, found, missing}) or null if it has none.
 */
export async function loadFromLauncher() {
  let manifest = null;
  try {
    const res = await fetch('/__manifest', { cache: 'no-store' });
    if (res.ok) manifest = await res.json();
  } catch (e) {
    manifest = null;
  }
  let files = [];
  try {
    if (manifest && manifest.found && manifest.found.length) {
      const n = manifest.found.length;
      toast(`Loading ${n} data file${n > 1 ? 's' : ''} found next to the workspace…`);
      files = await Promise.all(
        manifest.found.map(async (name) => {
          try {
            const r = await fetch(`/__data/${encodeURIComponent(name)}`, { cache: 'no-store' });
            if (!r.ok) return null;
            return new File([await r.blob()], name, { type: 'application/octet-stream' });
          } catch (e) {
            return null;
          }
        }),
      );
    }
  } finally {
    // Everything the launcher has is in hand; its console window closes as
    // soon as it hears this (reading the files happens here, in the page).
    fetch('/__done', { cache: 'no-store' }).catch(() => {});
  }
  if (files.length) await loadMatching(files.filter(Boolean));
  return manifest;
}
