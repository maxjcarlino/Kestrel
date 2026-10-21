// Small UI primitives: icons, buttons, menus, popovers, dialogs, fields.

import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { store, useSel } from '../state/store.js';
import { setUI, dismissToast } from '../state/doc.js';

const P = {
  select: 'M4 2.5l8.5 5.2-3.7.9-1.9 3.6z',
  rect: 'M2.5 3.5h11v9h-11z',
  polygon: 'M3 6.2 7.2 2.6l5.8 2.3-.9 6.8-5.6 1.8-3.6-3.2z',
  ellipse: 'M8 3.2c3.6 0 6 2.1 6 4.8s-2.4 4.8-6 4.8S2 10.7 2 8s2.4-4.8 6-4.8z',
  quad: 'M8 2v12M2 8h12M2.5 2.5h11v11h-11z',
  range: 'M3 3.5v9M13 3.5v9M3 8h10',
  split: 'M8 2v12M4 6 2 8l2 2M12 6l2 2-2 2',
  hist: 'M2 13.5h12M3.5 13V9M6.5 13V4.5M9.5 13V7M12.5 13v-3',
  pseudo: 'M3 13c2-6 4-9 6-9s3 4 4 9',
  dot: 'M4 11h.01M6 7h.01M8 9h.01M10 5h.01M12 8h.01M7 12h.01M11 11h.01',
  contour: 'M8 3c3.3 0 5.5 2.2 5.5 5S11.3 13 8 13s-5.5-2.2-5.5-5S4.7 3 8 3zM8 5.6c1.8 0 3 1 3 2.4S9.8 10.4 8 10.4 5 9.4 5 8s1.2-2.4 3-2.4z',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  left: 'M10 3 5 8l5 5',
  right: 'M6 3l5 5-5 5',
  down: 'M3.5 6 8 10.5 12.5 6',
  up: 'M3.5 10 8 5.5l4.5 4.5',
  undo: 'M5.5 3.5 2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7',
  redo: 'M10.5 3.5l3 3-3 3M13.5 6.5H6a3.5 3.5 0 0 0 0 7h3',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9',
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
  upload: 'M8 13V5M4.5 8.5 8 5l3.5 3.5M3 2.5h10',
  folder: 'M2 4.5h4l1.5 1.5H14v7H2z',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  gear: 'M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1',
  help: 'M6 6.2a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.3v.4M8 11.8h.01',
  table: 'M2.5 3h11v10h-11zM2.5 6.3h11M2.5 9.6h11M6.2 3v10',
  grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  matrix: 'M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11',
  tag: 'M2.5 2.5h5.5l6 6-5.5 5.5-6-6zM5.2 5.2h.01',
  gates: 'M2.5 2.5h4v4h-4zM9.5 9.5h4v4h-4zM4.5 6.5v5h5',
  eye: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8zM8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z',
  check: 'M3 8.5 6.5 12 13 4.5',
  search: 'M7 2.8a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4zM10.2 10.2 13.5 13.5',
  pencil: 'M10.5 2.8l2.7 2.7-7.4 7.4-3.3.6.6-3.3z',
  sun: 'M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1',
  moon: 'M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z',
  layers: 'M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3',
  drill: 'M3 3h6v6H3zM9 9l4 4M13 9v4H9',
  cloud: 'M4.5 12.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6 1A2.5 2.5 0 0 0 4.5 12.5z',
  warn: 'M8 2 14.5 13.5h-13zM8 6.5V9.5M8 11.5h.01',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5V2.5h7',
  bolt: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
  sliders: 'M2.5 4.5h7M12.5 4.5h1M2.5 11.5h2M7.5 11.5h6M9.5 3v3M5 10v3',
  palette: 'M8 2a6 6 0 1 0 0 12c.8 0 1.2-.6 1-1.3-.3-.9.3-1.7 1.2-1.7H12a2.5 2.5 0 0 0 2-2.5C14 4.6 11.3 2 8 2zM5 7h.01M7.5 4.8h.01M10.5 5.2h.01',
  link: 'M6.5 9.5l3-3M5 7.5 3.8 8.7a2.3 2.3 0 0 0 3.3 3.3L8.3 10.8M11 8.5l1.2-1.2a2.3 2.3 0 0 0-3.3-3.3L7.7 5.2',
  convert: 'M2.5 4.5h7v6h-7zM11 7.5h3M12.5 6 14 7.5 12.5 9',
  flask: 'M6 2h4M6.8 2v4L3 13h10L9.2 6V2',
};

export function Icon({ name, size = 16, class: cls }) {
  const d = P[name] || P.help;
  return (
    <svg class={`icon ${cls || ''}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function Button({ variant = 'default', size = 'md', icon, children, class: cls = '', ...rest }) {
  return (
    <button type="button" class={`btn btn-${variant} btn-${size} ${cls}`} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({ icon, label, active = false, class: cls = '', size = 16, ...rest }) {
  return (
    <button type="button" class={`ibtn ${active ? 'is-active' : ''} ${cls}`} aria-label={label} title={label} aria-pressed={active ? 'true' : undefined} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Segmented({ options, value, onChange, size = 'sm', label }) {
  return (
    <div class={`seg seg-${size}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === value ? 'true' : 'false'}
          class={o.value === value ? 'is-on' : ''}
          title={o.title || o.label}
          onClick={() => onChange(o.value)}
          key={String(o.value)}
        >
          {o.icon ? <Icon name={o.icon} /> : null}
          {o.label && !o.iconOnly ? <span>{o.label}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Text field that commits on Enter or blur. */
export function TextField({ value, onCommit, placeholder, class: cls = '', autoFocus = false, selectOnFocus = true, ...rest }) {
  const [v, setV] = useState(value ?? '');
  const ref = useRef();
  useEffect(() => setV(value ?? ''), [value]);
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus({ preventScroll: true });
      if (selectOnFocus) ref.current.select();
    }
  }, []);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <input
      ref={ref}
      class={`field ${cls}`}
      value={v}
      placeholder={placeholder}
      onInput={(e) => setV(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setV(value ?? '');
          setTimeout(() => e.target.blur(), 0);
        }
        e.stopPropagation();
      }}
      {...rest}
    />
  );
}

/**
 * A label that shrinks its own font size, down to `minSize`, to fit the
 * width it's given rather than truncating with an ellipsis — so a long
 * sample or parameter name stays fully readable even in a narrow column.
 * Only falls back to an ellipsis if it's still too wide at `minSize`.
 */
export function FitText({ text, class: cls = '', minSize = 9, ...rest }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      const base = parseFloat(el.dataset.fitBase || getComputedStyle(el).fontSize);
      el.dataset.fitBase = base;
      el.style.fontSize = `${base}px`;
      const avail = el.clientWidth;
      const needed = el.scrollWidth;
      if (!avail || needed <= avail + 0.5) return;
      let size = Math.max(minSize, Math.floor(((base * avail) / needed) * 0.96 * 10) / 10);
      el.style.fontSize = `${size}px`;
      for (let i = 0; i < 4 && el.scrollWidth > el.clientWidth + 0.5 && size > minSize; i++) {
        size = Math.max(minSize, size - 0.5);
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement || el);
    return () => ro.disconnect();
  }, [text, minSize]);
  return (
    <span ref={ref} class={`fit-text ${cls}`} {...rest}>
      {text}
    </span>
  );
}

/** Numeric field; empty input commits null when `allowEmpty`. */
export function NumberField({ value, onCommit, step = 'any', allowEmpty = false, placeholder = '', class: cls = '', format = (x) => x, ...rest }) {
  const show = value === null || value === undefined || !Number.isFinite(value) ? '' : String(format(value));
  const [v, setV] = useState(show);
  useEffect(() => setV(show), [show]);
  const commit = () => {
    const t = v.trim().replace(/[−]/g, '-');
    if (t === '') {
      if (allowEmpty) onCommit(null);
      else setV(show);
      return;
    }
    const n = parseFloat(t.replace(/k$/i, 'e3').replace(/m$/i, 'e6'));
    if (Number.isFinite(n)) onCommit(n);
    else setV(show);
  };
  return (
    <input
      class={`field num ${cls}`}
      inputMode="decimal"
      value={v}
      placeholder={placeholder}
      step={step}
      onInput={(e) => setV(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setV(show);
        e.stopPropagation();
      }}
      {...rest}
    />
  );
}

/** Click-to-edit text. */
export function InlineEdit({ value, onCommit, class: cls = '', title = 'Click to rename', editing: forced = false, onDone }) {
  const [editing, setEditing] = useState(forced);
  useEffect(() => {
    if (forced) setEditing(true);
  }, [forced]);
  if (editing) {
    return (
      <TextField
        value={value}
        autoFocus
        class={`inline-field ${cls}`}
        onCommit={(v) => {
          onCommit(v);
        }}
        onBlur={(e) => {
          const nv = e.currentTarget.value;
          if (nv !== value && nv.trim()) onCommit(nv);
          setEditing(false);
          if (onDone) onDone();
        }}
      />
    );
  }
  return (
    <button type="button" class={`inline-edit ${cls}`} title={title} onClick={() => setEditing(true)}>
      <span class="inline-edit-text">{value}</span>
      <Icon name="pencil" size={12} class="inline-edit-icon" />
    </button>
  );
}

// ------------------------------------------------------------------ popovers

function useOutside(ref, onClose, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const key = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', down, true);
    }, 0);
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [enabled]);
}

/**
 * Floating panel anchored to a rect {x, y, w, h} (viewport coordinates).
 */
export function Popover({ anchor, onClose, children, class: cls = '', placement = 'below', width }) {
  const ref = useRef();
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useOutside(ref, onClose);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let last = '';
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const k = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (k !== last) {
        last = k;
        setTick((t) => t + 1);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left;
    let top;
    if (placement === 'right') {
      left = anchor.x + anchor.w + 6;
      top = anchor.y;
    } else if (placement === 'point') {
      left = anchor.x;
      top = anchor.y;
    } else {
      left = anchor.x + anchor.w / 2 - r.width / 2;
      top = anchor.y + anchor.h + 6;
      if (top + r.height > vh - 8) top = Math.max(8, anchor.y - r.height - 6);
    }
    if (left + r.width > vw - 8) left = Math.max(8, vw - r.width - 8);
    if (left < 8) left = 8;
    if (top + r.height > vh - 8) top = Math.max(8, vh - r.height - 8);
    setPos({ left, top });
  }, [anchor && anchor.x, anchor && anchor.y, anchor && anchor.w, anchor && anchor.h, tick]);
  return createPortal(
    <div ref={ref} class={`popover ${cls}`} style={{ left: `${pos.left}px`, top: `${pos.top}px`, width: width ? `${width}px` : undefined }} role="dialog">
      {children}
    </div>,
    document.body,
  );
}

export function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Context / dropdown menu rendered from ui.menu state. */
export function MenuHost() {
  const menu = useSel((s) => s.ui.menu);
  if (!menu) return null;
  return <Menu {...menu} onClose={() => setUI({ menu: null })} />;
}

export function openMenu(anchor, items, opts = {}) {
  setUI({ menu: { anchor, items, ...opts } });
}

export function Menu({ anchor, items, onClose, title }) {
  const ref = useRef();
  const [sub, setSub] = useState(null);
  useEffect(() => {
    const first = ref.current && ref.current.querySelector('button.menu-item:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }, []);
  const onKey = (e) => {
    const btns = [...ref.current.querySelectorAll('button.menu-item:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      btns[(i + 1) % btns.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(i - 1 + btns.length) % btns.length].focus();
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} class="menu" placement={anchor.w === 0 ? 'point' : 'below'}>
      <div ref={ref} role="menu" onKeyDown={onKey}>
        {title ? <div class="menu-title">{title}</div> : null}
        {items.filter(Boolean).map((it, i) => {
          if (it.divider) return <div class="menu-sep" key={`d${i}`} />;
          if (it.heading) return <div class="menu-heading" key={`h${i}`}>{it.heading}</div>;
          if (it.swatches) {
            return (
              <div class="menu-swatches" key={`s${i}`}>
                {it.swatches.map((c) => (
                  <button
                    type="button"
                    class={`swatch ${c === it.value ? 'is-on' : ''}`}
                    style={{ background: c }}
                    aria-label={`Colour ${c}`}
                    onClick={() => {
                      it.onPick(c);
                      onClose();
                    }}
                    key={c}
                  />
                ))}
              </div>
            );
          }
          const open = sub === i;
          return (
            <div key={`i${i}`} class={it.submenu ? 'menu-group' : undefined}>
              <button
                type="button"
                role="menuitem"
                class={`menu-item ${it.danger ? 'is-danger' : ''} ${open ? 'is-open' : ''}`}
                disabled={!!it.disabled}
                aria-expanded={it.submenu ? (open ? 'true' : 'false') : undefined}
                title={it.disabled && it.why ? it.why : undefined}
                onClick={() => {
                  if (it.submenu) {
                    setSub(open ? null : i);
                    return;
                  }
                  onClose();
                  it.onClick && it.onClick();
                }}
              >
                <span class="menu-icon">{it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={14} /> : null}</span>
                <span class="menu-label">{it.label}</span>
                {it.hint ? <span class="menu-hint">{it.hint}</span> : null}
                {it.submenu ? <Icon name={open ? 'down' : 'right'} size={12} /> : null}
              </button>
              {open ? (
                <div class="menu-sub" role="group">
                  {it.submenu.map((sItem, j) => (
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={!!sItem.disabled}
                      title={sItem.disabled && sItem.why ? sItem.why : undefined}
                      onClick={() => {
                        onClose();
                        sItem.onClick && sItem.onClick();
                      }}
                      key={`s${j}`}
                    >
                      <span class="menu-icon">{sItem.checked ? <Icon name="check" size={14} /> : null}</span>
                      <span class="menu-label">{sItem.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}

// ------------------------------------------------------------------ dialogs

export function Dialog({ title, onClose, children, footer, width = 520, class: cls = '' }) {
  const ref = useRef();
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    const prev = document.activeElement;
    const f = ref.current && ref.current.querySelector('input, select, textarea, button.btn-primary, button');
    if (f) f.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', key);
      if (prev && prev.focus) prev.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} class={`dialog ${cls}`} role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, calc(100vw - 32px))` }}>
        <header class="dialog-head">
          <h2>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div class="dialog-body">{children}</div>
        {footer ? <footer class="dialog-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function openDialog(name, props = {}) {
  setUI({ dialog: { name, props }, menu: null });
}

export function closeDialog() {
  setUI({ dialog: null });
}

// ------------------------------------------------------------------ toasts

export function Toasts() {
  const toasts = useSel((s) => s.toasts);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div class={`toast toast-${t.kind}`} key={t.id}>
          <span>{t.message}</span>
          {t.action ? (
            <button
              type="button"
              class="toast-action"
              onClick={() => {
                t.action.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" class="toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Empty({ icon = 'file', title, children, action }) {
  return (
    <div class="empty">
      <div class="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div class="empty-title">{title}</div>
      {children ? <div class="empty-text">{children}</div> : null}
      {action || null}
    </div>
  );
}

export function useStoreState() {
  return store.get();
}
