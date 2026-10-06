'use strict';
// Dok shella w Dyspozytorze: xterm podpięty przez /ws?shell=1 do stałej sesji tmux ccp-shell (poza herdr).
// Ctrl+` (desktop): zamknięty -> otwórz i ustaw fokus; otwarty bez fokusu -> fokus; otwarty z fokusem -> zamknij.
// Cmd+` w macOS przełącza okna, Option+litera to polskie znaki, Ctrl+litera w polach tekstowych to skróty Emacsa.
// Telefon: przycisk >_ w nagłówku. Zamknięcie doku rozłącza WS, sesja tmux zostaje.
// Telefon: pod terminalem pasek klawiszy jak w terminalu sesji (term-keys.js) plus Wklej (schowek systemowy,
// bracketed paste bez Entera), Zaznacz (historia tmux jako zwykły tekst z /api/sessions/ccp-shell/log do
// zaznaczenia palcem - w xterm na iPhonie zaznaczanie nie działa) i 📋 (to samo okno Schowka co w sesji).
// Szerokość (desktop): uchwyt na lewej krawędzi doku, przeciąganie myszą/palcem albo strzałki, dwuklik = domyślna.
// Zapamiętana jako ułamek szerokości widoku w localStorage['ccp-shell-w'] (zmiana rozmiaru okna zachowuje proporcje),
// w CSS przez clamp(), więc dok nigdy nie jest węższy niż SHELL_MIN ani nie zabiera czatowi mniej niż CHAT_MIN.
// Telefon (<900 px): dok na całą treść, uchwytu nie ma.

// klawisz na lewo od 1: Backquote; na klawiaturach ISO Maca Chrome zgłasza go jako IntlBackslash
function isShellShortcut(e) {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    && (e.code === 'Backquote' || e.code === 'IntlBackslash' || e.key === '`');
}

const SHELL_MIN = 360, CHAT_MIN = 420; // px: ok. 40 kolumn shella przy 14 px; czat wciąż mieści pole i Wyślij

// szerokość doku przy wskaźniku w x: od x do prawej krawędzi widoku, w granicach [SHELL_MIN, viewW - CHAT_MIN]
function dockWidth(x, right, viewW) {
  const max = Math.max(SHELL_MIN, viewW - CHAT_MIN);
  return Math.round(Math.min(max, Math.max(SHELL_MIN, right - x)));
}
// zapisany ułamek albo null (brak, śmieci, poza 0..1 = szerokość domyślna z CSS)
function parseRatio(v) {
  const r = Number(v);
  return v != null && v !== '' && Number.isFinite(r) && r > 0 && r < 1 ? r : null;
}
// wartość --shell-w: % liczy się od szerokości gridu #v-mozg, granice pikselowe pilnuje clamp
function widthCss(ratio) {
  return `clamp(${SHELL_MIN}px, ${(ratio * 100).toFixed(2)}%, max(${SHELL_MIN}px, calc(100% - ${CHAT_MIN}px)))`;
}

if (typeof module !== 'undefined') module.exports = { isShellShortcut, dockWidth, parseRatio, widthCss, SHELL_MIN, CHAT_MIN };

if (typeof document !== 'undefined') (() => {
  const dock = document.getElementById('shell-dock');
  const view = document.getElementById('v-mozg');
  const btn = document.getElementById('mozg-shell');
  const conn = document.getElementById('shell-conn');
  const sel = document.getElementById('shell-sel');
  const selBtn = document.querySelector('#shell-keys [data-act="select"]');
  const handle = document.getElementById('shell-resize');
  const KEY = 'ccp-shell-dock', WKEY = 'ccp-shell-w';
  let term = null, fit = null, ws = null, retry = 0, retryTimer = null, drag = null, fitTimer = null;

  const store = (v) => { try { localStorage.setItem(KEY, v ? '1' : ''); } catch {} };
  const stored = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
  const isOpen = () => !dock.hidden;
  const shown = () => isOpen() && !view.hidden && dock.clientWidth > 0;
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  function ensureTerm() {
    if (term) return;
    term = new Terminal({
      fontSize: Look.get().term, // rozmiar z arkusza Wygląd (look.js, ccp-fs), wspólny z terminalem sesji
      fontFamily: 'ui-monospace, Menlo, "DejaVu Sans Mono", "Cascadia Mono", monospace',
      scrollback: 1000,
      macOptionClickForcesSelection: true, // tmux ma mysz włączoną (kółko = przewijanie), Option+przeciągnięcie zaznacza tekst
      ...Look.term(), // kolory motywu z tokenów (look.js), wspólne z terminalem sesji
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('shell-xterm'));
    term.attachCustomKeyEventHandler((e) => !isShellShortcut(e) && !NavKeys.isNav(e)); // skróty nie trafiają do shella (Ctrl+` jako NUL)
    term.onData((d) => send({ t: 'i', d }));
    term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }));
    // podczas przeciągania uchwytu fit (i resize pty/tmux) dopiero po 120 ms spokoju, po puszczeniu od razu
    new ResizeObserver(() => {
      clearTimeout(fitTimer);
      if (drag) fitTimer = setTimeout(refit, 120); else refit();
      if (shown()) handle.setAttribute('aria-valuenow', String(Math.round(dock.offsetWidth / view.clientWidth * 100)));
    }).observe(dock);
    let resolvedTheme = Look.get().resolved;
    Look.onChange(({ resolved }) => { if (resolved !== resolvedTheme) { resolvedTheme = resolved; Object.assign(term.options, Look.term()); } });
    Look.onChange(({ term: px }) => { if (px === term.options.fontSize) return; term.options.fontSize = px; if (shown()) try { fit.fit(); } catch {} });
  }

  function refit() {
    clearTimeout(fitTimer);
    if (fit && shown()) try { fit.fit(); } catch {}
  }

  // ---- szerokość doku ----
  const storeW = (r) => { try { if (r) localStorage.setItem(WKEY, r.toFixed(4)); else localStorage.removeItem(WKEY); } catch {} };
  const storedW = () => { try { return parseRatio(localStorage.getItem(WKEY)); } catch { return null; } };
  function applyWidth() {
    const r = storedW();
    if (r) view.style.setProperty('--shell-w', widthCss(r)); else view.style.removeProperty('--shell-w'); // aria-valuenow: ResizeObserver
  }
  // px -> ułamek szerokości widoku (zapis) i od razu ta sama szerokość przez clamp
  function setWidth(px) {
    storeW(px / view.clientWidth);
    applyWidth();
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !shown()) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    const v = view.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, right: v.right, w: view.clientWidth, px: dock.offsetWidth, moved: false };
    document.body.classList.add('shell-resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) < 3) return; // klik / dwuklik bez ruchu nie zapisuje szerokości
    drag.moved = true;
    drag.px = dockWidth(e.clientX, drag.right, drag.w);
    view.style.setProperty('--shell-w', drag.px + 'px');
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    document.body.classList.remove('shell-resizing');
    if (d.moved) setWidth(d.px);
    refit();
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);
  handle.addEventListener('dblclick', () => { storeW(null); applyWidth(); });
  handle.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: 1, ArrowRight: -1 }[e.key]; // dok jest po prawej: w lewo = szerzej
    if (!step || !shown()) return;
    e.preventDefault();
    const v = view.getBoundingClientRect();
    setWidth(dockWidth(v.right - dock.offsetWidth - step * (e.shiftKey ? 96 : 24), v.right, view.clientWidth));
  });
  applyWidth();

  function connect() {
    clearTimeout(retryTimer);
    if (!shown() || (ws && ws.readyState <= 1)) return;
    try { fit.fit(); } catch {}
    conn.textContent = 'łączenie…';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws?shell=1&c=${term.cols}&r=${term.rows}`);
    ws = sock;
    sock.onopen = () => { conn.textContent = ''; retry = 0; term.reset(); };
    sock.onmessage = (e) => term.write(e.data);
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (!isOpen()) return;
      conn.textContent = 'rozłączono, ponawiam…';
      if (document.visibilityState === 'visible') retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    if (ws) { const s = ws; ws = null; s.close(); }
  }

  // wklejka jak w terminalu sesji: bracketed paste, wieloliniowa czeka na Enter (bash/readline ma tryb 2004 włączony)
  function paste(text) {
    if (!ws || ws.readyState !== 1) return false;
    setSel(false);
    send({ t: 'i', d: ClipHistory.pasteSeq(text) });
    ClipHistory.store.add(text);
    if (navigator.vibrate) navigator.vibrate(8);
    return true;
  }
  const CLIPS = { paste, who: 'Sesja shella', where: 'do shella' };
  // iOS pokazuje dymek „Wklej” i dopiero po jego tapnięciu oddaje tekst; odmowa albo pusto = okno Schowka z historią
  async function pasteClipboard() {
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch {}
    if (!t || !t.trim()) { openClips(CLIPS, 'Nie dostałem tekstu ze schowka. Tapnij pozycję z historii albo przytrzymaj pole niżej → Wklej → Dodaj.', true); return; }
    if (paste(t)) return;
    ClipHistory.store.add(t);
    openClips(CLIPS, 'Shell nie jest połączony, nie wkleiłem. Tekst jest w historii.', true);
  }

  async function setSel(on) {
    if (on === !sel.hidden) return;
    sel.hidden = !on;
    selBtn.setAttribute('aria-pressed', String(on));
    if (!on) return;
    if (document.activeElement && dock.contains(document.activeElement)) document.activeElement.blur(); // chowa klawiaturę, palec zaznacza
    sel.textContent = 'Ładowanie…';
    try {
      const text = await api('/api/sessions/ccp-shell/log?lines=3000');
      if (sel.hidden) return;
      sel.textContent = String(text).replace(/\s+$/, '') + '\n';
      sel.scrollTop = sel.scrollHeight;
    } catch (e) { if (!sel.hidden) sel.textContent = e.message; }
  }

  TermKeys.attach(document.getElementById('shell-keys'), {
    send: (d) => { setSel(false); send({ t: 'i', d }); },
    appCursor: () => !!term && term.modes.applicationCursorKeysMode,
    onAction: (act) => {
      if (act === 'paste') pasteClipboard();
      else if (act === 'select') setSel(sel.hidden);
      else if (act === 'clips') openClips(CLIPS);
    },
  });

  function setOpen(on, focus = true) {
    dock.hidden = !on;
    view.classList.toggle('with-shell', on);
    btn.setAttribute('aria-pressed', String(on));
    store(on);
    if (!on) {
      setSel(false);
      disconnect();
      if (focus && !view.hidden && matchMedia('(min-width: 900px)').matches) document.getElementById('mozg-text').focus({ preventScroll: true });
      return;
    }
    ensureTerm();
    requestAnimationFrame(() => {
      connect();
      if (focus && shown()) term.focus();
    });
  }

  btn.addEventListener('click', () => setOpen(!isOpen()));
  document.getElementById('shell-close').addEventListener('click', () => setOpen(false));
  const toggle = () => {
    if (!isOpen()) setOpen(true);
    else if (dock.contains(document.activeElement)) setOpen(false);
    else term.focus();
  };
  document.addEventListener('keydown', (e) => {
    if (!isShellShortcut(e) || view.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }, true);
  // ⌘T w CC Panel.app (nav-keys.js): toggle jak Ctrl+`, open = otwórz albo tylko ustaw fokus
  window.ShellDock = Object.freeze({ toggle, open: () => (isOpen() ? term.focus() : setOpen(true)) });

  // widok Dyspozytora pokazany ponownie (powrót z listy sesji) albo karta wraca z tła: podłącz otwarty dok
  new MutationObserver(() => { if (shown()) requestAnimationFrame(connect); })
    .observe(view, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && shown()) connect(); });

  if (stored() && matchMedia('(min-width: 900px)').matches) setOpen(true, false); // na telefonie dok zasłania czat - nie otwieraj sam
})();
