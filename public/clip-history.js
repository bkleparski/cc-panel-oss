// Historia schowka cc-panel: teksty skopiowane w panelu (terminal, log, czat Dyspozytora, przyciski „kopiuj”)
// i dodane ręcznie z systemowego schowka. Trzymana tylko w localStorage tej przeglądarki - może zawierać sekrety,
// więc nic nie idzie na serwer poza samą wklejką do sesji.
(function (root) {
  'use strict';
  const LIMIT = 30;         // nieprzypięte pozycje
  const PIN_LIMIT = 20;
  const MAX_CHARS = 100000; // większe wklejki to raczej pomyłka niż prompt

  // ESC i inne znaki sterujące z wklejki nie mogą dojść do terminala: „\x1b[201~” w tekście kończyłby
  // bracketed paste przedwcześnie, a reszta poszłaby jak wpisywana z klawiatury (z Enterem włącznie).
  const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '');

  // przypięte na górze, potem od najnowszych; nieprzypiętych najwyżej LIMIT
  const normalize = (list) => {
    const sorted = [...list].sort((a, b) => (b.pin - a.pin) || (b.at - a.at));
    let free = 0;
    return sorted.filter((x) => x.pin || ++free <= LIMIT);
  };
  function add(list, text, now = Date.now()) {
    const t = clean(text);
    if (!t.trim() || t.length > MAX_CHARS) return list;
    const old = list.find((x) => x.t === t); // ponowne skopiowanie przenosi na górę, przypięcie zostaje
    return normalize([{ t, at: now, pin: !!old?.pin }, ...list.filter((x) => x !== old)]);
  }
  function togglePin(list, t) {
    const it = list.find((x) => x.t === t);
    if (!it || (!it.pin && list.filter((x) => x.pin).length >= PIN_LIMIT)) return list;
    return normalize(list.map((x) => (x === it ? { ...x, pin: !x.pin } : x)));
  }
  const remove = (list, t) => list.filter((x) => x.t !== t);

  // podgląd: pierwsze niepuste linie, skrócone; lines = ile linii ma cały tekst
  function preview(text, lines = 3, width = 160) {
    const all = text.split('\n');
    const shown = all.filter((l) => l.trim()).slice(0, lines).map((l) => (l.length > width ? l.slice(0, width - 1) + '…' : l));
    return { text: shown.join('\n'), lines: all.length };
  }

  // Wklejka do agenta: zawsze bracketed paste, jak z prawdziwego terminala. Claude Code i Codex traktują
  // ją jako jeden blok (bez wysyłania po każdej linii), Enter zostaje dla użytkownika. Nowe linie jako \r,
  // tak jak wysyła je xterm.js i Terminal.app przy wklejaniu.
  const pasteSeq = (text) => `\x1b[200~${clean(text).replace(/\n/g, '\r')}\x1b[201~`;

  const KEY = 'ccp-clips';
  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => x && typeof x.t === 'string') : [];
    } catch { return []; }
  }
  function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {} return list; }
  const store = {
    list: load,
    add: (t) => save(add(load(), t)),
    togglePin: (t) => save(togglePin(load(), t)),
    remove: (t) => save(remove(load(), t)),
    clear: () => { try { localStorage.removeItem(KEY); } catch {} return []; },
    // kopiowanie z przycisków panelu: schowek systemowy + historia
    copy: (t) => { store.add(t); return navigator.clipboard?.writeText(t) ?? Promise.reject(new Error('Brak dostępu do schowka')); },
  };

  const api = { add, togglePin, remove, preview, pasteSeq, clean, LIMIT, PIN_LIMIT, MAX_CHARS, store };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClipHistory = api;
})(typeof window === 'undefined' ? globalThis : window);
