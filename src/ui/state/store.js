// Tiny observable store with a Preact hook.

import { useEffect, useReducer, useRef } from 'preact/hooks';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(next, meta) {
      const value = typeof next === 'function' ? next(state) : next;
      if (value === state) return;
      const prev = state;
      state = value;
      for (const fn of [...subs]) fn(state, prev, meta || {});
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const store = createStore(null);

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/** Subscribe a component to a slice of state. Re-renders on shallow change. */
export function useSel(selector) {
  const [, force] = useReducer((x) => x + 1, 0);
  const selRef = useRef(selector);
  selRef.current = selector;
  const value = selector(store.get());
  const valRef = useRef(value);
  valRef.current = value;
  useEffect(
    () =>
      store.subscribe((s) => {
        let v;
        try {
          v = selRef.current(s);
        } catch (e) {
          force();
          return;
        }
        if (!shallowEqual(v, valRef.current)) force();
      }),
    [],
  );
  return value;
}

export const getState = () => store.get();
