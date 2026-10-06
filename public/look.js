// Wygląd per urządzenie: rozmiar tekstu panelu S/M/L/XL i rozmiar czcionki terminala (A−/A+, klucz ccp-fs) - etap 1 (05.10);
// motyw (Auto/Ciemny/Jasny/Kontrast/Nocny) i gęstość listy (Wygodna/Kompakt) - etap 2 (05.10).
// Ładowany synchronicznie w <head> po style.css: ustawia html[data-fs|data-theme|data-density], --term-fs i meta theme-color
// przed pierwszym malowaniem, więc nic nie mignie. Kolory motywów są tylko w style.css (tokeny), tu tylko wybór.
(function (root) {
  'use strict';
  const SIZES = ['S', 'M', 'L', 'XL'];
  const PX = { S: 13, M: 15, L: 17, XL: 19.5 };
  const NAMES = { S: 'mały', M: 'średni (domyślny)', L: 'duży', XL: 'bardzo duży' };
  const THEMES = ['auto', 'dark', 'light', 'contrast', 'night'];
  const THEME_NAMES = { auto: 'Auto', dark: 'Ciemny', light: 'Jasny', contrast: 'Kontrast', night: 'Nocny' };
  const THEME_HINTS = { auto: 'jak system', dark: 'domyślny', light: 'na słońce', contrast: 'czarne tło, grube ramki', night: 'ciepły, mniej niebieskiego' };
  const DENSITIES = ['comfy', 'compact'];
  const DENSITY_NAMES = { comfy: 'Wygodna', compact: 'Kompakt' };
  const KEY = 'ccp-ui-fs', TERM_KEY = 'ccp-fs', THEME_KEY = 'ccp-theme', DENSITY_KEY = 'ccp-density';
  const TERM_MIN = 8, TERM_MAX = 22;
  // kolory ANSI xterm, które motyw może nadpisać tokenem --ansi-<nazwa> (brak tokenu = domyślna paleta xterm)
  const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

  const parseSize = (v) => (SIZES.includes(v) ? v : 'M');
  const parseTheme = (v) => (THEMES.includes(v) ? v : 'auto');
  const parseDensity = (v) => (DENSITIES.includes(v) ? v : 'comfy');
  // Auto idzie za systemem: jasny system = Jasny, każdy inny (ciemny, brak wsparcia) = Ciemny
  const resolveTheme = (theme, prefersLight) => (theme === 'auto' ? (prefersLight ? 'light' : 'dark') : theme);
  // iOS (PWA): przy black-translucent litery paska stanu są białe, na jasnym tle znikają
  const statusBarStyle = (resolved) => (resolved === 'light' ? 'default' : 'black-translucent');
  const defaultTerm = (narrow) => (narrow ? 11 : 14);
  // NaN, 0, śmieci -> domyślny; reszta przycięta do 8-22 px
  const parseTerm = (v, narrow) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.max(TERM_MIN, Math.min(TERM_MAX, n)) : defaultTerm(narrow);
  };
  // log terminala (zwykły tekst) o 1 px większy niż xterm: przy domyślnych 11 px na telefonie zostaje jak dotąd 12 px
  const logPx = (term) => term + 1;
  // xterm z tokenów: tło, tekst, kursor, zaznaczenie, opcjonalne --ansi-*; --term-contrast = minimumContrastRatio
  // (xterm sam przyciemnia/rozjaśnia kolory programów, np. truecolor Claude Code, gdy giną na tle motywu)
  const termOptions = (css) => {
    const theme = { background: css('--code-bg') || '#0b0d10', foreground: css('--text') || '#e7e9ee',
      cursor: css('--accent') || '#d97757', cursorAccent: css('--code-bg') || '#0b0d10', selectionBackground: css('--term-sel') || '#3b4252' };
    for (const n of ANSI) { const v = css('--ansi-' + n.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())); if (v) theme[n] = v; }
    const ratio = Number(css('--term-contrast'));
    return { theme, minimumContrastRatio: Number.isFinite(ratio) && ratio >= 1 ? ratio : 1 };
  };

  const api = { SIZES, PX, NAMES, THEMES, THEME_NAMES, THEME_HINTS, DENSITIES, DENSITY_NAMES, KEY, TERM_KEY, THEME_KEY, DENSITY_KEY,
    TERM_MIN, TERM_MAX, ANSI, parseSize, parseTheme, parseDensity, resolveTheme, statusBarStyle, parseTerm, defaultTerm, logPx, termOptions };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  // ---------- przeglądarka ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} },
  };
  const mq = (q) => (root.matchMedia ? matchMedia(q) : null);
  const narrow = () => !!mq('(max-width: 600px)')?.matches;
  const lightMq = mq('(prefers-color-scheme: light)');
  const listeners = [];
  const state = {
    size: parseSize(store.get(KEY)), term: parseTerm(store.get(TERM_KEY), narrow()),
    theme: parseTheme(store.get(THEME_KEY)), density: parseDensity(store.get(DENSITY_KEY)),
  };
  const resolved = () => resolveTheme(state.theme, !!lightMq?.matches);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const meta = (name) => document.querySelector(`meta[name="${name}"]`);

  function apply() {
    const html = document.documentElement;
    if (state.size === 'M') html.removeAttribute('data-fs'); else html.dataset.fs = state.size;
    html.style.setProperty('--term-fs', `${logPx(state.term)}px`);
    const t = resolved();
    html.dataset.theme = t;
    if (state.density === 'compact') html.dataset.density = 'compact'; else html.removeAttribute('data-density');
    // pasek przeglądarki / iOS w kolorze tła motywu (tokeny już policzone: skrypt stoi po style.css)
    const bg = css('--bg');
    if (bg) meta('theme-color')?.setAttribute('content', bg);
    meta('apple-mobile-web-app-status-bar-style')?.setAttribute('content', statusBarStyle(t));
  }
  const snapshot = () => ({ ...state, resolved: resolved() });
  const emit = () => { const s = snapshot(); for (const fn of listeners) { try { fn(s); } catch {} } };
  const set = (k, key, v) => { state[k] = v; store.set(key, v); apply(); emit(); };

  Object.assign(api, {
    get: snapshot,
    setSize(s) { set('size', KEY, parseSize(s)); },
    setTerm(n) { set('term', TERM_KEY, parseTerm(n, narrow())); },
    setTheme(t) { set('theme', THEME_KEY, parseTheme(t)); },
    setDensity(d) { set('density', DENSITY_KEY, parseDensity(d)); },
    onChange(fn) { listeners.push(fn); },
    term: () => termOptions(css),
  });
  // Auto: zmiana motywu systemu (np. iOS o zachodzie słońca) przełącza panel bez przeładowania
  lightMq?.addEventListener?.('change', () => { if (state.theme === 'auto') { apply(); emit(); } });
  apply();
  root.Look = api;
})(typeof window === 'undefined' ? globalThis : window);
