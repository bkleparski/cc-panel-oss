// Installed only in the top-level panel document. No IPC, token or API fetch here.
(() => {
  'use strict';
  const origins = ['https://panel.example.com', 'https://panel.your-tailnet.ts.net'];
  if (window.top !== window || !origins.includes(location.origin)) return;
  const policy = "default-src 'none'; script-src https://panel.example.com https://panel.your-tailnet.ts.net; style-src 'unsafe-inline' https://panel.example.com https://panel.your-tailnet.ts.net; img-src data: blob: https://panel.example.com https://panel.your-tailnet.ts.net; connect-src https://panel.example.com https://panel.your-tailnet.ts.net wss://panel.example.com wss://panel.your-tailnet.ts.net; font-src https://panel.example.com https://panel.your-tailnet.ts.net; frame-src 'none'; object-src 'none'; base-uri 'none'";
  const installPolicy = () => {
    if (!document.head) return false;
    const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = policy;
    document.head.prepend(meta);
    return true;
  };
  if (!installPolicy()) {
    const observer = new MutationObserver(() => { if (installPolicy()) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
  }
  const hasDraft = () => {
    // app.js keeps drafts for inactive threads too. Never discard those on wake.
    if (typeof mozgDrafts !== 'undefined' && [...mozgDrafts.values()].some(v => String(v).trim())) return true;
    if (typeof mozgPendingByThread !== 'undefined' && mozgPendingByThread.size) return true;
    if (typeof mozgFilesByThread !== 'undefined' && [...mozgFilesByThread.values()].some(files => files.length)) return true;
    return [...document.querySelectorAll('textarea, input[type=text], input[type=search], input:not([type])')]
      .some(e => e.value.trim());
  };
  let pendingShell = false;
  function show(shell = false) {
    if (!location.hash.startsWith('#/mozg')) location.hash = '#/mozg';
    if (shell) pendingShell = true;
    applyShell();
  }
  function applyShell() {
    if (!pendingShell) return;
    const view = document.getElementById('v-mozg');
    const button = document.getElementById('mozg-shell');
    if (!view || view.hidden || !button) return;
    if (button.getAttribute('aria-pressed') !== 'true') button.click();
    else document.querySelector('#shell-dock .xterm-helper-textarea')?.focus();
    pendingShell = false;
  }
  // Menu „Panel” (main.rs, ⌘T/⌘D/⌘S): logika w stronie (public/nav-keys.js), więc zmiany nie wymagają
  // przebudowy aplikacji. focused = okno panelu miało fokus (⌘T przełącza dok jak Ctrl+`, inaczej tylko otwiera).
  // Strona bez NavKeys (starsza wersja, błąd ładowania): Dyspozytor/dok przez show(), sesje przez hash.
  function nav(target, focused = true) {
    if (!['terminal', 'dysp', 'sessions'].includes(target)) return;
    if (typeof window.NavKeys?.go === 'function') return window.NavKeys.go(target, { toggle: focused === true });
    if (target === 'sessions') location.hash = '#/sesje';
    else show(target === 'terminal');
  }
  function notice(text, retry) {
    let box = document.getElementById('ccp-desktop-status');
    if (!box) {
      box = document.createElement('aside');
      box.id = 'ccp-desktop-status';
      box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;bottom:0;left:0;z-index:10000;background:var(--panel,#222);color:var(--text,#fff);padding:4px 10px;font:12px system-ui;max-width:100%';
      document.body.append(box);
    }
    box.replaceChildren(document.createTextNode(text));
    if (retry) {
      const button = document.createElement('button');
      button.textContent = 'Odśwież / przełącz (porzuca szkice)';
      button.onclick = retry;
      box.append(button);
    }
  }
  function reconnect(origin) {
    if (!origins.includes(origin)) return;
    const run = () => {
      // Keep route only; never send query parameters containing login data to another origin.
      if (origin === location.origin) location.reload();
      else location.assign(origin + '/' + location.hash);
    };
    if (hasDraft()) notice('CC Panel · ' + location.host + ' · połączenie wymaga odświeżenia; zachowano szkice. ', run);
    else run();
  }
  document.addEventListener('keydown', e => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key) || e.isComposing) return;
    if (!location.hash.startsWith('#/mozg') || document.querySelector('dialog[open]')) return;
    if (e.target.closest?.('input,textarea,select,[contenteditable],.xterm')) return;
    const tabs = [...document.querySelectorAll('#mozg-tabs button[aria-pressed]')];
    const tab = tabs[Number(e.key) - 1];
    if (tab) { e.preventDefault(); tab.click(); }
  }, true);
  Object.defineProperty(window, 'CCPDesktop', { value: Object.freeze({ show, nav, reconnect, notice }) });
  document.addEventListener('DOMContentLoaded', () => {
    // No fixed connection footer (06.10): it covered the input field. LAN/Tailscale is in the window title (main.rs panel_title).
    new MutationObserver(applyShell).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
})();
