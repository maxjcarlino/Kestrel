# Workflow templates and workspace files

Kestrel saves two kinds of JSON file.

| File | Contains | Used for |
| --- | --- | --- |
| `*.template.json` (`"format": "kestrel-template"`) | scales, compensation choice and matrices, ratio parameters, gates, plots, statistics columns, layout, display settings, group names | applying the same analysis to new data |
| `*.kestrel.json` (`"format": "kestrel-workspace"`) | everything in a template plus the sample list, groups, per-sample gate adjustments and per-sample compensation | moving or sharing a whole workspace (data files are added separately) |

## Template fields

- `transforms`: `{ channel: spec }`. Specs: `{type:"linear",min,max}`, `{type:"log",max,decades}`, `{type:"logicle",T,W,M,A}`, `{type:"hyperlog",T,W,M,A}`, `{type:"arcsinh",cofactor,min,max}`.
- `comp`: `{ matrices: [{id,name,names,matrix}], default: "file" | "none" | matrixId }`. `matrix` is a spillover matrix (rows = fluorochromes, columns = detectors).
- `derived`: ratio parameters `{name, kind:"ratio", x, y, A, B, C}` = A·(x − B)/(y − C).
- `gates`: a list in dependency order. Every gate has `id, name, parent ("root" for top level), type, color`, plus geometry in data units (compensated values):
  - `rect`: `{x0,x1,y0,y1}`, `null` = open edge; `range`: `{lo,hi}` on `x` only
  - `polygon`: `[[x,y],…]`; `ellipse`: `{c,a,b}` (centre and ends of the two semi-axes)
  - `boolean`: `{op:"and"|"or", refs:[{id,not}]}`
  - `link`: `{kind:"quad"|"split", group, role}` ties quadrant and split members together
  - `scale` (optional, polygon/ellipse): `{x:spec,y:spec}` evaluates the gate on its own scales instead of the plot's
- `plots`, `table.columns`, `layout`, `settings`: what the views show.

Rectangles and ranges are evaluated in data units; polygons and ellipses in display-scale space, so what you see on the plot is what is gated (as in Gating-ML 2.0).

Apply a template in the app (workspace menu → *Apply template to these samples*, or drop the file on the window) or headlessly with `node scripts/kestrel-batch.mjs -t file.template.json data/`.
