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
- Layout and Batch: add a gating-hierarchy panel ("Add gating hierarchy" in the Layout sidebar) showing every population under a chosen root, one per sample, with configurable columns (count, % parent, % grandparent, % total).
- Inspector: "Gate labels show" gained a % grandparent option, alongside % parent, % total and count, for the label drawn next to each gate.
- A gate's right-click menu gained "Apply ⟨sample⟩'s version to other samples…", to copy one sample's adjusted gate (position, shape, and any linked gates such as quadrant parts) onto a chosen set of other samples at once, as each one's own adjustment — without touching the shared gate or any sample not picked.
- Double-click launcher: also loads the workspace's data files when they're in the same folder (or its subfolders; names match regardless of case). Files it can't find bring up a "Find this workspace's data files" dialog to choose the folder they're in, which closes itself once everything is loaded. The same dialog appears when a workspace file is dropped without its data, and from the Samples panel's "Find them…" link.
- Double-click launcher: a double-clicked workspace opens straight away instead of after the last workspace has loaded; the helper's console window starts minimized and closes by itself as soon as the browser has the files (errors show in a message box rather than a window waiting for a key press).

## 0.1.0

First release: FCS 2.0–3.2 reader, compensation (acquisition, computed from single stains, editable), linear/log/Logicle/Hyperlog/arcsinh scales, ratio parameters, rectangle/polygon/ellipse/quadrant/range/split/Boolean gates with drill-down, polygon conversion, per-sample adjustments, axis-title parameter menus, statistics table, batch layouts, autosaved workspaces, workflow templates, Gating-ML 2.0 import/export, FCS/CSV population export, headless batch runner.
