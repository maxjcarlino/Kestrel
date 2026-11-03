import test from 'node:test';
import assert from 'node:assert/strict';

import { panelStyle, panelGeom, layoutDefaults, PANEL_DEFAULTS } from '../src/ui/plot/panel-style.js';

test('a plot\'s own settings win over the figure\'s, which win over the built-in defaults', () => {
  const L = { size: 240, showTitles: false, panel: { font: 1.2, ticks: false }, plotStyles: { p1: { size: 120, ticks: true, gateLabels: 'value' } } };
  assert.deepEqual(layoutDefaults({}), PANEL_DEFAULTS);
  const d = panelStyle(L, 'p2');
  assert.equal(d.size, 240);
  assert.equal(d.title, false, 'the older showTitles setting still counts');
  assert.equal(d.font, 1.2);
  assert.equal(d.ticks, false);
  const own = panelStyle(L, 'p1');
  assert.equal(own.size, 120);
  assert.equal(own.ticks, true);
  assert.equal(own.gateLabels, 'value');
  assert.equal(own.font, 1.2, 'anything the plot does not set comes from the figure');
});

test('panel geometry: hiding axis numbers and titles gives the data the room; text size scales the furniture', () => {
  const full = panelGeom({ ...PANEL_DEFAULTS, size: 200 });
  const bare = panelGeom({ ...PANEL_DEFAULTS, size: 200, tickLabels: false, axisTitles: false, title: false, ticks: false });
  assert.equal(full.PW, 200);
  assert.equal(bare.PW, 200);
  const plotW = (g) => g.W - g.margin.l - g.margin.r;
  assert.ok(plotW(bare) > plotW(full) + 50, `${plotW(bare)} vs ${plotW(full)}`);
  // same width, so the larger (square) plot makes the panel taller rather than leaving a gap
  assert.ok(bare.PH > full.PH);
  // the plotted area stays square
  for (const g of [full, bare]) assert.equal(g.H - g.margin.t - g.margin.b, plotW(g));
  const big = panelGeom({ ...PANEL_DEFAULTS, size: 200, font: 1.5 });
  assert.ok(big.titleH > full.titleH && big.margin.l > full.margin.l && big.margin.b > full.margin.b);
  // only tick marks: a sliver of margin, no room for numbers
  const ticksOnly = panelGeom({ ...PANEL_DEFAULTS, size: 200, tickLabels: false });
  assert.ok(ticksOnly.margin.l < 10 && ticksOnly.margin.l > bare.margin.l);
});
