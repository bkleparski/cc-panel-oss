'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Look = require('../public/look');
const Icons = require('../public/status-icons');

test('text size: S/M/L/XL = 13/15/17/19.5 px, anything else falls back to M', () => {
  assert.deepEqual(Look.SIZES.map((s) => Look.PX[s]), [13, 15, 17, 19.5]);
  for (const v of [null, '', 'xl', 'XXL', '15']) assert.equal(Look.parseSize(v), 'M');
  for (const s of Look.SIZES) assert.equal(Look.parseSize(s), s);
});

test('terminal size: default per device width, clamped to 8-22, garbage = default', () => {
  assert.equal(Look.parseTerm(null, true), 11);
  assert.equal(Look.parseTerm(null, false), 14);
  assert.equal(Look.parseTerm('0', false), 14);
  assert.equal(Look.parseTerm('abc', true), 11);
  assert.equal(Look.parseTerm('3', false), 8);
  assert.equal(Look.parseTerm('40', false), 22);
  assert.equal(Look.parseTerm('12.6', false), 13);
  assert.equal(Look.logPx(11), 12); // log terminala na telefonie jak przed zmianą
});

test('CSS: sizes from look.js match html[data-fs] rules; form fields never below 16 px', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(css, /--fs-ui: 15px;/);
  for (const s of ['S', 'L', 'XL']) assert.match(css, new RegExp(`html\\[data-fs="${s}"\\] \\{ --fs-ui: ${Look.PX[s]}px; \\}`));
  assert.match(css, /--input-fs: max\(16px, 1rem\)/);
  assert.match(css, /input, textarea, select \{[^}]*font-size: var\(--input-fs\)/);
  // poza :root nie ma kolorów wpisanych na sztywno (wyjątek: podgląd obrazu, zawsze ciemny)
  const body = css.slice(css.indexOf('html[data-fs="XL"]')).split('\n').filter((l) => !/mozg-image|mozg-file/.test(l)).join('\n');
  assert.deepEqual(body.match(/#[0-9a-f]{3,6}\b|rgba\(/gi), null);
});

test('status icons: every status has its own shape, unknown = idle square', () => {
  const shapes = ['approval', 'idle', 'working', 'done', 'shell', 'error'].map(Icons.shapeOf);
  assert.deepEqual(shapes, ['ask', 'you', 'work', 'done', 'idle', 'err']);
  assert.equal(new Set(shapes).size, shapes.length);
  assert.equal(Icons.shapeOf('bg'), 'work');
  assert.equal(Icons.shapeOf('cokolwiek'), 'idle');
  assert.deepEqual(Object.keys(Icons.LABEL).sort(), [...Icons.SHAPES].sort());
});

test('status icons: inline SVG, hidden from screen readers, distinct markup per shape', () => {
  const svgs = Icons.SHAPES.map((s) => Icons.statusSvg(Object.keys(Icons.SHAPE).find((k) => Icons.SHAPE[k] === s)));
  for (const svg of svgs) {
    assert.match(svg, /^<svg class="si-svg" viewBox="0 0 20 20" aria-hidden="true"/);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b/i); // kolor tylko currentColor (tokeny CSS)
  }
  assert.equal(new Set(svgs).size, svgs.length);
});

// ---------- etap 2: motywy i gęstość ----------
test('theme/density: parse falls back to auto/comfy, auto follows system, iOS status bar dark letters only on light', () => {
  assert.deepEqual(Look.THEMES, ['auto', 'dark', 'light', 'contrast', 'night']);
  for (const v of [null, '', 'Dark', 'sepia']) assert.equal(Look.parseTheme(v), 'auto');
  for (const t of Look.THEMES) assert.equal(Look.parseTheme(t), t);
  assert.equal(Look.parseDensity('compact'), 'compact');
  for (const v of [null, 'dense', '']) assert.equal(Look.parseDensity(v), 'comfy');
  assert.equal(Look.resolveTheme('auto', true), 'light');
  assert.equal(Look.resolveTheme('auto', false), 'dark');
  assert.equal(Look.resolveTheme('night', true), 'night');
  assert.equal(Look.statusBarStyle('light'), 'default');
  for (const t of ['dark', 'contrast', 'night']) assert.equal(Look.statusBarStyle(t), 'black-translucent');
  for (const t of Look.THEMES) { assert.ok(Look.THEME_NAMES[t]); assert.ok(Look.THEME_HINTS[t]); }
});

test('terminal options: colors from tokens, --ansi-* overrides, contrast ratio >= 1', () => {
  const tok = { '--code-bg': '#000', '--text': '#fff', '--accent': '#f80', '--term-sel': '#333', '--ansi-bright-blue': '#abc', '--term-contrast': '4.5' };
  const o = Look.termOptions((n) => tok[n] || '');
  assert.deepEqual(o.theme, { background: '#000', foreground: '#fff', cursor: '#f80', cursorAccent: '#000', selectionBackground: '#333', brightBlue: '#abc' });
  assert.equal(o.minimumContrastRatio, 4.5);
  assert.equal(Look.termOptions(() => '').minimumContrastRatio, 1);
  assert.equal(Look.termOptions(() => '').theme.background, '#0b0d10');
});

const CSS = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const block = (sel) => {
  const i = CSS.indexOf(`${sel} {`);
  assert.ok(i >= 0, `brak bloku ${sel}`);
  return Object.fromEntries([...CSS.slice(i, CSS.indexOf('}', i)).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const DARK = block(':root, [data-theme="dark"]');
const THEME = { dark: DARK };
for (const t of ['light', 'contrast', 'night']) THEME[t] = { ...DARK, ...block(`[data-theme="${t}"]`) };
const val = (t, n) => { let v = t[n]; for (let i = 0; v && v.startsWith('var(') && i < 5; i++) v = t[v.slice(6, -1)]; return v; };
const lum = (h) => {
  h = h.slice(1); if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('themes: every color token of the dark theme is set as a plain color in each theme block', () => {
  const colorTokens = Object.keys(DARK).filter((k) => /^#/.test(DARK[k]));
  for (const t of ['light', 'contrast', 'night']) {
    const own = block(`[data-theme="${t}"]`);
    const missing = colorTokens.filter((k) => !(k in own));
    assert.deepEqual(missing, [], `${t}: brak tokenów ${missing.join(', ')}`);
  }
});

test('themes: WCAG contrast of text and status colors (4.5:1 text, 3:1 shapes/buttons)', () => {
  const TEXT = [['text', 'bg'], ['text', 'panel'], ['muted', 'bg'], ['muted', 'panel'], ['muted', 'panel-2'], ['code-text', 'code-bg'],
    ['text', 'msg-user'], ['text', 'msg-bg'], ['ok', 'panel'], ['work', 'panel'], ['warn', 'panel'], ['danger', 'panel'], ['codex', 'panel'],
    ['accent', 'panel'], ['on-warn', 'warn']];
  const UI = [['st-idle', 'panel'], ['on-accent', 'accent'], ['on-accent', 'danger-solid']];
  for (const [name, t] of Object.entries(THEME)) {
    for (const [f, b] of TEXT) assert.ok(ratio(val(t, f), val(t, b)) >= 4.5, `${name}: ${f} na ${b} = ${ratio(val(t, f), val(t, b)).toFixed(2)}`);
    for (const [f, b] of UI) assert.ok(ratio(val(t, f), val(t, b)) >= 3, `${name}: ${f} na ${b} = ${ratio(val(t, f), val(t, b)).toFixed(2)}`);
  }
  // Kontrast: także ramki widać (>= 3:1) i są grubsze
  assert.ok(ratio(val(THEME.contrast, 'line'), val(THEME.contrast, 'panel')) >= 3);
  assert.equal(THEME.contrast.bw, '2px');
});

test('CSS: no broken pseudo-classes (".x: active" is a descendant selector, ".x: :after" kills the whole rule)', () => {
  const selectors = [...CSS.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].map((m) => m[1]);
  const bad = selectors.filter((s) => /[\w)\]-]: (?::|active|hover|focus|empty|disabled|not\(|last-child|first-child|checked)/.test(s));
  assert.deepEqual(bad, []);
});

test('density/desktop: compact hides the screen preview; cards grid from 22rem; side column only on desktop', () => {
  assert.match(CSS, /html\[data-density="compact"\] \.card pre \{ display: none; \}/);
  assert.match(CSS, /\.sess-main, \.sess-side \{ display: contents; \}/);
  assert.match(CSS, /@media \(min-width: 900px\) \{\n  \.sessions \{ display: grid;/);
  assert.match(CSS, /minmax\(min\(22rem, 100%\), 1fr\)/);
});
