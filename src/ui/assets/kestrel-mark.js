// Kestrel in flight, side view facing right, wings raised mid-stroke: the app's logo.
// Grayscale; tones come from --k1 (darkest) … --k5 (lightest) so it reads in both themes.

const f = (n) => n.toFixed(1);

/** A tapered flight feather from base to tip with a shaft, bars and an optional dark tip. */
function feather([bx, by], [tx, ty], w, { bars = 3, tip = 0, band = 0, cls = '' } = {}) {
  const dx = tx - bx;
  const dy = ty - by;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const p = (t, o) => `${f(bx + dx * t + nx * o)} ${f(by + dy * t + ny * o)}`;
  const h = w / 2;
  let s = `<path class="k-fth ${cls}" d="M${p(0, -h)} C${p(0.5, -h * 1.05)} ${p(0.86, -h * 0.75)} ${p(1, 0)} C${p(0.9, h * 0.6)} ${p(0.5, h * 1.05)} ${p(0, h)} Z"/>`;
  s += `<path class="k-shaft" d="M${p(0.04, 0)} L${p(0.93, 0)}"/>`;
  let bar = '';
  for (let k = 1; k <= bars; k++) {
    const t = 0.2 + (k * 0.6) / (bars + 1);
    const o = h * (1 - t * 0.35);
    bar += `M${p(t, -o)} L${p(t + 0.04, o)} `;
  }
  if (bars) s += `<path class="k-fbar" d="${bar}"/>`;
  if (band) {
    // dark subterminal band and pale tip (tail feathers)
    s += `<path class="k-ftip" d="M${p(0.77, -h * 0.95)} L${p(0.86, -h * 0.84)} L${p(0.86, h * 0.84)} L${p(0.77, h * 0.95)} Z"/>`;
  }
  if (tip) s += `<path class="k-ftip" d="M${p(1 - tip, -h * 0.7)} C${p(1 - tip * 0.5, -h * 0.62)} ${p(0.95, -h * 0.3)} ${p(1, 0)} C${p(0.93, h * 0.3)} ${p(1 - tip * 0.5, h * 0.55)} ${p(1 - tip, h * 0.65)} Z"/>`;
  return s;
}

/** Fan of feathers: bases spaced between b0..b1, tips between t0..t1. */
function fan(n, b0, b1, t0, t1, w, opts, curve = 0) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1);
    const lerp = (a, b) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    const tipPt = lerp(t0, t1);
    // bow the tip line so the fan is rounded
    const bow = Math.sin(u * Math.PI) * curve;
    s += feather(lerp(b0, b1), [tipPt[0] - bow, tipPt[1] - bow * 0.4], typeof w === 'function' ? w(u) : w, opts);
  }
  return s;
}

// far wing (behind the body), raised forward and up
const FAR = `<g class="k-far">
  ${fan(5, [124, 64], [131, 58], [138, 30], [147, 22], 6.4, { bars: 2 })}
  ${fan(6, [133, 46], [137, 54], [152, 6], [172, 26], (u) => 6.6 - u * 0.8, { bars: 3, tip: 0.17 }, 3)}
  <path class="k-cov" d="M116 72 C118 60 126 46 138 40 C141 46 139 54 134 60 C128 66 122 70 116 72 Z"/>
  <path class="k-hatch" d="M116 72 C118 60 126 46 138 40 C141 46 139 54 134 60 C128 66 122 70 116 72 Z"/>
</g>`;

// near wing, raised high and swept back
const NEAR = `<g class="k-near">
  ${fan(7, [100, 38], [96, 50], [26, 4], [44, 34], (u) => 8.4 - u * 1.4, { bars: 4, tip: 0.16 }, 5)}
  ${fan(8, [97, 52], [117, 74], [62, 42], [88, 82], (u) => 8.6 - u * 0.8, { bars: 3, cls: 'k-sec' }, 3)}
  <path class="k-cov" d="M126 74 C126 62 116 46 99 36 C96 38 95 44 97 50 C101 60 110 70 120 78 Z"/>
  <path class="k-cov2" d="M124 72 C123 62 115 49 101 39 C108 48 114 58 119 70 Z"/>
  <g class="k-spot">
    <ellipse cx="108" cy="52" rx="1.6" ry="0.9" transform="rotate(48 108 52)"/>
    <ellipse cx="113" cy="58" rx="1.6" ry="0.9" transform="rotate(48 113 58)"/>
    <ellipse cx="104" cy="58" rx="1.4" ry="0.8" transform="rotate(48 104 58)"/>
    <ellipse cx="110" cy="65" rx="1.4" ry="0.8" transform="rotate(48 110 65)"/>
    <ellipse cx="117" cy="66" rx="1.4" ry="0.8" transform="rotate(48 117 66)"/>
    <ellipse cx="103" cy="46" rx="1.3" ry="0.8" transform="rotate(48 103 46)"/>
  </g>
  <path class="k-hatch2" d="M126 74 C126 62 116 46 99 36 C96 38 95 44 97 50 C101 60 110 70 120 78 Z"/>
  <path class="k-edge" d="M126 74 C126 62 116 46 99 36"/>
</g>`;

// tail, fanned, trailing low behind
const TAIL = `<g class="k-tail">
  ${fan(7, [90, 93.5], [92, 99.5], [28, 90], [46, 126], (u) => 7.6 - Math.abs(u - 0.5) * 2, { bars: 3, band: 1, cls: 'k-tf' }, 4)}
</g>`;

export const KESTREL_SVG = `<svg viewBox="0 0 200 140" xmlns="http://www.w3.org/2000/svg" class="kestrel-mark" role="img" aria-label="Kestrel"><defs>
    <filter id="k-pencil" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="wobble"/>
      <feDisplacementMap in="SourceGraphic" in2="wobble" scale="0.7" xChannelSelector="R" yChannelSelector="G" result="rough"/>
      <feTurbulence type="fractalNoise" baseFrequency="1.6 0.22" numOctaves="3" seed="3" result="grain"/>
      <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.1 0 0 0 0.3" result="grainA"/>
      <feComposite in="rough" in2="grainA" operator="in"/>
    </filter>
    <pattern id="k-hatch" width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
      <path d="M0 0.4 H2.6" stroke="var(--k1)" stroke-width="0.55"/>
    </pattern>
    <pattern id="k-hatch2" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
      <path d="M0 0.4 H3.2" stroke="var(--k1)" stroke-width="0.45"/>
    </pattern>
  </defs><g transform="rotate(34 100 70)" filter="url(#k-pencil)"><g transform="rotate(-28 100 70)">
  ${FAR}
  ${TAIL}
  <path class="k-body" d="M88 93 C98 86 112 76 126 68 C134 63 141 58 147 56 L157 76 C152 84 144 92 132 97 C118 102 102 102 88 99 Z"/>
  <path class="k-back" d="M88 93 C98 86 112 76 126 68 C134 63 141 58 147 56 C143 63 135 70 125 75 C112 82 100 89 88 95 Z"/>
  <g class="k-streak">
    <path d="M146 78 l-1.6 2.2 M139 83 l-2 2.2 M131 88 l-2 2.2 M123 92 l-2 2 M141 89 l-1.8 2 M133 94 l-1.8 2 M115 95 l-1.8 1.8 M107 97 l-1.6 1.6 M125 97 l-1.6 1.6"/>
  </g>
  <path class="k-leg" d="M120 99 C122 104 126 106 130 105.4 C128 102.6 126 100.6 124 98.4 Z"/>
  <path class="k-toe" d="M129 105 l3.4 1 M129.6 106.2 l2.6 2.2"/>
  <path class="k-head" d="M138 62 C139 52 145 45.6 153 44.4 C159 43.6 164.4 45.4 167.2 49.6 C168.6 51.8 169 54.4 168 57.4 C166 63.6 161.6 68.6 155 72.4 C149 75.4 141.6 72 138 62 Z"/>
  <path class="k-hatch" d="M88 93 C98 86 112 76 126 68 C134 63 141 58 147 56 C143 63 135 70 125 75 C112 82 100 89 88 95 Z"/>
  <path class="k-cap" d="M138.6 58 C140.6 50 146 45.4 153 44.4 C159 43.6 164.4 45.4 167.2 49.6 C160 48 149 50.4 138.6 58 Z"/>
  <path class="k-hatch" d="M138.6 58 C140.6 50 146 45.4 153 44.4 C159 43.6 164.4 45.4 167.2 49.6 C160 48 149 50.4 138.6 58 Z"/>
  <path class="k-hatch2 k-light" d="M140 66 C141 72 148 76 154 76 C149 72 145 68 143 62 Z"/>
  <path class="k-malar" d="M158.4 57.6 C157 61 157 64.6 158.4 68 C160 65.6 160.8 62 160.4 58.2 Z"/>
  <path class="k-brow" d="M154.6 52.2 C157 50.6 160.6 50.4 163 51.6"/>
  <circle class="k-ring" cx="159.4" cy="54.6" r="2.6"/>
  <circle class="k-eye" cx="159.7" cy="54.6" r="1.9"/>
  <circle class="k-glint" cx="160.3" cy="54" r="0.6"/>
  <path class="k-beak" d="M167 51.6 C171 51.4 174 54.2 173.6 58.6 C172.8 57 171.2 56.6 169.6 57 L167.6 58 Z"/>
  <path class="k-cere" d="M166 51 C167.6 50.6 169 51.2 169.6 52.8 L166.8 54.4 Z"/>
  ${NEAR}
</g></g></svg>`;

export const KESTREL_CSS = `
.kestrel-mark { display: block; width: 100%; height: auto; overflow: visible; }
.k-fth { fill: var(--k4); stroke: var(--k2); stroke-width: 0.5; stroke-linejoin: round; }
.k-sec { fill: var(--k4); }
.k-far .k-fth { fill: var(--k3); stroke: var(--k1); }
.k-tf { fill: var(--k4); }
.k-shaft { fill: none; stroke: var(--k2); stroke-width: 0.4; opacity: 0.8; }
.k-fbar { fill: none; stroke: var(--k1); stroke-width: 1; stroke-linecap: round; opacity: 0.5; }
.k-ftip { fill: var(--k1); opacity: 0.88; }
.k-cov { fill: var(--k4); stroke: var(--k2); stroke-width: 0.5; }
.k-cov2 { fill: var(--k5); opacity: 0.45; }
.k-far .k-cov { fill: var(--k3); }
.k-hatch { fill: url(#k-hatch); opacity: 0.55; }
.k-hatch2 { fill: url(#k-hatch2); opacity: 0.4; }
.k-light { opacity: 0.25; }
.k-spot { fill: var(--k1); opacity: 0.75; }
.k-edge { fill: none; stroke: var(--k1); stroke-width: 0.9; stroke-linecap: round; }
.k-body { fill: var(--k5); stroke: var(--k3); stroke-width: 0.5; }
.k-back { fill: var(--k3); }
.k-streak { fill: none; stroke: var(--k2); stroke-width: 1.3; stroke-linecap: round; }
.k-leg { fill: var(--k4); stroke: var(--k2); stroke-width: 0.4; }
.k-toe { fill: none; stroke: var(--k2); stroke-width: 1; stroke-linecap: round; }
.k-head { fill: var(--k4); stroke: var(--k2); stroke-width: 0.5; }
.k-cap { fill: var(--k2); }
.k-brow { fill: none; stroke: var(--k5); stroke-width: 0.9; stroke-linecap: round; opacity: 0.8; }
.k-malar { fill: var(--k1); }
.k-ring { fill: var(--k5); }
.k-eye { fill: var(--k1); }
.k-glint { fill: var(--k5); }
.k-beak { fill: var(--k2); stroke: var(--k1); stroke-width: 0.4; }
.k-cere { fill: var(--k3); }
`;
