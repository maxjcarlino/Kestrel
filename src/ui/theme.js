// Theme tracking for canvas drawing (CSS tokens are read once per change).

import { store, useSel } from './state/store.js';
import { readTheme } from './plot/render.js';

let cached = null;
let cachedVersion = -1;

export function bumpTheme() {
  store.set((s) => ({ ...s, ui: { ...s.ui, themeVersion: (s.ui.themeVersion || 0) + 1 } }));
}

export function installThemeWatch() {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', bumpTheme);
    else if (mq.addListener) mq.addListener(bumpTheme);
  } catch (e) {
    /* ignore */
  }
  try {
    new MutationObserver(bumpTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) {
    /* ignore */
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(bumpTheme).catch(() => {});
}

export function currentTheme() {
  const v = (store.get() && store.get().ui.themeVersion) || 0;
  if (!cached || v !== cachedVersion) {
    cached = readTheme(document.documentElement);
    cachedVersion = v;
  }
  return cached;
}

export function useTheme() {
  useSel((s) => s.ui.themeVersion || 0);
  return currentTheme();
}

/** Light theme used for figure export regardless of the screen theme. */
export function exportTheme() {
  return {
    plotBg: '#ffffff',
    axis: '#3c4350',
    tick: '#232833',
    dot: '#2b313b',
    muted: '#c4c9d2',
    accent: '#0b6f9f',
    gateLine: '#1f2530',
    labelBg: 'rgba(255,255,255,0.92)',
    labelFg: '#12161d',
    histFill: '#5d6b80',
    dark: false,
    fontUI: currentTheme().fontUI,
    fontMono: currentTheme().fontMono,
  };
}
