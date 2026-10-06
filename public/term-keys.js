// Pasek klawiszy pod terminalem (telefon): wspólny dla terminala sesji (#keys) i doku shella (#shell-keys).
// Przycisk data-k = nazwany klawisz z KEYS, data-s = dosłowny tekst, data-act = akcja widoku (onAction),
// przycisk bez żadnego z nich obsługuje własny listener (np. ⚙ Model w terminalu sesji).
(function (root) {
  'use strict';
  const KEYS = {
    esc: '\x1b', ctrlc: '\x03', ctrld: '\x04', ctrll: '\x0c', ctrlr: '\x12', ctrlz: '\x1a',
    tab: '\t', stab: '\x1b[Z', enter: '\r', bs: '\x7f',
    up: 'A', down: 'B', right: 'C', left: 'D',
  };

  // strzałki zależą od trybu kursora aplikacji (DECCKM): vim/less/tmux copy-mode chcą ESC O, shell ESC [
  function seq(k, s, appCursor) {
    if (s != null) return s;
    const v = KEYS[k];
    if (v == null) return null;
    return /^[ABCD]$/.test(v) ? (appCursor ? '\x1bO' : '\x1b[') + v : v;
  }

  // send(d) wysyła dane do terminala, appCursor() zwraca bieżący DECCKM, onAction(nazwa, przycisk) dla data-act
  function attach(box, { send, appCursor = () => false, onAction }) {
    box.addEventListener('pointerdown', (e) => e.preventDefault()); // nie zabieraj fokusu / nie chowaj klawiatury
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !box.contains(b)) return;
      if (b.dataset.act) { if (onAction) onAction(b.dataset.act, b); return; }
      const d = seq(b.dataset.k, b.dataset.s, appCursor());
      if (d == null) return;
      send(d);
      if (navigator.vibrate) navigator.vibrate(8);
    });
  }

  const api = { KEYS, seq, attach };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TermKeys = api;
})(typeof window === 'undefined' ? globalThis : window);
