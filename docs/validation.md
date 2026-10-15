# Validation

## Gating-ML 2.0 compliance — 49 of 49
`npm run compliance` downloads the Gating-ML 2.0 reference files (data1.fcs, gml_all_gates.xml and per-event results from the gatingMLData suite by J. Spidlen and N. Gopalakrishnan, via a pinned FlowKit commit, checksummed), imports the gates, evaluates them with Kestrel's engine and compares membership event by event. Covers rectangles, ranges, polygons, ellipses, 2-D and 3-D quadrants, Boolean gates, ratio dimensions, and linear, log, Logicle, Hyperlog and arcsinh scales, with and without compensation. All 49 match exactly. 3-D quadrants are imported as AND combinations of 2-D and 1-D gates.

## FlowKit cross-check — 13 of 13
`python3 scripts/flowkit-crosscheck.py demo-data/PBMC_Donor01.fcs examples/pbmc-7colour.gating-ml.xml` evaluates Kestrel's exported Gating-ML with FlowKit 1.3.2 and with Kestrel; every gate has the same count.

## App = batch runner
The end-to-end suite exports the statistics table from the app and compares it with `runTemplate` on the same files: identical CSV.

## Unit and end-to-end tests
`npm test` (45 tests): Logicle/Hyperlog anchors and round trips, FCS 2.0–3.2 reading (byte orders, masks, log amplification, gain, multiple data sets, mixed types), writer round trips, compensation recovery, spillover estimation from simulated beads (FITC→PE 24.01 % vs 24 % simulated), statistics, Gating-ML round trips, batch runner.
`npm run e2e` (60 checks, Playwright/Chromium): drawing and editing every gate type, drill-down, polygon conversion, axis menus, ratio parameters, quadrants, per-sample gates, autosave across reloads, compensation from controls, templates on new data, Gating-ML import, exports, phone-width layout.
