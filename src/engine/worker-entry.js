// Web Worker entry point: one Engine per worker.
import { Engine } from './engine.js';

const engine = new Engine();

self.onmessage = (e) => {
  const { rid, type, payload } = e.data || {};
  try {
    const { result, transfer } = engine.handle(type, payload);
    self.postMessage({ rid, ok: true, result }, transfer || []);
  } catch (err) {
    self.postMessage({ rid, ok: false, error: (err && err.message) || String(err) });
  }
};

self.postMessage({ ready: true });
