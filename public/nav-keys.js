'use strict';
// Skróty nawigacji (06.10): ⌘T terminal (dok shella w Dyspozytorze), ⌘D Dyspozytor, ⌘S lista sesji.
// CC Panel.app: akceleratory natywnego menu „Panel” (desktop main.rs) -> CCPDesktop.nav (panel.js) -> NavKeys.go.
// Menu łapie skrót przed WebView, więc działa też przy fokusie w xterm i w polu wpisywania.
// Przeglądarka na macOS: ⌘D i ⌘S przechwycone tutaj (zamiast zakładki i zapisu strony). ⌘T przeglądarka
// zostawia sobie (nowa karta), strona go nie dostaje - terminal dalej Ctrl+` (shell-dock.js). Inne systemy bez zmian.
// Listener w fazie capture na window + attachCustomKeyEventHandler w obu xtermach: skrót nie trafia do terminala.

const NAV_KEYS = { t: 'terminal', d: 'dysp', s: 'sessions' };

// macOS (także iPad z klawiaturą: iPadOS podaje MacIntel); Windows/Linux: metaKey to klawisz Win, nie ruszamy
function isMac(nav) {
  return /^mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
}
// cel skrótu albo null; litera z e.key (układ klawiatury), przy nie-łacińskim układzie z e.code
function navTarget(e, mac) {
  if (!mac || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return null;
  const k = /^[a-z]$/i.test(e.key || '') ? e.key.toLowerCase() : ((/^Key([A-Z])$/.exec(e.code || '') || [])[1] || '').toLowerCase();
  return NAV_KEYS[k] || null;
}
// dopisek do tooltipa; app = CC Panel.app z menu „Panel” (CCPDesktop.nav), tylko tam działa ⌘T
function hint(target, { mac, app }) {
  if (target === 'terminal') return mac && app ? '⌘T, Ctrl+`' : 'Ctrl+`';
  if (!mac) return '';
  return { dysp: '⌘D', sessions: '⌘S' }[target] || '';
}

if (typeof module !== 'undefined') module.exports = { NAV_KEYS, isMac, navTarget, hint };

if (typeof document !== 'undefined') (() => {
  const mac = isMac(navigator);
  const view = () => document.getElementById('v-mozg');
  const onMozgHash = () => /^#\/mozg(\/|$)/.test(location.hash);

  // toggle: ⌘T jak Ctrl+` (zamknięty -> otwórz, otwarty bez fokusu -> fokus, z fokusem -> zamknij);
  // false = okno panelu nie miało fokusu (⌘T z okna czatu), wtedy tylko otwórz i ustaw fokus
  function arrive(target, toggle) {
    if (target === 'terminal') {
      if (toggle) ShellDock.toggle(); else ShellDock.open();
    } else if (matchMedia('(min-width: 900px)').matches) document.getElementById('mozg-text').focus({ preventScroll: true });
  }
  function go(target, { toggle = true } = {}) {
    if (target === 'sessions') { if (location.hash !== '#/sesje') location.hash = '#/sesje'; return; }
    if (!view().hidden) { arrive(target, toggle); return; }
    if (onMozgHash()) return; // trasa Dyspozytora bez widoku = ekran logowania
    window.addEventListener('hashchange', () => requestAnimationFrame(() => arrive(target, false)), { once: true });
    location.hash = '#/mozg';
  }

  window.addEventListener('keydown', (e) => {
    const target = navTarget(e, mac);
    if (!target) return;
    e.preventDefault(); // bez okna zakładki / zapisu strony także przy otwartym dialogu
    e.stopPropagation();
    if (e.repeat || document.querySelector('dialog[open]')) return;
    go(target);
  }, true);

  // ściągawka: dopisek skrótu w tooltipach elementów z data-nav (bazowy tytuł w index.html bez skrótu);
  // app.js podmienia tytuły SESJE i Dyspozytora na stan (liczba sesji, gotowy/pracuje), też przez setTitle
  const app = typeof window.CCPDesktop?.nav === 'function';
  const setTitle = (el, text) => {
    const h = hint(el.dataset.nav, { mac, app });
    el.title = h ? `${text} (${h})` : text;
  };
  for (const el of document.querySelectorAll('[data-nav]')) setTitle(el, el.title);

  window.NavKeys = Object.freeze({ go, setTitle, isNav: (e) => !!navTarget(e, mac) });
})();
