// Layout panel styles: per-figure defaults and per-plot overrides for a
// panel's size, text and which elements are drawn, and the geometry that
// follows from them. Pure functions (no DOM), shared by the Layout view,
// its export, and tests.

/**
 * How a Layout panel is drawn. The layout has defaults for every panel
 * (doc.layout.panel, plus the older showTitles / showAxisLabels / size
 * settings), and any plot can override some of them (doc.layout.plotStyles).
 *   size        panel width in px
 *   font        text scale (1 = normal)
 *   title       the population name above the plot
 *   axisTitles  the parameter names along the axes
 *   tickLabels  the numbers on the axes
 *   ticks       the tick marks
 *   gates       gate outlines
 *   gateLabels  'both' (name and value) | 'name' | 'value' | 'none'
 */
export const PANEL_DEFAULTS = { size: 220, font: 1, title: true, axisTitles: true, tickLabels: true, ticks: true, gates: true, gateLabels: 'both' };

/** Layout-wide panel defaults. */
export function layoutDefaults(L) {
  return { ...PANEL_DEFAULTS, ...(L.panel || {}), size: L.size || PANEL_DEFAULTS.size, title: L.showTitles !== false, axisTitles: L.showAxisLabels !== false };
}

/** The style a plot is drawn with in the Layout: the defaults, then its own overrides. */
export function panelStyle(L, plotId) {
  return { ...layoutDefaults(L), ...(((L.plotStyles || {})[plotId]) || {}) };
}

/**
 * Panel geometry for a style: outer size PW×PH, the plot block W×H inside the
 * title and axis titles, and the plot's margins (room for the axis numbers,
 * which go when the numbers are hidden, so the data fills the panel).
 */
export function panelGeom(st) {
  const f = st.font || 1;
  const titleH = st.title ? Math.round(22 * f) : 4;
  const xtH = st.axisTitles ? Math.round(18 * f) + 2 : 0;
  const ytW = st.axisTitles ? Math.round(16 * f) + 2 : 0;
  const margin = {
    l: st.tickLabels ? Math.round(38 * f) + 6 : st.ticks ? 7 : 2,
    r: st.tickLabels ? Math.round(6 * f) + 4 : 4,
    t: 4,
    b: st.tickLabels ? Math.round(16 * f) + 8 : st.ticks ? 7 : 2,
  };
  const PW = Math.round(st.size || PANEL_DEFAULTS.size);
  const W = PW - ytW;
  const aw = Math.max(20, W - margin.l - margin.r);
  const H = aw + margin.t + margin.b;
  return { PW, PH: titleH + H + xtH, W, H, titleH, xtH, ytW, margin, f };
}

