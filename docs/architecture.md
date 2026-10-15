# Architecture

```
main thread (Preact UI)                         Web Workers (one per core, max 8)
  store: doc (analysis) + ui + meta  ──flush──▶  Engine: samples, compensation,
  bridge.js: sync + requests        ◀─results──   transforms, gates, plots, stats
  persist.js: IndexedDB autosave
```

- **`src/core/`** pure functions: FCS parsing/writing, transforms (Logicle, Hyperlog, arcsinh, log, linear), compensation, gate evaluation and geometry, Gating-ML, statistics, CSV, ZIP, XML. No dependencies.
- **`src/engine/engine.js`** holds event data for the samples assigned to a worker and answers commands (`load`, `setTransforms`, `setComp`, `setGates`, `plot`, `stats`, `counts`, `exportFCS`…). Results are cached by signatures of everything they depend on (compensation, transforms, gate geometry), so moving one gate recomputes only its descendants.
- **`src/engine/client.js`** runs the worker pool (the worker source is bundled into the HTML and started from a Blob URL, so `file://` works) and falls back to the main thread when workers are unavailable. Samples go to the least-loaded worker.
- **`src/engine/batch.js`** uses the same engine headlessly to apply a template to files.
- **`src/ui/state/`** the document model (`doc.js`, with undo/redo of analysis state), derived values, engine bridge, persistence (autosave debounced 0.7 s and on view changes), loader and templates.
- **`src/ui/plot/`** canvas rendering of density/dot/contour/histogram plots and gates, interactive editing, axis menus, PNG/SVG export.
- **`scripts/build.mjs`** bundles everything with esbuild into `dist/kestrel.html`.
