// Main-thread side of the compute engine: a pool of Web Workers, each owning
// a subset of samples. Falls back to an in-process engine when workers are
// unavailable (for example under a strict Content Security Policy).

import { Engine } from './engine.js';

export class EngineClient {
  /**
   * @param {{workerSource?: string, maxWorkers?: number, forceLocal?: boolean}} opts
   */
  constructor({ workerSource = '', maxWorkers = 8, forceLocal = false } = {}) {
    this.workers = [];
    this.pending = new Map();
    this.rid = 0;
    this.assignments = new Map();
    this.loads = [];
    this.local = null;
    this.readyPromise = this.start(workerSource, maxWorkers, forceLocal);
    this.listeners = new Set();
    this.inflight = 0;
  }

  async start(src, maxWorkers, forceLocal) {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.max(1, Math.min(maxWorkers, cores > 2 ? cores - 1 : cores));
    if (!forceLocal && src && typeof Worker !== 'undefined') {
      try {
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const ready = [];
        for (let i = 0; i < n; i++) {
          const w = new Worker(url);
          ready.push(
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(false), 4000);
              w.onmessage = (e) => {
                if (e.data && e.data.ready) {
                  clearTimeout(timer);
                  w.onmessage = (ev) => this.onMessage(ev.data);
                  resolve(true);
                }
              };
              w.onerror = () => {
                clearTimeout(timer);
                resolve(false);
              };
            }),
          );
          this.workers.push(w);
          this.loads.push(0);
        }
        const ok = await Promise.all(ready);
        if (!ok.every(Boolean)) throw new Error('worker start failed');
      } catch (e) {
        for (const w of this.workers) {
          try {
            w.terminate();
          } catch (err) {
            /* ignore */
          }
        }
        this.workers = [];
        this.loads = [];
      }
    }
    if (this.workers.length === 0) this.local = new Engine();
    return this.describe();
  }

  ready() {
    return this.readyPromise;
  }

  describe() {
    return this.local ? { mode: 'main', workers: 0 } : { mode: 'workers', workers: this.workers.length };
  }

  onBusy(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitBusy() {
    for (const fn of this.listeners) fn(this.inflight);
  }

  onMessage(msg) {
    const p = this.pending.get(msg.rid);
    if (!p) return;
    this.pending.delete(msg.rid);
    this.inflight--;
    this.emitBusy();
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  /** Choose the least-loaded worker for a new sample. */
  assign(sampleId, weight = 1) {
    if (this.assignments.has(sampleId)) return this.assignments.get(sampleId);
    if (this.local) {
      this.assignments.set(sampleId, 0);
      return 0;
    }
    let best = 0;
    for (let i = 1; i < this.loads.length; i++) if (this.loads[i] < this.loads[best]) best = i;
    this.loads[best] += weight;
    this.assignments.set(sampleId, best);
    return best;
  }

  release(sampleId, weight = 1) {
    const w = this.assignments.get(sampleId);
    if (w === undefined) return;
    this.assignments.delete(sampleId);
    if (!this.local) this.loads[w] = Math.max(0, this.loads[w] - weight);
  }

  workerFor(sampleId) {
    const w = this.assignments.get(sampleId);
    if (w === undefined) throw new Error('Sample is not assigned to a worker.');
    return w;
  }

  post(workerIndex, type, payload, transfer = []) {
    this.inflight++;
    this.emitBusy();
    if (this.local) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            const { result } = this.local.handle(type, payload);
            this.inflight--;
            this.emitBusy();
            resolve(result);
          } catch (e) {
            this.inflight--;
            this.emitBusy();
            reject(e);
          }
        }, 0);
      });
    }
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      try {
        this.workers[workerIndex].postMessage({ rid, type, payload }, transfer);
      } catch (e) {
        this.pending.delete(rid);
        this.inflight--;
        this.emitBusy();
        reject(e);
      }
    });
  }

  /** Send a command to the worker that owns a sample. */
  call(sampleId, type, payload = {}, transfer = []) {
    return this.post(this.workerFor(sampleId), type, { id: sampleId, ...payload }, transfer);
  }

  /** Send the same command to every worker. */
  broadcast(type, payload = {}) {
    if (this.local) return this.post(0, type, payload).then((r) => [r]);
    return Promise.all(this.workers.map((_, i) => this.post(i, type, payload)));
  }

  /** Any worker (round robin); for stateless jobs such as generating data. */
  any(type, payload = {}) {
    if (this.local) return this.post(0, type, payload);
    const i = this.rid % this.workers.length;
    return this.post(i, type, payload);
  }
}
