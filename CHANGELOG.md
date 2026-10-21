# Changelog

## 0.1.1

- Kestrel logo: pencil-sketch kestrel in flight.
- Gating-path (backgating) strip in the Gating view: every gate from ungated FSC-A × SSC-A to the selected population.
- Batch tab: every gating plot for every sample.
- The compensation matrix shows only parameters present in the workspace's files.
- Dot size is a typed integer (not just preset buttons) and can be set per plot, overriding the default from any plot's options menu.
- Concatenate samples: pool events from several samples into one plot, for pseudocolour, dot, contour and histogram plots alike.
- Batch and Layout views now keep every visible sample's gate counts current, not only the sample last viewed in Gating.
- Layout view: toggle whether plot titles and axis labels are drawn on each panel, for a tighter grid when panels are laid out consistently.
- Relabel any parameter from the axis picker (the pencil next to each one) when its FCS file didn't carry a label, or to rename it to something else ("CD4" for "FITC-A"). The label applies everywhere that parameter is shown, and saves with the workspace and with templates.
- Double-click a `.kestrel.json` workspace to open it, once associated with the included Windows launcher. See [Open workspace files by double-clicking](README.md#open-workspace-files-by-double-clicking-windows).
- The sidebar (Samples and Populations) can be dragged wider or narrower by its right edge, double-click to reset; the width is remembered. Sample names that don't fit shrink to a smaller size instead of being cut off with an ellipsis.
- The per-plot dot size popover is now sized to its content instead of a fixed box, so it never scrolls.

## 0.1.0

First release: FCS 2.0–3.2 reader, compensation (acquisition, computed from single stains, editable), linear/log/Logicle/Hyperlog/arcsinh scales, ratio parameters, rectangle/polygon/ellipse/quadrant/range/split/Boolean gates with drill-down, polygon conversion, per-sample adjustments, axis-title parameter menus, statistics table, batch layouts, autosaved workspaces, workflow templates, Gating-ML 2.0 import/export, FCS/CSV population export, headless batch runner.
