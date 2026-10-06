'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const STATUS = { done: 'skończył ✓', bg: 'czeka · zadania w tle', idle: 'czeka na Ciebie', working: 'pracuje…', approval: 'prosi o zgodę', shell: 'shell' };
// kolejność statusów w oknie wyboru sesji (lista sesji ma własne tryby: public/session-sort.js)
const STATUS_RANK = { working: 0, approval: 1, done: 2, idle: 3, bg: 3, shell: 4 };

// ---------- wysokość przy otwartej klawiaturze ----------
function syncHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  window.scrollTo(0, 0);
}
(window.visualViewport || window).addEventListener('resize', syncHeight);
syncHeight();

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-CCP': '1', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401 && path !== '/api/login') { showView('login'); throw new Error('unauthorized'); }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showView(v) {
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== 'v-' + v;
}

// ---------- wątek mózgu ----------
let mozgTimer = null, mozgPending = null, mozgActive = 'general', mozgThreads = [], mozgLegacy = false, mozgRefreshSeq = 0;
const mozgDrafts = new Map(), mozgPendingByThread = new Map();
let mozgTabsScrolled = null;
const mozgStorage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch {} }
};
const mozgHash = id => MozgTabs.threadUrl(id).slice(1);
function mozgSeen(id) { return Number(mozgStorage.get('ccp-mozg-seen:' + id)) || 0; }
function renderMozgTabs() {
  const box = $('#mozg-tabs');
  box.replaceChildren();
  for (const thread of MozgTabs.sortThreads(mozgThreads)) {
    const chip = el('button', 'chip mozg-tab', thread.title);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(thread.id === mozgActive));
    const marker = MozgTabs.marker(thread, mozgSeen(thread.id));
    if (marker) {
      const dot = el('span', 'mozg-tab-marker ' + marker, marker === 'decision' ? '📡' : '');
      dot.setAttribute('aria-label', marker === 'decision' ? 'Otwarta decyzja' : marker === 'busy' ? 'Pracuje' : 'Nieprzeczytane');
      chip.append(dot);
    }
    chip.addEventListener('click', () => { location.hash = mozgHash(thread.id); });
    box.append(chip);
  }
  const add = el('button', 'chip mozg-tab', '＋');
  add.type = 'button'; add.setAttribute('aria-label', 'Dodaj zakładkę projektu');
  add.disabled = mozgLegacy;
  add.addEventListener('click', openMozgProjects);
  box.append(add);
  if (mozgTabsScrolled !== mozgActive) {
    mozgTabsScrolled = mozgActive;
    const selected = box.querySelector('[aria-pressed="true"]');
    if (selected) requestAnimationFrame(() => { if (selected.isConnected) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  }
  const active = mozgThreads.find(t => t.id === mozgActive);
  $('#mozg-title').textContent = active?.title || BRAIN_NAME;
  $('#mozg-archive').hidden = mozgActive === 'general' || mozgLegacy;
  $('#mozg-panels').hidden = mozgLegacy;
  $('#mozg-archive').disabled = !!active?.busy || mozgPendingByThread.has(mozgActive);
}
function saveMozgDraft() {
  mozgDrafts.set(mozgActive, $('#mozg-text').value);
}
function restoreMozgDraft() {
  mozgPending = mozgPendingByThread.get(mozgActive) || null;
  $('#mozg-text').value = mozgPending?.text || mozgDrafts.get(mozgActive) || '';
  $('#mozg-text').readOnly = !!mozgPending;
  $('#mozg-send').disabled = false;
  $('#mozg-send').textContent = mozgPending ? 'Ponów' : 'Wyślij';
  $('#mozg-error').textContent = '';
  renderMozgFiles();
}
const BRAIN_NAME = 'Dyspozytor';
const MOZG_LABELS = { user_message: 'Ty', reply: BRAIN_NAME, info: BRAIN_NAME, decision: '📡 Decyzja', alarm: '⚠️ Alarm', digest: '📋 Podsumowanie' };
// Mini-markdown mozgu bez innerHTML: akapity, listy "- " i "1. ", **pogrubienie**, `kod`. Tekst zawsze przez textContent.
// Desktop (MacBook: mysz/trackpad): polecenia od agentów do skopiowania jednym kliknięciem (bez „! ”), kod w linii
// w czacie kopiuje się po kliknięciu. Telefon (dotyk) zostaje przy kartach „Kopiuj / Wstaw / ▶ Uruchom” bez zmian.
const desktopCopy = matchMedia('(hover: hover) and (pointer: fine)');
const syncDesktopCopy = () => document.documentElement.classList.toggle('desktop-copy', desktopCopy.matches);
syncDesktopCopy();
desktopCopy.addEventListener?.('change', syncDesktopCopy);
function mozgInline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) parent.append(el('strong', '', part.slice(2, -2)));
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(el('code', '', part.slice(1, -1)));
    else parent.append(document.createTextNode(part));
  }
}
// Ratunek dla scian tekstu: wyliczenia "1) 2)" / "A) B)" w srodku akapitu -> osobne linie, "Rekomenduje/Polecam" -> osobna linia.
function mozgSplitWall(text) {
  if (text.includes('\n') || text.length < 200) return text;
  return text
    .replace(/\s+(?=(?:\d{1,2}|[A-D])\)\s)/g, '\n')
    .replace(/\s+(?=(?:Rekomenduję|Polecam|Co dalej\?|Otwarte:|Nowe ryzyka:))/g, '\n\n')
    .replace(/^([^\n]{20,200}?[.:?])\s+/, '$1\n\n')
    .replace(/^(\s*)((?:\d{1,2}|[A-D])\))\s/gm, '$1$2 ');
}
function mozgRich(text) {
  const box = el('div', 'mozg-rich');
  let list = null, para = null;
  for (const raw of mozgSplitWall(String(text || '').replace(/```/g, '')).split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/), num = line.match(/^\s*(\d+|[A-D])[.)]\s+(.*)$/);
    if (bullet || num) {
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag, ''); box.append(list); }
      const li = el('li', '');
      if (num && /[A-D]/.test(num[1])) li.append(el('strong', '', num[1] + ') '));
      mozgInline(li, bullet ? bullet[1] : num[2]); list.append(li); para = null;
    } else if (!line.trim()) { list = null; para = null; }
    else {
      list = null;
      if (!para) { para = el('p', ''); box.append(para); } else para.append(document.createElement('br'));
      mozgInline(para, line);
    }
  }
  const first = box.firstElementChild;
  if (first && first.tagName === 'P' && first.textContent.length <= 160) first.classList.add('lead');
  for (const p of box.querySelectorAll('p')) if (/^(Rekomenduję|Polecam)/.test(p.textContent)) p.classList.add('lead');
  return box;
}
function messageUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const isBrainPane = (pane) => typeof pane?.tabLabel === 'string' && pane.tabLabel.startsWith('mozg-g');
// stan Dyspozytora: na komputerze słowem obok >_, na telefonie ikoną (online = brak ikony), pełny tekst po tapnięciu (#mozg-status-pop)
function setMozgStatus(t) {
  const b = $('#mozg-status'), k = HdrIcons.mozgStatusKind(t);
  $('#mozg-status-text').textContent = t;
  b.classList.toggle('is-online', k.kind === 'online');
  if (b.dataset.kind !== k.kind) {
    b.dataset.kind = k.kind;
    const ico = b.querySelector('.mozg-st-ico');
    ico.className = 'mozg-st-ico ' + (k.kind === 'work' ? 'si si-work' : k.kind === 'err' ? 'si si-err' : 'st-' + k.kind);
    ico.innerHTML = k.kind === 'online' ? ''
      : k.kind === 'work' || k.kind === 'err' ? StatusIcons.statusSvg(k.kind === 'work' ? 'working' : 'error') : HdrIcons.svg(k.kind);
  }
  b.title = k.label;
  b.setAttribute('aria-label', k.label);
  const pop = $('#mozg-status-pop');
  pop.textContent = k.label;
  if (k.kind === 'online') showStatusPop(false);
}
function showStatusPop(open) {
  const b = $('#mozg-status'), pop = $('#mozg-status-pop');
  if (open === undefined) open = pop.hidden;
  pop.hidden = !open;
  b.setAttribute('aria-expanded', String(open));
}
// menu ⋯ (telefon): pozycje klikają oryginalne przyciski nagłówka, ich hidden/disabled kopiujemy przy otwarciu
function showMoreMenu(open) {
  const menu = $('#mozg-more-menu');
  if (open === undefined) open = menu.hidden;
  if (open) for (const it of menu.querySelectorAll('[data-sel]')) {
    const t = $(it.dataset.sel);
    it.hidden = !t || t.hidden;
    it.disabled = !t || t.disabled;
  }
  menu.hidden = !open;
  $('#mozg-more').setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('[role="menuitem"]:not([hidden]):not(:disabled)')?.focus({ preventScroll: true });
}
$('#mozg-status').addEventListener('click', (e) => { e.stopPropagation(); showMoreMenu(false); showStatusPop(); });
$('#mozg-more').addEventListener('click', (e) => { e.stopPropagation(); showStatusPop(false); showMoreMenu(); });
$('#mozg-more-menu').addEventListener('click', (e) => {
  const it = e.target.closest('[role="menuitem"]');
  if (!it) return;
  showMoreMenu(false);
  if (it.dataset.sel) $(it.dataset.sel)?.click();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#mozg-status-pop')) showStatusPop(false);
  if (!e.target.closest('#mozg-more-menu')) showMoreMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || ($('#mozg-more-menu').hidden && $('#mozg-status-pop').hidden)) return;
  const back = !$('#mozg-more-menu').hidden;
  showMoreMenu(false); showStatusPop(false);
  if (back) $('#mozg-more').focus();
});
for (const e of $$('[data-hi]')) e.innerHTML = HdrIcons.svg(e.dataset.hi);
// sesje agentów do przycisków „Przejdź” (herdr + tmux); w wątku najwyżej co 5 s, przed przejściem zawsze świeże
let mozgSessAt = 0, mozgSess = [];
async function mozgSessions(force) {
  if (!force && Date.now() - mozgSessAt < 5000) return mozgSess;
  const [hd, tm] = await Promise.all([api('/api/herdr'), api('/api/sessions')]);
  mozgSessAt = Date.now();
  return (mozgSess = MozgWaiting.candidates(hd.items, tm));
}
const JUMP_STATUS = { approval: 'prosi o zgodę', blocked: 'prosi o zgodę', idle: 'czeka na Ciebie', done: 'czeka na Ciebie', bg: 'czeka · zadania w tle', working: 'już nie czeka · pracuje' };
// osobny przycisk na każdą sesję z wiadomości; cel po stabilnym kluczu, nie po nazwie
function jumpBtns(refs) {
  const box = el('div', 'mozg-jumps');
  for (const r of refs) {
    const b = el('button', 'act-btn mozg-jump' + (r.waiting ? '' : ' stale'));
    b.type = 'button';
    const st = JUMP_STATUS[r.status] || STATUS[r.status] || r.status || '';
    b.append(el('span', 'mozg-jump-go', `Przejdź do ${r.label} →`), el('span', 'mozg-jump-st', st));
    b.title = `Otwórz sesję ${r.label}` + (st ? ` (${st})` : '');
    b.addEventListener('click', () => jumpTo(r, b));
    box.append(b);
  }
  return box;
}
// sesja zniknęła = komunikat na przycisku i lista sesji; istnieje, ale już nie czeka = i tak ją otwieramy
async function jumpTo(r, b) {
  let now;
  try { now = MozgWaiting.resolve(r.key, await mozgSessions(true)); }
  catch (e) { b.querySelector('.mozg-jump-st').textContent = 'brak połączenia - spróbuj jeszcze raz'; return; }
  if (now) { location.hash = now.hash; return; }
  b.disabled = true;
  b.classList.add('stale');
  b.querySelector('.mozg-jump-st').textContent = 'sesja już nie istnieje - otwieram listę sesji';
  setTimeout(() => { location.hash = SESSIONS_HASH; }, 1500);
}
async function refreshMozg() {
  clearTimeout(mozgTimer);
  if (!document.hidden) refreshSummary();
  let busy = false;
  const activeId = mozgActive, seq = ++mozgRefreshSeq;
  const current = () => seq === mozgRefreshSeq && mozgActive === activeId && !$('#v-mozg').hidden;
  try {
    const list = await api('/api/mozg/threads');
    if (!current()) return;
    mozgThreads = list.threads; mozgLegacy = list.legacy;
    if (!mozgThreads.some(t => t.id === activeId)) { replaceHash(mozgHash('general')); return; }
    renderMozgTabs();
    const status = await api('/api/mozg/status?thread_id=' + encodeURIComponent(activeId));
    if (!current()) return;
    setMozgStatus(status.online ? 'online' : 'offline');
    if (status.online) {
      const thread = await api('/api/mozg/thread?thread_id=' + encodeURIComponent(activeId));
      const messages = thread.messages;
      busy = thread.busy;
      const cands = await mozgSessions().catch(() => mozgSess);
      if (!current()) return;
      // „Przejdź do sesji” przy wiadomościach, że sesja czeka (MozgWaiting); zmiana statusu też przebudowuje wątek
      const jumps = messages.map((m) => m.text && !['user_message', 'activity'].includes(m.level) ? MozgWaiting.refs(m.text, cands) : []);
      const box = $('#mozg-thread');
      const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      // bez zmian w wątku nie przebudowujemy DOM: zaznaczenie myszą i „Skopiowane ✓” nie znikają co 5 s;
      // trwające zaznaczenie w wątku odkłada przebudowę do następnego odświeżenia
      const key = JSON.stringify([activeId, messages, busy, thread.state, thread.retention_days, desktopCopy.matches, jumps]);
      const sel = getSelection();
      const selecting = sel && !sel.isCollapsed && sel.anchorNode && box.contains(sel.anchorNode);
      if (key === box.dataset.key || selecting) {
        if (!document.hidden) { mozgStorage.set('ccp-mozg-seen:' + activeId, Date.now() / 1000); renderMozgTabs(); }
        setMozgStatus(busy ? (thread.state === 'queued' ? 'czeka w kolejce' : 'pracuje') : 'online');
        return;
      }
      box.dataset.key = key;
      box.replaceChildren(...messages.map((m, i) => {
        const row = el('article', 'mozg-message ' + (m.level === 'user_message' ? 'user' : m.level));
        if (m.level === 'activity') {
          row.append(el('small', 'muted', `${new Date(m.created * 1000).toLocaleTimeString()} · ${m.text}`));
          return row;
        }
        const label = MOZG_LABELS[m.level] || m.level;
        const when = new Date(m.created * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        row.append(el('small', 'muted', `${label} · ${when}${m.level === 'user_message' && m.state !== 'done' ? ' · ' + m.state : ''}`));
        if (m.text) row.append(mozgRich(m.text));
        if (jumps[i].length) row.append(jumpBtns(jumps[i]));
        if (m.text && m.level !== 'user_message') {
          const cmds = desktopCopy.matches ? AgentCmds.copyables(m.text) : AgentCmds.extract(m.text);
          if (cmds.length) row.append(cmdCards(cmds, false));
        }
        if (m.attachments?.length) row.append(mozgImages(m.attachments, m.level === 'user_message', thread.retention_days));
        return row;
      }));
      setMozgStatus(busy ? (thread.state === 'queued' ? 'czeka w kolejce' : 'pracuje') : 'online');
      if (busy) box.append(el('div', 'mozg-working', thread.state === 'queued' ? `${BRAIN_NAME} czeka w kolejce…` : `${BRAIN_NAME} pracuje…`));
      if (!document.hidden) { mozgStorage.set('ccp-mozg-seen:' + activeId, Date.now() / 1000); renderMozgTabs(); }
      if (atEnd) box.scrollTop = box.scrollHeight;
    }
  } catch (e) { if (current()) setMozgStatus(e.message); }
  finally { if (current()) mozgTimer = setTimeout(refreshMozg, busy ? 2000 : 5000); }
}
$('#mozg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#mozg-text').value, sendingId = mozgActive;
  if (!mozgPending) {
    let files = mozgFilesByThread.get(sendingId) || [];
    if (files.some(f => f.status === 'up')) {
      $('#mozg-send').disabled = true;
      $('#mozg-error').textContent = 'Czekam, aż obrazy się wyślą…';
      await Promise.all(files.map(f => f.promise));
      $('#mozg-send').disabled = false;
      $('#mozg-error').textContent = '';
      if (mozgActive !== sendingId) return;
      files = mozgFilesByThread.get(sendingId) || [];
    }
    if (files.some(f => f.status !== 'ok')) { $('#mozg-error').textContent = 'Usuń obrazy z błędem (✕) i wyślij ponownie.'; return; }
  }
  const files = mozgPending ? mozgPending.attachments || [] : (mozgFilesByThread.get(sendingId) || []).map(f => f.meta);
  if (!(text.trim() || files.length) || Array.from(text).length > 20000) return;
  if (mozgPending && mozgPending.text !== text) {
    $('#mozg-error').textContent = 'Najpierw ponów poprzednią wiadomość — jej dostarczenie nie zostało potwierdzone.';
    $('#mozg-text').value = mozgPending.text;
    return;
  }
  mozgPending ||= { client_message_id: messageUUID(), text, thread_id: sendingId, ...(files.length ? { attachments: files } : {}) };
  const pending = mozgPending;
  mozgPendingByThread.set(sendingId, pending);
  $('#mozg-send').disabled = true;
  $('#mozg-text').readOnly = true;
  $('#mozg-error').textContent = '';
  try {
    await api('/api/mozg/message', { method: 'POST', body: pending });
    mozgPendingByThread.delete(sendingId);
    mozgDrafts.delete(sendingId);
    clearMozgFiles(sendingId);
    if (mozgActive !== sendingId) return;
    mozgPending = null;
    $('#mozg-text').value = '';
    $('#mozg-send').textContent = 'Wyślij';
    refreshMozg();
  } catch (e) { if (mozgActive === sendingId) { $('#mozg-error').textContent = e.message; $('#mozg-send').textContent = 'Ponów'; } }
  finally { if (mozgActive === sendingId) { $('#mozg-send').disabled = false; $('#mozg-text').readOnly = !!mozgPending; renderMozgFiles(); } }
});
// Enter wysyła, Shift+Enter = nowa linia. Na dotyku bez fizycznej klawiatury (iPhone) Enter zostaje nową linią, wysyłka przyciskiem.
const mozgTouchOnly = matchMedia('(hover: none) and (pointer: coarse)');
const mozgEnterSends = () => !mozgTouchOnly.matches;
function syncMozgEnterHint() {
  if (mozgEnterSends()) $('#mozg-text').setAttribute('enterkeyhint', 'send');
  else $('#mozg-text').removeAttribute('enterkeyhint');
}
syncMozgEnterHint();
mozgTouchOnly.addEventListener?.('change', syncMozgEnterHint);
$('#mozg-text').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || !mozgEnterSends()) return;
  e.preventDefault();
  if ($('#mozg-send').disabled) return; // wysyłka albo upload obrazów w toku
  const hasFiles = mozgPending ? !!mozgPending.attachments?.length : !!(mozgFilesByThread.get(mozgActive) || []).length;
  if (!$('#mozg-text').value.trim() && !hasFiles) return;
  $('#mozg-form').requestSubmit();
});

// ---------- obrazy w czacie mózgu ----------
// Upload od razu po dodaniu (wysłanie wiadomości nie czeka na sieć), duże zdjęcia i HEIC przekodowane w przeglądarce do JPEG.
const mozgFilesByThread = new Map(); // zakładka -> [{key, status: up|ok|err, url, meta, error, promise}]
const mozgImgCache = new Map();      // id -> <img> w historii (odświeżanie co 2-5 s nie pobiera i nie miga)
function mozgImages(list, fromUser, retentionDays) {
  const box = el('div', 'mozg-images');
  for (const a of list) {
    if (a.expired) {
      box.append(el('div', 'mozg-image-gone', `obraz usunięty po ${retentionDays || 30} dniach`));
      continue;
    }
    let img = mozgImgCache.get(a.id);
    if (!img) {
      img = el('img');
      img.src = '/api/mozg/attachment/' + a.id;
      img.alt = a.name || (fromUser ? 'Obraz od Ciebie' : 'Obraz od Dyspozytora'); img.loading = 'lazy';
      if (a.name) img.title = a.name;
      img.addEventListener('click', () => openMozgImage(a));
      mozgImgCache.set(a.id, img);
    }
    box.append(img);
  }
  return box;
}
// Podgląd: obraz w nakładce wewnątrz aplikacji (✕, tap w obraz/tło, Escape, gest wstecz). „Pobierz” nigdy nie nawiguje
// okna do pliku (iOS standalone = pułapka bez wyjścia): iPhone/PWA - arkusz udostępniania z „Zapisz obraz” (Zdjęcia)
// i „Zachowaj w Plikach”, desktop - zwykłe pobranie. Plik do share() pobierany z góry, bo wymaga świeżego dotknięcia.
let mozgShareFile = null, mozgImageCur = null, mozgImageBack = false;
const mozgSaveEnv = () => ({
  canShareFiles: !!(navigator.canShare && navigator.share),
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  touch: mozgTouchOnly.matches,
  ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
});
function mozgImageStatus(text, isErr) {
  const s = $('#mozg-image-status');
  s.textContent = text; s.className = 'small ' + (isErr ? 'err' : 'muted');
}
// wpis historii dla podglądu: gest wstecz / przycisk wstecz Androida zamyka nakładkę zamiast wychodzić z ekranu
const pushMozgImageState = () => history.pushState({ ...(history.state || {}), ccpImage: 1 }, '', location.href);
window.addEventListener('popstate', () => {
  const dlg = $('#dlg-mozg-image');
  if (mozgImageBack) { mozgImageBack = false; if (dlg.open) pushMozgImageState(); return; } // otwarty ponownie w trakcie cofania
  if (dlg.open && !history.state?.ccpImage) dlg.close();
});
$('#dlg-mozg-image').addEventListener('close', () => {
  mozgImageCur = null; mozgShareFile = null; mozgPinch = null;
  document.documentElement.classList.remove('ccp-noscroll');
  if (history.state?.ccpImage && !mozgImageBack) { mozgImageBack = true; history.back(); }
});
// Rozmiar obrazu liczony tutaj (MozgImages.viewSize), nie przez CSS: iOS Safari nie kurczył <img> we flexie i długa
// infografika wychodziła poza ekran razem z ✕ i przyciskami. Długi obraz startuje na szerokość ekranu i przewija się
// w pionie wewnątrz nakładki; tapnięcie w obraz przełącza cały/powiększony, dwa palce - własny pinch-zoom.
let mozgView = null, mozgImgW = 0, mozgPinch = null, mozgPinchAt = 0;
function mozgImageArea() {
  const sc = $('#mozg-image-scroll'), cs = getComputedStyle(sc);
  return {
    w: sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    h: sc.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  };
}
// szerokość obrazu w, punkt (cx, cy) obszaru przewijania zostaje pod palcem / kursorem
function setMozgImgW(w, cx, cy) {
  const img = $('#mozg-image-full'), sc = $('#mozg-image-scroll');
  w = Math.round(Math.max(mozgView.fit.w, Math.min(mozgView.maxW, w)));
  const old = img.offsetWidth ? { w: img.offsetWidth, h: img.offsetHeight, x: img.offsetLeft, y: img.offsetTop } : null;
  const fx = old && cx != null ? (sc.scrollLeft + cx - old.x) / old.w : 0;
  const fy = old && cy != null ? (sc.scrollTop + cy - old.y) / old.h : 0;
  mozgImgW = w;
  img.style.width = w + 'px';
  img.style.height = (w === mozgView.fit.w ? mozgView.fit.h : Math.round(w * img.naturalHeight / img.naturalWidth)) + 'px';
  img.classList.toggle('zoomed', w > mozgView.fit.w + 1);
  if (old && cx != null) {
    sc.scrollLeft = img.offsetLeft + fx * img.offsetWidth - cx;
    sc.scrollTop = img.offsetTop + fy * img.offsetHeight - cy;
  }
}
function layoutMozgImage(keep) {
  const img = $('#mozg-image-full'), sc = $('#mozg-image-scroll');
  if (!$('#dlg-mozg-image').open || !img.naturalWidth) return;
  const area = mozgImageArea(), wasFit = mozgView && mozgImgW <= mozgView.fit.w + 1;
  mozgView = MozgImages.viewSize(img.naturalWidth, img.naturalHeight, Math.max(1, area.w), Math.max(1, area.h));
  setMozgImgW(!keep ? mozgView.start : wasFit ? mozgView.fit.w : mozgImgW);
  if (!keep) { sc.scrollTop = 0; sc.scrollLeft = Math.max(0, (sc.scrollWidth - sc.clientWidth) / 2); }
  img.classList.remove('pending');
}
$('#mozg-image-full').addEventListener('load', () => layoutMozgImage(false));
// obrót, klawiatura, podpowiedź w pasku (wyższy pasek = niższy obszar obrazu)
if (window.ResizeObserver) new ResizeObserver(() => layoutMozgImage(true)).observe($('#mozg-image-scroll'));
else (window.visualViewport || window).addEventListener('resize', () => layoutMozgImage(true));
$('#mozg-image-full').addEventListener('click', (e) => {
  if (!mozgView || Date.now() - mozgPinchAt < 400) return;
  const r = $('#mozg-image-scroll').getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
  const { fit, wide } = mozgView;
  if (mozgImgW > fit.w + 1) setMozgImgW(fit.w, cx, cy);
  else setMozgImgW(wide.w > fit.w + 1 ? wide.w : fit.w * 2, cx, cy);
});
const mozgTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
$('#mozg-image-scroll').addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && mozgView) mozgPinch = { d: mozgTouchDist(e.touches) || 1, w: mozgImgW };
}, { passive: true });
// tylko dwa palce: preventDefault blokuje zoom całej strony; jeden palec przewija natywnie (bez preventDefault)
$('#mozg-image-scroll').addEventListener('touchmove', (e) => {
  if (!mozgPinch || e.touches.length !== 2) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
  setMozgImgW(mozgPinch.w * mozgTouchDist(e.touches) / mozgPinch.d, cx, cy);
}, { passive: false });
const mozgPinchEnd = (e) => { if (mozgPinch && e.touches.length < 2) { mozgPinch = null; mozgPinchAt = Date.now(); } };
$('#mozg-image-scroll').addEventListener('touchend', mozgPinchEnd);
$('#mozg-image-scroll').addEventListener('touchcancel', mozgPinchEnd);
$('#dlg-mozg-image').addEventListener('gesturestart', (e) => e.preventDefault()); // iOS: bez zoomu całej aplikacji
function openMozgImage(a) {
  const url = '/api/mozg/attachment/' + a.id;
  const dlg = $('#dlg-mozg-image');
  const img = $('#mozg-image-full');
  mozgView = null;
  img.classList.add('pending');
  img.style.width = img.style.height = '';
  img.src = url;
  $('#mozg-image-name').textContent = a.name || '';
  mozgImageStatus('');
  mozgImageCur = a; mozgShareFile = null;
  const btn = $('#mozg-image-download');
  const mode = MozgImages.saveMode(mozgSaveEnv());
  btn.disabled = mode === 'share';
  btn.textContent = mode === 'share' ? 'Pobierz…' : 'Pobierz';
  if (!dlg.open) { dlg.showModal(); if (!mozgImageBack) pushMozgImageState(); }
  document.documentElement.classList.add('ccp-noscroll');
  if (img.complete && img.naturalWidth) layoutMozgImage(false);
  if (mode !== 'share') return;
  const ext = { 'image/png': 'png', 'image/webp': 'webp' }[a.mime] || 'jpg';
  fetch(url, { credentials: 'same-origin' }).then(r => (r.ok ? r.blob() : Promise.reject(new Error(r.status)))).then((blob) => {
    if (mozgImageCur !== a) return;
    const file = new File([blob], a.name || `obraz-${a.id.slice(0, 8)}.${ext}`, { type: blob.type || a.mime });
    if (navigator.canShare({ files: [file] })) mozgShareFile = file;
  }).catch(() => {}).finally(() => {
    if (mozgImageCur === a) { btn.disabled = false; btn.textContent = 'Pobierz'; }
  });
}
$('#mozg-image-download').addEventListener('click', async () => {
  const a = mozgImageCur;
  if (!a) return;
  const env = mozgSaveEnv();
  const mode = MozgImages.saveMode({ ...env, canShareFiles: env.canShareFiles && !!mozgShareFile });
  if (mode === 'share') {
    try { await navigator.share({ files: [mozgShareFile] }); }
    catch (e) { if (e.name !== 'AbortError') mozgImageStatus('Nie udało się udostępnić - przytrzymaj obraz i wybierz „Zapisz w Zdjęciach”.', true); }
  } else if (mode === 'hold') {
    mozgImageStatus('Przytrzymaj obraz i wybierz „Zapisz w Zdjęciach”.');
  } else {
    // Content-Disposition: attachment - przeglądarka zapisuje plik, strona zostaje na miejscu
    const link = el('a');
    link.href = '/api/mozg/attachment/' + a.id + '?download=1' + (a.name ? '&name=' + encodeURIComponent(a.name) : '');
    link.download = a.name || '';
    link.hidden = true;
    document.body.append(link); link.click(); link.remove();
  }
});
$('#mozg-image-close').addEventListener('click', () => $('#dlg-mozg-image').close());
$('#mozg-image-x').addEventListener('click', () => $('#dlg-mozg-image').close());
// klik w tło zamyka; obraz przełącza powiększenie, pasek z przyciskami ma własne akcje
$('#dlg-mozg-image').addEventListener('click', (e) => {
  if (e.target.closest('.mozg-image-bar') || e.target.id === 'mozg-image-full' || Date.now() - mozgPinchAt < 400) return;
  $('#dlg-mozg-image').close();
});
function renderMozgFiles() {
  const files = mozgFilesByThread.get(mozgActive) || [], locked = !!mozgPendingByThread.get(mozgActive);
  const box = $('#mozg-files');
  const shown = locked ? (mozgPendingByThread.get(mozgActive).attachments || []).map(meta => ({ key: meta.id, status: 'ok', url: '/api/mozg/attachment/' + meta.id,
    name: files.find(f => f.meta?.id === meta.id)?.name || '' }))
    : files;
  box.hidden = !shown.length;
  box.replaceChildren(...shown.map((f) => {
    const item = el('div', 'mozg-file-item');
    const tile = el('div', 'mozg-file ' + f.status);
    if (f.url) { const img = el('img'); img.src = f.url; img.alt = ''; tile.append(img); }
    if (f.status === 'up') tile.append(el('span', 'mozg-file-state', '…'));
    if (f.status === 'err') { tile.append(el('span', 'mozg-file-state', '!')); item.title = f.error; }
    else if (f.name) item.title = f.name;
    if (!locked) {
      const x = el('button', '', '✕');
      x.type = 'button'; x.setAttribute('aria-label', f.name ? `Usuń ${f.name}` : 'Usuń obraz');
      x.addEventListener('click', () => removeMozgFile(mozgActive, f.key));
      tile.append(x);
    }
    item.append(tile);
    if (f.name) item.append(el('span', 'mozg-file-name', f.name));
    return item;
  }));
  $('#mozg-attach').disabled = locked;
  const err = files.find(f => f.status === 'err');
  if (err && !locked) $('#mozg-error').textContent = err.error;
}
function removeMozgFile(threadId, key) {
  const files = mozgFilesByThread.get(threadId) || [];
  const f = files.find(x => x.key === key);
  if (f?.url) URL.revokeObjectURL(f.url);
  mozgFilesByThread.set(threadId, files.filter(x => x.key !== key));
  $('#mozg-error').textContent = '';
  renderMozgFiles();
}
function clearMozgFiles(threadId) {
  for (const f of mozgFilesByThread.get(threadId) || []) if (f.url) URL.revokeObjectURL(f.url);
  mozgFilesByThread.delete(threadId);
  if (mozgActive === threadId) renderMozgFiles();
}
async function prepareMozgImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); throw new Error('Nie da się odczytać obrazu - wyślij go jako JPEG albo PNG'); }
  const plan = MozgImages.plan(file.type, file.size, img.naturalWidth, img.naturalHeight);
  if (!plan.reencode) return { blob: file, url };
  const canvas = el('canvas');
  canvas.width = plan.width; canvas.height = plan.height;
  canvas.getContext('2d').drawImage(img, 0, 0, plan.width, plan.height); // orientacja EXIF uwzględniona przez przeglądarkę
  URL.revokeObjectURL(url);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', MozgImages.QUALITY));
  if (!blob) throw new Error('Nie udało się zmniejszyć obrazu');
  return { blob, url: URL.createObjectURL(blob) };
}
async function uploadMozgImage(item, file, threadId) {
  try {
    const { blob, url } = await prepareMozgImage(file);
    item.url = url;
    if (mozgActive === threadId) renderMozgFiles();
    if (blob.size > MozgImages.MAX_BYTES) throw new Error('Obraz większy niż 10 MB');
    const res = await fetch('/api/mozg/attachment', { method: 'POST', headers: { 'X-CCP': '1', 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    if (res.status === 401) { showView('login'); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    item.meta = { id: data.id, mime: data.mime, sha256: data.sha256 };
    item.status = 'ok';
  } catch (e) { item.status = 'err'; item.error = (item.name ? `„${item.name}”: ` : '') + e.message; }
  if (mozgActive === threadId) renderMozgFiles();
}
function addMozgFiles(fileList) {
  const threadId = mozgActive;
  if (mozgPendingByThread.has(threadId)) { $('#mozg-error').textContent = 'Najpierw ponów poprzednią wiadomość.'; return; }
  const files = mozgFilesByThread.get(threadId) || [];
  const { take, skipped } = MozgImages.triage(fileList, files.length);
  for (const file of take) {
    const item = { key: messageUUID(), name: file.name || '', status: 'up', url: null, meta: null, error: '' };
    files.push(item);
    item.promise = uploadMozgImage(item, file, threadId);
  }
  mozgFilesByThread.set(threadId, files);
  renderMozgFiles();
  if (skipped.length) $('#mozg-error').textContent = MozgImages.skippedText(skipped); // po renderze: nie nadpisze go błąd kafelka
}
$('#mozg-attach').addEventListener('click', () => $('#mozg-file').click());
$('#mozg-file').addEventListener('change', (e) => { addMozgFiles([...e.target.files]); e.target.value = ''; });
$('#mozg-text').addEventListener('paste', (e) => {
  const images = [...(e.clipboardData?.files || [])].filter(MozgImages.isImage);
  if (!images.length) return;
  if (!e.clipboardData.getData('text/plain')) e.preventDefault();
  addMozgFiles(images);
});
// Przeciąganie plików na cały widok Dyspozytora (przeglądarka i CC Panel.app - tam handler Tauri jest wyłączony, docs/DESKTOP.md).
// Licznik enter/leave zamiast relatedTarget: WebKit (Safari, WKWebView) daje w dragleave relatedTarget = null.
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let mozgDragDepth = 0;
function mozgDropState(on) {
  if (!on) mozgDragDepth = 0;
  $('#v-mozg').classList.toggle('drop', on);
  $('#mozg-drop').hidden = !on;
  if (on) {
    const locked = mozgPendingByThread.has(mozgActive), left = MozgImages.MAX_FILES - (mozgFilesByThread.get(mozgActive) || []).length;
    $('#mozg-drop-hint').textContent = locked ? 'najpierw ponów poprzednią wiadomość'
      : left > 0 ? `dołączę do wiadomości · JPEG, PNG, WebP, HEIC · jeszcze ${MozgImages.imagesLabel(left)}`
        : `limit ${MozgImages.MAX_FILES} obrazów w wiadomości już wykorzystany`;
  }
}
$('#v-mozg').addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (mozgDragDepth++ === 0) mozgDropState(true);
});
$('#v-mozg').addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  if ($('#mozg-drop').hidden) { mozgDragDepth = Math.max(mozgDragDepth, 1); mozgDropState(true); } // wejście bez dragenter (np. po przełączeniu widoku)
});
$('#v-mozg').addEventListener('dragleave', (e) => {
  if (!isFileDrag(e) || $('#mozg-drop').hidden) return;
  if (--mozgDragDepth <= 0) mozgDropState(false);
});
$('#v-mozg').addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); mozgDropState(false);
  if (e.dataTransfer.files?.length) addMozgFiles([...e.dataTransfer.files]);
});
// Plik upuszczony poza Dyspozytorem (lista sesji, terminal) nie może otworzyć się zamiast panelu.
document.addEventListener('dragover', (e) => { if (isFileDrag(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
document.addEventListener('drop', (e) => { if (isFileDrag(e) && !e.defaultPrevented) e.preventDefault(); });
window.addEventListener('dragend', () => mozgDropState(false));
window.addEventListener('blur', () => { if (!$('#mozg-drop').hidden) mozgDropState(false); });

// ---------- routing ----------
// Ekran startowy = Dyspozytor (pusty hash, '#/', '#/mozg' i nieznane trasy -> ostatnia zakładka czatu).
// Lista sesji: '#/sesje', terminal: '#/s/<tmux>' i '#/h/<maszyna>/<panel>', kalendarz: '#/kalendarz', CHAT: '#/chat'.
// '#/limit' (push prognozy limitu): Dyspozytor w ostatniej zakładce z rozwiniętym panelem limitu.
const SESSIONS_HASH = '#/sesje';
const CHAT_HASH = '#/chat';
const isMozgHash = (hash) => /^#\/mozg(\/|$)/.test(hash || '');
// Każdy wpis historii dostaje numer w history.state; navHashes[n] = trasa wpisu n (w obrębie załadowanej strony).
// Dzięki temu "wstecz" w aplikacji cofa historię tylko wtedy, gdy poprzedni wpis to faktycznie ekran docelowy.
let navIdx = 0;
const navHashes = [];
function trackNav() {
  let idx = history.state?.ccpIdx;
  if (typeof idx !== 'number') {
    idx = navHashes.length ? navIdx + 1 : navIdx;
    history.replaceState({ ...(history.state || {}), ccpIdx: idx }, '', location.href);
    navHashes.length = idx; // nowy wpis ucina historię "do przodu"
  }
  navIdx = idx; navHashes[idx] = location.hash;
}
// podmiana trasy w bieżącym wpisie historii (replaceState nie wysyła hashchange, więc route() ręcznie)
function replaceHash(hash) { history.replaceState(history.state, '', hash); route(); }
function goBack(fallback, isTarget) {
  const prev = navIdx > 0 ? navHashes[navIdx - 1] : undefined;
  if (prev !== undefined && isTarget(prev)) history.back();
  else location.hash = fallback;
}
function route() {
  clearTimeout(mozgTimer);
  const hash = location.hash;
  const wantLimit = hash === '#/limit';
  const known = hash === SESSIONS_HASH || hash === CHAT_HASH || hash === '#/kalendarz' || /^#\/[sh]\/./.test(hash);
  let threadId = MozgTabs.routeThread(hash, mozgStorage.get('ccp-mozg-last') || 'general');
  if (threadId === null && !known) threadId = mozgStorage.get('ccp-mozg-last') || 'general';
  // start ('', '#/'), '#/mozg' i nieznane trasy: podmiana adresu na zakładkę, bez dodatkowego wpisu w historii
  if (threadId !== null && (hash === '#/mozg' || !isMozgHash(hash))) history.replaceState(history.state, '', mozgHash(threadId));
  trackNav();
  if (threadId !== null) {
    saveMozgDraft(); mozgActive = threadId;
    mozgStorage.set('ccp-mozg-last', threadId);
    restoreMozgDraft(); $('#mozg-thread').replaceChildren(); delete $('#mozg-thread').dataset.key;
    closeTerm(); clearTimeout(listTimer); showView('mozg'); refreshMozg(); refreshSummary(true);
    if (wantLimit) toggleUsagePop($('#mozg-usage'), true);
    return;
  }
  saveMozgDraft(); ++mozgRefreshSeq;
  if (location.hash === '#/kalendarz') { closeTerm(); clearTimeout(listTimer); setCalOrigin(); showView('cal'); Kalendarz.open(); return; }
  Kalendarz.close();
  if (location.hash === CHAT_HASH) { closeTerm(); clearTimeout(listTimer); showView('chat'); return; }
  const m = location.hash.match(/^#\/s\/(.+)$/);
  const h = location.hash.match(/^#\/h\/(?:([^/]+)\/)?([^/]+)$/);
  if (m) openTerm(decodeURIComponent(m[1]));
  else if (h) openTerm(`h:${h[1] ? decodeURIComponent(h[1]) : localHost}/${decodeURIComponent(h[2])}`);
  else { closeTerm(); showView('list'); loadSessions(); }
}
window.addEventListener('hashchange', route);
Kalendarz.bind();

// ---------- logowanie ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { token: $('#login-token').value.trim() } });
    route();
  } catch (err) { $('#login-err').textContent = err.message; }
});

// ---------- lista sesji ----------
let listTimer = null;
let recent = [], recentAt = 0;
let herdrOn = false, herdrItems = [], herdrMachines = [], localHost = 'coding', workerWorkspace = '';
const herdrHash = (machine, pane) => `#/h/${encodeURIComponent(machine)}/${encodeURIComponent(pane)}`;
const ago = (t) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return `${Math.floor(s)} s temu`;
  if (s < 3600) return `${Math.floor(s / 60)} min temu`;
  if (s < 86400) return `${Math.floor(s / 3600)} h temu`;
  return `${Math.floor(s / 86400)} d temu`;
};
// czas ostatniej aktywności na karcie, krótko jak w aplikacji Claude: teraz / 3 min / 2 h / 4 d
const agoShort = (t) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return 'teraz';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
};
const shortPath = (p) => p.replace(/^\/(home|Users)\/[^/]+\/Projekty\//, '').replace(/^\/(home|Users)\/[^/]+/, '~');

// Mózg (w UI: Dyspozytor) to ekran startowy; na liście sesji przycisk powrotu w nagłówku pokazuje jego stan.
let mozgDotAt = 0, mozgState = null;
async function refreshMozgDot() {
  if (Date.now() - mozgDotAt < 10000) return;
  mozgDotAt = Date.now();
  mozgState = await api('/api/mozg/status').catch(() => ({ online: false }));
  const s = mozgState, b = $('#btn-dysp');
  b.classList.toggle('busy', !!s.online && !!s.busy);
  b.classList.toggle('attn', !!s.decisions);
  b.classList.toggle('offline', !s.online);
  NavKeys.setTitle(b, !s.online ? 'Dyspozytor offline' : [s.busy ? 'Dyspozytor pracuje' : 'Dyspozytor gotowy',
    s.decisions ? plural(s.decisions, 'decyzja', 'decyzje', 'decyzji') + ' do podjęcia' : ''].filter(Boolean).join(' · '));
}
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
// Przycisk SESJE w nagłówku Dyspozytora: liczba sesji agentów i ile czeka na Ciebie (jak dzwonek, bez decyzji Dyspozytora).
let summaryAt = 0;
async function refreshSummary(force) {
  if (!force && Date.now() - summaryAt < 10000) return;
  summaryAt = Date.now();
  let s;
  try { s = await api('/api/summary'); } catch { return; }
  $('#sessions-count').textContent = String(s.sessions);
  $('#sessions-attn').hidden = !s.attention;
  $('#sessions-attn').textContent = s.attention > 99 ? '99+' : String(s.attention);
  $('#btn-sessions').classList.toggle('attn', !!s.attention);
  NavKeys.setTitle($('#btn-sessions'), [plural(s.sessions, 'sesja', 'sesje', 'sesji'), s.working ? `${s.working} pracuje` : '',
    s.attention ? `${s.attention} czeka na Ciebie` : ''].filter(Boolean).join(' · '));
  loadNotifs(); // licznik dzwonka także w nagłówku Dyspozytora
  refreshUsage();
}
// Limit planu: okna 5h i 7d z /api/usage (próbki mozgd), reset, wiek danych i prognoza; sekcja codex z rolloutów Codexa.
let usageAt = 0;
const hhmm = (t) => {
  const d = new Date(t * 1000), now = new Date();
  const time = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString('pl-PL', { weekday: 'short' })} ${time}`;
};
const span = (sec) => {
  const m = Math.max(0, Math.round(sec / 60)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d} d ${h % 24} h` : h ? `${h} h ${m % 60} min` : `${m} min`;
};
function usageRow(w) {
  const row = el('div', 'usage-row');
  const bar = el('div', 'usage-bar'), fill = el('i');
  bar.append(fill);
  const meta = el('div', 'usage-meta');
  let pct = '–';
  if (w.state === 'ok') {
    pct = `${Math.round(w.pct)}%`;
    fill.style.width = `${Math.min(100, w.pct)}%`;
    row.classList.add(w.level);
    const fc = w.forecast || {}, rate = fc.ratePerHour ? ` (${String(fc.ratePerHour).replace('.', ',')} pp/h)` : '';
    const f = fc.state === 'limit' ? el('span', 'usage-fc limit', `⚠ limit ~${hhmm(fc.at)} przy obecnym tempie${rate}`)
      : el('span', 'usage-fc', fc.state === 'safe' ? (fc.ratePerHour ? `starczy do resetu${rate}` : 'bez wzrostu')
        : fc.state === 'off' ? 'bez prognozy' : 'za mało danych do prognozy');
    meta.append(`reset ${hhmm(w.resetsAt)} (za ${span(w.resetIn)}) · `, f, w.seriesReset ? ' · po resecie limitu' : '');
  } else if (w.state === 'expired') {
    pct = '0%';
    meta.textContent = `okno zresetowane o ${hhmm(w.resetsAt)}, czekam na nowe próbki`;
  } else meta.textContent = w.key === '5h' ? 'brak próbek, okno nieaktywne' : 'brak próbek';
  if (w.stale) row.classList.add('stale');
  row.append(el('span', 'usage-key', w.key), bar, el('span', 'usage-pct', pct), meta);
  return row;
}
// Treść rozwijanego panelu pod mini-wskaźnikiem (Dyspozytor i lista sesji) - ten sam widok.
// Z próbkami Codexa (u.codex) dwie sekcje: Claude i Codex (ostatni znany stan, wiek, plan).
function fillUsage(box, u) {
  box.replaceChildren();
  const codex = u?.codex?.windows?.length ? u.codex : null;
  if (codex) box.append(el('div', 'usage-head', 'C · Claude'));
  if (!u || u.error || !u.windows?.length) box.append(el('div', 'usage-meta', `Limit planu: ${u?.error || 'brak danych'}`));
  else {
    box.append(...u.windows.map(usageRow));
    const last = Math.max(0, ...u.windows.map((w) => w.sampleAt || 0));
    if (last) {
      const stale = u.windows.some((w) => w.stale);
      box.append(el('div', 'usage-age' + (stale ? ' stale' : ''), `ostatnia próbka ${ago(last)}${stale ? ' - dane mogą być nieaktualne' : ''}`));
    }
  }
  if (!codex) return;
  box.append(el('div', 'usage-head codex', `X · Codex${codex.planType ? ` (${codex.planType})` : ''}`), ...codex.windows.map(usageRow));
  if (codex.reached) box.append(el('div', 'usage-age stale', `limit osiągnięty: ${codex.reached}`));
  box.append(el('div', 'usage-age' + (codex.stale ? ' stale' : ''),
    `ostatnia próbka ${UsageMini.agePl(codex.age)} (${hhmm(codex.sampleAt)})${codex.stale ? ' - Codex od tej pory nie pracował, to ostatni znany stan' : ''}`));
}
// Mini-wskaźnik "5h 22% / 7d 72%!" z paskami: w nagłówku Dyspozytora (obok 🔗) i listy sesji (05.10 zastąpił duży kafelek).
// Tap rozwija szczegóły (fillUsage) pod nagłówkiem tego widoku; dane z jednego refreshUsage, bez osobnego pollingu.
const USAGE_MINIS = [['#mozg-usage', '#mozg-usage-pop'], ['#list-usage', '#list-usage-pop']];
let usageLast = null;
function renderUsageMini(u) {
  const m = UsageMini.miniUsage(u, hhmm), c = m.codex;
  const mini = (x) => {
    const row = el('span', 'um' + (x.level ? ' ' + x.level : '') + (x.dim ? ' dim' : ''));
    const bar = el('i', 'um-bar');
    bar.style.setProperty('--p', `${x.pct}%`);
    row.append(el('b', 'um-key', x.key), el('span', 'um-pct', x.text), bar);
    return row;
  };
  for (const [btn, pop] of USAGE_MINIS) {
    const b = $(btn);
    // z Codexem: plakietki C / X przed parami 5h/7d, między nimi pionowa kreska (06.10);
    // wiek danych Codexa tylko w title/aria-label (m.label), bez widocznego dopisku (06.10)
    if (c) b.replaceChildren(el('b', 'um-prov', 'C'), ...m.items.map(mini), el('i', 'um-sep'), el('b', 'um-prov codex', 'X'), ...c.items.map(mini));
    else b.replaceChildren(...m.items.map(mini));
    // telefon w Dyspozytorze: pierścień 5h (zewn.) / 7d (wewn.); z Codexem drugi pierścień z plakietką X (kreska między nimi przez CSS order)
    b.insertAdjacentHTML('beforeend', c ? HdrIcons.ringSvg(m.items, 'C') + HdrIcons.ringSvg(c.items, 'X', 'ur-codex') : HdrIcons.ringSvg(m.items));
    b.classList.toggle('has-codex', !!c);
    b.classList.toggle('off', m.off);
    b.title = m.label + ' (kliknij: szczegóły)';
    b.setAttribute('aria-label', m.label);
    b.hidden = false;
    if (!$(pop).hidden) fillUsage($(pop), u);
  }
}
function toggleUsagePop(btn, open) {
  const pop = document.getElementById(btn.getAttribute('aria-controls'));
  if (open === undefined) open = pop.hidden;
  if (open) { fillUsage(pop, usageLast); refreshUsage(); }
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}
const closeUsagePops = (except) => {
  for (const [btn, pop] of USAGE_MINIS) if (!$(pop).hidden && pop !== except) toggleUsagePop($(btn), false);
};
for (const [btn] of USAGE_MINIS) $(btn).addEventListener('click', (e) => { e.stopPropagation(); toggleUsagePop(e.currentTarget); });
document.addEventListener('click', (e) => { const inPop = e.target.closest('.usage-pop'); closeUsagePops(inPop && '#' + inPop.id); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUsagePops(); });
async function refreshUsage(force) {
  if (!force && Date.now() - usageAt < 10000) return;
  usageAt = Date.now();
  let u;
  try { u = await api('/api/usage'); } catch (e) { if (e.message !== 'unauthorized') renderUsageMini(usageLast = null); return; }
  usageLast = u;
  renderUsageMini(u);
}
const backLink = (sel, fallback, isTarget) => $(sel).addEventListener('click', (e) => { e.preventDefault(); goBack(fallback, isTarget); });
backLink('#btn-dysp', '#/mozg', isMozgHash);
backLink('#btn-sessions', SESSIONS_HASH, (h) => h === SESSIONS_HASH);
backLink('#chat-dysp', '#/mozg', isMozgHash);
backLink('#chat-sessions', SESSIONS_HASH, (h) => h === SESSIONS_HASH);
// CHAT: zwykłe linki w nowym oknie (bez iframe). Na Macu CC Panel.app sam przechwytuje claude.ai / chatgpt.com.
// Znaki marek jako statyczny SVG (stałe w kodzie, bez danych z zewnątrz), litera t.mark zostaje dla czytnika.
const CHAT_LOGOS = {
  claude: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor">' +
    Array.from({ length: 12 }, (_, i) => `<path transform="rotate(${i * 30} 12 12)" d="M11.1 2.2h1.8l-.3 7.6h-1.2z"/>`).join('') +
    '<circle cx="12" cy="12" r="2.1"/></g></svg>',
  chatgpt: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7">' +
    [0, 60, 120].map((a) => `<rect transform="rotate(${a} 12 12)" x="8.6" y="3.2" width="6.8" height="17.6" rx="3.4"/>`).join('') +
    '</g></svg>',
};
const CHAT_GO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M9.5 8H16v6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
(function renderChatTiles() {
  const box = $('#chat-tiles');
  for (const t of ChatLinks.tiles(ChatLinks.isIOS(navigator), !!window.CCPDesktop)) {
    const tile = el('div', 'chat-tile chat-' + t.id);
    const open = el('a', 'chat-open');
    Object.assign(open, { href: t.href, target: '_blank', rel: 'noopener noreferrer' });
    const txt = el('span', 'chat-txt');
    txt.append(el('b', 'chat-name', t.name), el('span', 'chat-hint', t.hint));
    const mark = el('span', 'chat-mark');
    mark.innerHTML = CHAT_LOGOS[t.id] || '';
    if (!mark.firstChild) mark.textContent = t.mark;
    const go = el('span', 'chat-go');
    go.innerHTML = CHAT_GO;
    open.append(mark, txt, go);
    tile.append(open);
    if (t.web) {
      const web = el('a', 'chat-web', t.host + ' w przeglądarce');
      Object.assign(web, { href: t.web, target: '_blank', rel: 'noopener noreferrer' });
      tile.append(web);
    }
    box.append(tile);
  }
})();
// ‹ z kalendarza wraca do widoku, z którego przyszedł (Dyspozytor albo Sesje); wejście z linku = ekran startowy
let calOrigin = '#/mozg';
function setCalOrigin() {
  const prev = navIdx > 0 ? navHashes[navIdx - 1] : undefined;
  if (prev && prev !== '#/kalendarz') calOrigin = prev;
  $('#cal-back-label').textContent = isMozgHash(calOrigin) ? 'Dyspozytor' : calOrigin === SESSIONS_HASH ? 'Sesje' : 'Wróć';
}
$('#cal-back').addEventListener('click', (e) => { e.preventDefault(); goBack(calOrigin, (h) => h === calOrigin); });
async function loadSessions() {
  clearTimeout(listTimer);
  if ($('#v-list').hidden) return;
  try {
    const [list, claude, hd] = await Promise.all([
      api('/api/sessions'), api('/api/claude').catch(() => []), api('/api/herdr').catch(() => ({ available: false, items: [] })),
    ]);
    herdrOn = hd.available;
    herdrItems = hd.items;
    herdrMachines = hd.machines || [];
    workerWorkspace = hd.workerWorkspace || '';
    localHost = claude.find((x) => x.local)?.host || localHost;
    if (Date.now() - recentAt > 30000) {
      recentAt = Date.now();
      recent = await api('/api/recent').catch(() => recent);
    }
    renderSessions(list, claude);
    loadNotifs();
    refreshMozgDot();
    refreshUsage();
    $('#list-meta').textContent = new Date().toLocaleTimeString('pl-PL');
  } catch (e) {
    if (e.message === 'unauthorized') return;
    $('#list-meta').textContent = 'błąd: ' + e.message;
  }
  listTimer = setTimeout(loadSessions, 3000);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Codex: iPhone nie obsługuje codex://, ale aplikacja ChatGPT przejmuje chatgpt.com/codex/tasks/*
// (apple-app-site-association) i otwiera tam wątek zdalnego sterowania po jego identyfikatorze
function codexLinks(threadId) {
  const a = el('a', 'rc-link codex-link', 'Otwórz w Codex ↗');
  a.href = 'https://chatgpt.com/codex/tasks/' + encodeURIComponent(threadId);
  a.target = '_blank';
  a.rel = 'noopener';
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function rcLink(url) {
  const a = el('a', 'rc-link', 'Otwórz w Claude ↗');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function actionBtn(label, cls, onClick) {
  const b = el('button', 'act-btn ' + cls, label);
  b.type = 'button';
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try { await onClick(); } catch (err) { alert(err.message); } finally { b.disabled = false; }
  });
  return b;
}

// ---------- szukanie sesji ----------
// Fraza żyje w sessionStorage: przetrwa polling, terminal i przeładowanie, ale nie zamknięcie aplikacji.
const sessStore = {
  get() { try { return sessionStorage.getItem('ccp-sess-q') || ''; } catch { return ''; } },
  set(v) { try { if (v) sessionStorage.setItem('ccp-sess-q', v); else sessionStorage.removeItem('ccp-sess-q'); } catch {} },
};
const sessQ = $('#sess-q');
sessQ.value = sessStore.get();
let sessTokens = SessionSearch.parse(sessQ.value), sessTimer = null, lastSessions = null;
$('#sess-q-clear').hidden = !sessQ.value;
// tekst z pogrubionymi trafieniami bieżącej frazy
function hl(text) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [a, b] of SessionSearch.ranges(text, sessTokens)) {
    if (a > at) frag.append(text.slice(at, a));
    frag.append(el('b', 'hit', text.slice(a, b)));
    at = b;
  }
  if (at < text.length) frag.append(text.slice(at));
  return frag;
}
function hlEl(tag, cls, text) { const e = el(tag, cls); e.append(hl(text || '')); return e; }
function applySessSearch() {
  clearTimeout(sessTimer);
  sessTokens = SessionSearch.parse(sessQ.value);
  sessStore.set(sessQ.value);
  $('#sess-q-clear').hidden = !sessQ.value;
  if (lastSessions) renderSessions(...lastSessions);
}
function clearSessSearch() { sessQ.value = ''; applySessSearch(); }
sessQ.addEventListener('input', () => { $('#sess-q-clear').hidden = !sessQ.value; clearTimeout(sessTimer); sessTimer = setTimeout(applySessSearch, 150); });
sessQ.addEventListener('search', applySessSearch); // Enter / systemowe czyszczenie pola type=search
sessQ.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (sessQ.value) clearSessSearch(); else sessQ.blur();
});
$('#sess-q-clear').addEventListener('click', () => { clearSessSearch(); sessQ.focus(); });
// Mac: "/" albo Cmd+K (Ctrl+K) ustawia fokus w polu, gdy widać listę sesji
document.addEventListener('keydown', (e) => {
  if ($('#v-list').hidden || document.querySelector('dialog[open]')) return;
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
  const cmdK = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
  if (!cmdK && !(e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey)) return;
  e.preventDefault();
  sessQ.focus();
  sessQ.select();
});

// ---------- tryb porządkowania listy ----------
// Wybór trybu (chip ↕ obok szukania) i stan zwinięcia sekcji: localStorage tego urządzenia.
// „Obejrzane” per sesja: moment otwarcia/zamknięcia terminala, kliknięcia karty albo „✓ obejrzane”;
// agent, który skończył po tym momencie, trafia w trybie Uwaga do „Do Ciebie”.
const SORT_KEY = 'ccp-sort', FOLD_KEY = 'ccp-sort-fold', SEEN_SESS_KEY = 'ccp-sess-seen', SEEN_BASE_KEY = 'ccp-sess-seen-base';
let sortMode = SessionSort.parseMode(mozgStorage.get(SORT_KEY));
const readJson = (key) => { try { return JSON.parse(mozgStorage.get(key) || '{}') || {}; } catch { return {}; } };
function seenBase() {
  let b = Number(mozgStorage.get(SEEN_BASE_KEY));
  if (!b) { b = Date.now() / 1000; mozgStorage.set(SEEN_BASE_KEY, b); }
  return b;
}
function markSeen(...keys) {
  const now = Date.now() / 1000, seen = SessionSort.pruneSeen(readJson(SEEN_SESS_KEY), now);
  for (const k of keys) if (k) seen[k] = now;
  mozgStorage.set(SEEN_SESS_KEY, JSON.stringify(seen));
}
// klucz „obejrzane” z nazwy terminala: herdr 'h:<maszyna>/<panel>' jak na liście, tmux z prefiksem
const tmuxSeenKey = (name) => 's:' + name;
const termSeenKey = (name) => (name.startsWith('h:') ? name : tmuxSeenKey(name));
const sortChip = $('#sess-sort');
function showSortMode() {
  sortChip.textContent = '↕ ' + SessionSort.LABELS[sortMode];
  sortChip.title = `Kolejność: ${SessionSort.LABELS[sortMode]} (dotknij: ${SessionSort.LABELS[SessionSort.nextMode(sortMode)]})`;
}
showSortMode();
sortChip.addEventListener('click', () => {
  sortMode = SessionSort.nextMode(sortMode);
  mozgStorage.set(SORT_KEY, sortMode);
  showSortMode();
  if (lastSessions) renderSessions(...lastSessions);
  $('#sessions').scrollTop = 0;
});

// find: dodatkowe pola przeszukiwane, niewidoczne na karcie ([etykieta, tekst]); trafione pokazuje linia "card-hits"
// „o co prosi” sesja czekająca na zgodę (z transkryptu, serwer maskuje sekrety); bez potwierdzonej zgody nic
function askLine(status, ask) {
  if (status !== 'approval' || !ask?.text) return null;
  const line = el('div', 'card-ask');
  line.append(el('span', 'card-ask-label', 'prosi o: '), el('span', 'card-ask-text', ask.text));
  if (ask.count > 1) line.append(el('span', 'muted', ` (+${ask.count - 1})`));
  return line;
}
// ikona statusu: kształt (status-icons.js) + kolor z tokenów --st-*; klasa 'dot' zostaje dla starszych selektorów
function statusDot(status, node = el('span')) {
  node.className = `dot si si-${StatusIcons.shapeOf(status)}`;
  node.innerHTML = StatusIcons.statusSvg(status);
  return node;
}
// attn: karta w sekcji „Do Ciebie” (pasek z lewej); prośba o zgodę dostaje dodatkowo bursztynowe podświetlenie
function card({ name, status, statusText, badge, badgeCls, cwd, time, preview, href, rcUrl, note, extra, find, ask, where, seenKey, attn }) {
  const c = el('div', 'card' + (status === 'approval' ? ' ask' : attn ? ' you' : ''));
  // capture: link RC i przyciski zatrzymują propagację, a też liczą się jako obejrzenie
  if (seenKey) c.addEventListener('click', () => markSeen(seenKey), true);
  if (href) { c.classList.add('clickable'); c.addEventListener('click', () => { location.hash = href; }); }
  const top = el('div', 'card-top');
  top.append(statusDot(status), hlEl('span', 'card-name', name), el('span', 'badge ' + badgeCls, badge));
  const sub = el('div', 'card-sub');
  sub.append(el('span', 'status st-' + status, statusText), hlEl('span', '', shortPath(cwd || '')));
  if (where) sub.append(el('span', 'card-where', where));
  if (time) sub.append(el('span', 'card-time', agoShort(time)));
  c.append(top, sub);
  const askEl = askLine(status, ask);
  if (askEl) c.append(askEl);
  const shown = SessionSearch.normalize([name, shortPath(cwd || ''), preview].join('\n'));
  const hits = sessTokens.length ? (find || []).filter(([label, t]) => label && t && SessionSearch.ranges(t, sessTokens).length
    && !shown.includes(SessionSearch.normalize(t))) : [];
  if (hits.length) {
    const line = el('div', 'card-hits');
    hits.forEach(([label, t], i) => line.append(i ? ' · ' : '', el('span', 'hit-label', label + ': '), hl(t)));
    c.append(line);
  }
  if (preview) c.append(hlEl('pre', '', preview));
  if (rcUrl || note || extra) {
    const actions = el('div', 'card-actions');
    if (extra) actions.append(extra);
    if (rcUrl) actions.append(rcLink(rcUrl));
    if (note) actions.append(el('span', 'muted small', note));
    c.append(actions);
  }
  return c;
}
// pola, po których szukamy karty: to, co widać, + find (+ rodzaj agenta i maszyna bez wyświetlania)
const cardFields = (o, ...more) => [o.name, shortPath(o.cwd || ''), o.badge, ...(o.find || []).map((f) => f[1]), ...more];

// Worker orkiestratora po pracy: nic nie czeka na użytkownika, panel zamknie rotator (sweep, 03.10).
const workerDone = (it) => !!workerWorkspace && it.workspace === workerWorkspace && ['idle', 'done'].includes(it.status);
function renderSessions(list, hosts) {
  lastSessions = [list, hosts];
  // .sess-main = sekcje i karty, .sess-side = „Ostatnie rozmowy”; na telefonie oba display: contents (jedna kolumna),
  // na desktopie karty w siatce, a rozmowy w bocznej kolumnie (style.css, „wygląd etap 2”)
  const box = el('div', 'sess-main'), side = el('aside', 'sess-side');
  side.setAttribute('aria-label', 'Ostatnie rozmowy');
  $('#sessions').replaceChildren(box, side);
  const searching = sessTokens.length > 0;
  const items = [];
  // where: maszyna i źródło jako etykieta na karcie (w trybie Uwaga sekcje nie mówią już, skąd sesja jest)
  const add = (it, o, ...more) => items.push({ ...it, project: shortPath(o.cwd || ''), fields: cardFields(o, ...more), make: (sec) => card({ ...o, seenKey: it.key, attn: sec === 'you' }) });
  const local = hosts.find((h) => h.local)?.sessions || [];
  const byTmux = new Map(local.filter((c) => c.tmux).map((c) => [c.tmux, c]));
  const byHerdr = new Map(hosts.flatMap((h) => h.sessions.filter((c) => c.herdr).map((c) => [`${h.host}/${c.herdr}`, c])));

  for (const hm of herdrMachines) for (const it of hm.items) {
    const c = byHerdr.get(`${it.machine}/${it.pane}`);
    const ended = !it.agent;
    const kind = it.kind || (ended ? 'shell' : it.agent);
    const display = it.display || it.name;
    const worker = !!workerWorkspace && it.workspace === workerWorkspace;
    add({ key: `h:${it.machine}/${it.pane}`, name: display, status: it.status, time: it.activity, machine: it.machine, agent: !ended,
      background: isBrainPane(it) || worker }, {
      name: display, status: it.status, ask: it.ask, statusText: ended ? 'bez agenta' : workerDone(it) ? 'worker · zakończył (rotator sprzątnie ≤2 h)' : STATUS[it.status],
      badge: kind, badgeCls: it.kind, cwd: it.cwd, time: it.activity, preview: display !== it.name ? `herdr: ${it.name}` : '',
      where: `herdr · ${it.machine}`, href: herdrHash(it.machine, it.pane), rcUrl: isBrainPane(it) ? null : c?.rcUrl,
      find: [['RC', c?.name], ['herdr', it.name], ['worker', it.label], ['workspace', it.workspace], ['agent', it.agentName]],
      extra: ended && !isBrainPane(it) ? actionBtn('↻ Kontynuuj Claude', 'primary', async () => {
        await api(`/api/herdr/${encodeURIComponent(it.machine)}/${encodeURIComponent(it.pane)}/continue`, { method: 'POST', body: { kind: 'claude' } });
        location.hash = herdrHash(it.machine, it.pane);
      }) : null,
    }, it.machine);
  }

  for (const h of hosts) {
    const report = h.local ? '' : ` · raport ${agoShort(h.at)}`;
    for (const c of h.sessions.filter((x) => !x.tmux && !x.herdr)) add(
      { key: `rc:${h.host}/${c.id || c.pid}`, name: c.name, status: c.status, time: c.updated, machine: h.host }, {
        name: c.name, status: c.status, ask: c.ask, statusText: STATUS[c.status] || c.rawStatus,
        badge: 'claude', badgeCls: 'claude', cwd: c.cwd, time: c.updated, rcUrl: c.rcUrl, where: `${c.rcUrl ? 'RC' : 'proces'} · ${h.host}${report}`,
        note: c.rcUrl ? `pid ${c.pid}` : 'RC wyłączone: wpisz /remote-control w sesji',
      }, h.host);
    for (const c of (h.codex || []).filter((x) => !x.tmux && !x.herdr)) add(
      { key: `cx:${h.host}/${c.id || c.pid}`, name: c.name, status: c.status, time: c.updated, machine: h.host, background: !!c.subagent }, {
        name: c.name, status: c.status, statusText: c.subagent && c.status === 'idle' ? 'podagent · zakończył pracę' : STATUS[c.status], badge: 'codex', badgeCls: 'codex',
        cwd: c.cwd, time: c.updated, where: `${c.appServer ? 'RC' : 'proces'} · ${h.host}${report}`, extra: c.appServer && c.id ? codexLinks(c.id) : null,
        note: c.appServer ? 'sterowany z aplikacji Codex (Remote Control)' : `pid ${c.pid} · tylko podgląd (poza panelem)`,
      }, h.host);
  }

  for (const s of list) {
    const c = byTmux.get(s.name);
    const ended = s.status === 'shell' && (s.kind === 'claude' || s.kind === 'codex');
    add({ key: tmuxSeenKey(s.name), name: s.name, status: s.status, time: s.activity, machine: localHost, agent: s.status !== 'shell' && s.cmd !== 'herdr' }, {
      name: s.name, status: s.status, ask: s.ask, statusText: ended ? 'agent zakończony' : s.cmd === 'herdr' ? 'klient herdr' : STATUS[s.status],
      badge: s.kind || s.cmd, badgeCls: s.kind, cwd: s.cwd, time: s.activity, preview: s.preview, where: `tmux · ${localHost}`,
      href: '#/s/' + encodeURIComponent(s.name), rcUrl: c?.rcUrl, find: [['RC', c?.name]],
      extra: ended ? actionBtn('↻ Kontynuuj', 'primary', async () => {
        await api(`/api/sessions/${encodeURIComponent(s.name)}/continue`, { method: 'POST' });
        location.hash = '#/s/' + encodeURIComponent(s.name);
      }) : null,
    });
  }

  // sekcje wg trybu; podczas szukania sekcje bez trafień znikają, a zwinięte się rozwijają (trafienie musi być widać)
  const fold = readJson(FOLD_KEY);
  let total = 0, kept = 0;
  for (const sec of SessionSort.sections(sortMode, items, { seen: readJson(SEEN_SESS_KEY), base: seenBase() })) {
    total += sec.items.length;
    const keep = sec.items.filter((e) => SessionSearch.matches(e.fields, sessTokens));
    kept += keep.length;
    if (searching && !keep.length) continue;
    const closed = !searching && (fold[sec.key] ?? !!sec.collapsed);
    const head = el('h2', 'section section-toggle' + (sec.key === 'you' && sortMode === 'attention' ? ' sec-you' : ''));
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(!closed));
    head.append(el('span', 'fold', closed ? '▸' : '▾'), `${sec.title} (${searching ? `${keep.length} z ${sec.items.length}` : sec.items.length})`);
    const toggle = () => { const f = readJson(FOLD_KEY); f[sec.key] = !closed; mozgStorage.set(FOLD_KEY, JSON.stringify(f)); renderSessions(...lastSessions); };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    const unseen = sec.key === 'you' ? sec.items.filter((x) => x.status !== 'approval') : [];
    if (unseen.length && !closed) head.append(actionBtn('✓ obejrzane', 'ghost seen-all', async () => { markSeen(...unseen.map((x) => x.key)); renderSessions(...lastSessions); }));
    box.append(head);
    if (!closed) for (const e of keep) box.append(e.make(sortMode === 'attention' ? sec.key : ''));
  }
  if (!items.length) box.append(el('p', 'empty', 'Brak działających sesji.'));

  $('#sess-q-count').textContent = searching ? `${kept} z ${total}` : '';
  if (searching && !kept) box.append(el('p', 'empty search-empty', `Brak sesji pasujących do „${sessQ.value.trim()}”.`));

  const recentKeep = recent.filter((r) => SessionSearch.matches([r.title, shortPath(r.cwd), r.kind], sessTokens));
  if (recentKeep.length) {
    side.append(el('h2', 'section', searching ? `Ostatnie rozmowy · coding (${recentKeep.length} z ${recent.length})` : 'Ostatnie rozmowy · coding'));
    const wrap = el('div', 'recent');
    for (const r of recentKeep) {
      const row = el('div', 'recent-row');
      const txt = el('div', 'recent-txt');
      const t = el('div', 'recent-title');
      t.append(el('span', 'badge ' + r.kind, r.kind), hlEl('span', '', r.title));
      const meta = el('div', 'muted small');
      meta.append(hl(shortPath(r.cwd)), ` · ${ago(r.at)}`);
      txt.append(t, meta);
      row.append(txt, actionBtn('↻ Kontynuuj', 'primary', async () => {
        const res = await api('/api/sessions', { method: 'POST', body: {
          kind: r.kind, dir: r.cwd, resume: r.id, rc: r.kind === 'claude', backend: backendPref(),
          name: r.title && r.title !== '(bez tytułu)' ? r.title.slice(0, 40) : `${r.kind}-${r.cwd.split('/').pop()}`,
        } });
        recentAt = 0;
        goToCreated(res);
      }));
      wrap.append(row);
    }
    side.append(wrap);
  }
  $('#sessions').classList.toggle('no-side', !side.childElementCount);
}
$('#btn-refresh').addEventListener('click', loadSessions);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!$('#v-list').hidden) loadSessions();
  if (!$('#v-mozg').hidden) refreshSummary(true);
  if (current && (!ws || ws.readyState > 1)) connect();
});

// ---------- nowa sesja ----------
const dlg = $('#dlg-new');
const dirSearch = $('#dir-search');
let browsePath = '';   // katalog aktualnie otwarty w przeglądarce (względem ~/Projekty)
let dirSeq = 0;

function dirRow(title, sub, onClick, cls = '') {
  const b = el('button', 'dir-item ' + cls);
  b.type = 'button';
  const txt = el('span', 'dir-txt');
  txt.append(el('b', '', title));
  if (sub) txt.append(el('span', 'muted', sub));
  b.append(txt, el('span', 'dir-chev', '›'));
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // nie chowaj klawiatury przy dotyku
  b.addEventListener('click', onClick);
  return b;
}

function renderCrumbs(label) {
  const box = $('#dir-crumbs');
  box.replaceChildren();
  $('#dir-up').disabled = !browsePath && !label;
  if (label) { box.append(el('span', 'crumb-label', label)); return; }
  const parts = browsePath ? browsePath.split('/') : [];
  const go = (p) => () => { dirSearch.value = ''; browse(p); };
  const root = el('button', 'crumb', '~/Projekty');
  root.type = 'button';
  root.addEventListener('click', go(''));
  box.append(root);
  parts.forEach((name, i) => {
    box.append(el('span', 'crumb-sep', '/'));
    const c = el('button', 'crumb' + (i === parts.length - 1 ? ' current' : ''), name);
    c.type = 'button';
    c.addEventListener('click', go(parts.slice(0, i + 1).join('/')));
    box.append(c);
  });
  box.scrollLeft = box.scrollWidth;
}

async function browse(rel) {
  const seq = ++dirSeq;
  let res;
  try { res = await api('/api/dirs?path=' + encodeURIComponent(rel) + machineQ()); } catch (e) { $('#new-err').textContent = e.message; return; }
  if (seq !== dirSeq) return;
  browsePath = res.path;
  renderCrumbs();
  $('#dir-actions').hidden = false;
  $('#dir-choose').textContent = '✓ Wybierz: ' + (browsePath ? browsePath.split('/').pop() : '~/Projekty');
  const box = $('#dir-results');
  box.replaceChildren();
  if (!res.dirs.length) box.append(el('p', 'muted small', 'Brak podkatalogów.'));
  for (const d of res.dirs) {
    const rel = browsePath ? `${browsePath}/${d}` : d;
    box.append(dirRow(d, '', () => browse(rel)));
  }
  box.scrollTop = 0;
}

async function searchDirs() {
  const q = dirSearch.value.trim();
  if (!q) return browse(browsePath);
  const seq = ++dirSeq;
  let res;
  try { res = await api('/api/dirs?q=' + encodeURIComponent(q) + machineQ()); } catch { return; }
  if (seq !== dirSeq) return; // przyszła już nowsza odpowiedź
  renderCrumbs('Wyniki wyszukiwania');
  $('#dir-actions').hidden = true;
  const box = $('#dir-results');
  box.replaceChildren();
  const want = q.replace(/^\/+|\/+$/g, '');
  if (want && !res.dirs.includes(want)) {
    box.append(dirRow('＋ Utwórz katalog', '~/Projekty/' + want, () => createDir(want), 'dir-create'));
  }
  if (!res.dirs.length) box.append(el('p', 'muted small', 'Nic nie znaleziono.'));
  for (const d of res.dirs) {
    const i = d.lastIndexOf('/');
    box.append(dirRow(d.slice(i + 1), i > 0 ? d.slice(0, i) : '', () => { dirSearch.value = ''; dirSearch.blur(); browse(d); }));
  }
  box.scrollTop = 0;
}

function pickDir(d) {
  $('#new-form').dir.value = d;
  $('#dir-picked-path').textContent = d ? '~/Projekty/' + d : '~/Projekty';
  $('#dir-picked').hidden = false;
  $('#dir-browser').hidden = true;
  $('#subdir-row').hidden = true;
  dirSearch.blur();
}
function openBrowser(at) {
  $('#dir-picked').hidden = true;
  $('#dir-browser').hidden = false;
  $('#subdir-row').hidden = true;
  dirSearch.value = '';
  browse(at);
}
$('#dir-picked').addEventListener('click', () => openBrowser($('#new-form').dir.value));
$('#dir-choose').addEventListener('click', () => pickDir(browsePath));
$('#dir-up').addEventListener('click', () => {
  if (dirSearch.value) { dirSearch.value = ''; return browse(browsePath); }
  browse(browsePath.split('/').slice(0, -1).join('/'));
});

async function createDir(rel) {
  $('#new-err').textContent = '';
  try {
    const { dir } = await api('/api/dirs', { method: 'POST', body: { path: rel, machine: currentMachine() } });
    dirSearch.value = '';
    $('#subdir-row').hidden = true;
    await browse(dir); // pokaż nowy katalog; „Wybierz” albo od razu „Uruchom”
  } catch (e) { $('#new-err').textContent = e.message; }
}
$('#dir-new').addEventListener('click', () => {
  $('#subdir-row').hidden = false;
  $('#subdir-name').value = '';
  $('#subdir-name').focus();
});
$('#subdir-create').addEventListener('click', () => {
  const name = $('#subdir-name').value.trim();
  if (!name) return $('#subdir-name').focus();
  createDir(browsePath ? `${browsePath}/${name}` : name);
});
$('#subdir-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#subdir-create').click(); }
});

let dirTimer;
dirSearch.addEventListener('input', () => { clearTimeout(dirTimer); dirTimer = setTimeout(searchDirs, 150); });
dirSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = $('#dir-results .dir-item:not(.dir-create)');
  if (first) first.click();
});

$('#btn-new').addEventListener('click', () => {
  $('#new-err').textContent = '';
  $('#new-form').reset();
  $('#new-form').dispatchEvent(new Event('change')); // pokaż pola agenta po resecie
  $('#new-form').dir.value = '';
  $('#backend-seg').hidden = !herdrOn;
  $('#new-form').backend.value = backendPref();
  dlg.showModal();
  loadMachines();
  openBrowser('');
});
// modele: lista z serwera (Codex z ~/.codex/models_cache.json)
let modelsP = null;
const getModels = () => (modelsP ||= api('/api/models').catch(() => { modelsP = null; return { claude: { models: [], efforts: [] }, codex: { models: [] } }; }));

function fillSelect(sel, items, keep) {
  sel.replaceChildren(new Option('domyślny', ''), ...items.map(([v, t]) => new Option(t, v)));
  sel.value = items.some(([v]) => v === keep) ? keep : '';
}
async function updateModelSelects(changedModel) {
  const kind = $('#new-form').kind.value;
  if (kind === 'shell') return;
  const m = await getModels();
  const ms = $('#new-model'), es = $('#new-effort');
  if (!changedModel) {
    const list = kind === 'claude' ? m.claude.models : m.codex.models;
    fillSelect(ms, list.map((x) => [x.id, x.name]), ms.value);
  }
  let efforts = m.claude.efforts;
  if (kind === 'codex') {
    const cur = m.codex.models.find((x) => x.id === ms.value);
    efforts = cur ? cur.efforts : [...new Set(m.codex.models.flatMap((x) => x.efforts))];
  }
  fillSelect(es, efforts.map((e) => [e, e]), es.value);
}

$('#new-form').addEventListener('change', (e) => {
  const agent = $('#new-form').kind.value !== 'shell';
  for (const el of document.querySelectorAll('.agent-only')) el.hidden = !agent;
  for (const el of document.querySelectorAll('.claude-only')) el.hidden = $('#new-form').kind.value !== 'claude';
  if (e.target?.name === 'machine') { try { localStorage.setItem('ccp-machine', e.target.value); } catch {} applyMachine(); }
  if (e.target?.name === 'kind' || !e.target?.name) updateModelSelects(false);
  else if (e.target.name === 'model') updateModelSelects(true);
});
$('#new-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = e.target;
  const btn = $('#btn-create');
  btn.disabled = true;
  $('#new-err').textContent = '';
  try {
    const backend = f.backend.value;
    try { localStorage.setItem('ccp-backend', backend); } catch {}
    const res = await api('/api/sessions', { method: 'POST', body: {
      kind: f.kind.value, dir: $('#dir-browser').hidden ? f.dir.value : browsePath, name: f.slabel.value.trim(),
      prompt: f.prompt.value.trim(), cont: f.cont.checked, yolo: f.yolo.checked, backend, machine: currentMachine(),
      model: f.model.value, effort: f.effort.value, rc: f.kind.value === 'claude' && f.rc.checked,
    } });
    dlg.close();
    goToCreated(res);
  } catch (err) {
    $('#new-err').textContent = err.message;
  } finally { btn.disabled = false; }
});

let machines = [];
const machinePref = () => { try { return localStorage.getItem('ccp-machine') || ''; } catch { return ''; } };
const currentMachine = () => $('#new-form').machine?.value || localHost;
const machineQ = () => (currentMachine() === localHost ? '' : `&machine=${encodeURIComponent(currentMachine())}`);

async function loadMachines() {
  try { machines = await api('/api/machines'); } catch { machines = [{ name: localHost, local: true, herdr: herdrOn }]; }
  const box = $('#machine-seg');
  box.replaceChildren();
  const pref = machinePref();
  const pick = machines.some((m) => m.name === pref && (m.local || m.herdr)) ? pref : localHost;
  for (const m of machines) {
    const lab = el('label');
    const inp = Object.assign(document.createElement('input'), { type: 'radio', name: 'machine', value: m.name });
    inp.checked = m.name === pick;
    inp.disabled = !m.local && !m.herdr;
    lab.append(inp, el('span', '', m.name + (!m.local && !m.herdr ? ' ✕' : '')));
    box.append(lab);
  }
  box.hidden = machines.length < 2;
  applyMachine();
}
function applyMachine() {
  const local = currentMachine() === localHost;
  $('#backend-seg').hidden = !local || !herdrOn;
  if (!local) $('#new-form').backend.value = 'herdr';
  $('#new-form').dir.value = '';
  if (!$('#dir-browser').hidden) openBrowser('');
}

function backendPref() {
  let b = null;
  try { b = localStorage.getItem('ccp-backend'); } catch {}
  return herdrOn ? (b || 'herdr') : 'tmux';
}
function goToCreated(res) {
  location.hash = res.herdr ? herdrHash(res.machine || localHost, res.herdr) : '#/s/' + encodeURIComponent(res.name);
}

// ---------- terminal ----------
let term, fit, ws, current = null, currentKind = '', statusTimer = null, retry = 0;
let fontSize = Look.get().term; // rozmiar z arkusza Wygląd (look.js, klucz ccp-fs)

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    fontSize,
    fontFamily: 'ui-monospace, Menlo, "DejaVu Sans Mono", "Cascadia Mono", monospace',
    cursorBlink: false,
    scrollback: 1000,
    allowProposedApi: true,
    ...Look.term(), // kolory i minimalny kontrast z tokenów motywu (look.js)
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#xterm'));
  term.attachCustomKeyEventHandler((e) => !NavKeys.isNav(e)); // ⌘D/⌘S/⌘T (nav-keys.js) nie trafiają do sesji
  term.onData((d) => wsSend({ t: 'i', d }));
  term.onResize(({ cols, rows }) => wsSend({ t: 'r', c: cols, r: rows }));
  new ResizeObserver(() => { if (!$('#v-term').hidden) try { fit.fit(); } catch {} }).observe($('#xterm'));
  setupTouchScroll($('#xterm'));
}

// Przewijanie palcem: herdr/tmux trzymają historię po swojej stronie, więc gest zamieniamy
// na zdarzenia kółka myszy (SGR), tak jak robi to kółko na komputerze.
// Płynność (03.10): krok gestu = tyle wysokości linii, ile przewija jedno kliknięcie kółka (wheelLines)
// - treść idzie za palcem 1:1 zamiast uciekać 3x szybciej. Zdarzenia zbierane do jednej wiadomości
// na klatkę (wcześniej każde touchmove = osobny przerys po stronie agenta) i bezwładność po puszczeniu palca.
// Linie na kliknięcie kółka po stronie odbiorcy. Claude na coding: 1 (03.10: CLAUDE_CODE_SCROLL_SPEED=1 i
// wheelScrollAccelerationEnabled=false w ~/.claude/settings.json - krok ~13 px zamiast ~39 px). Reszta: 3 -
// Codex i shell przewija herdr (ui.mouse_scroll_lines=3), Fedora ma Claude z domyślną prędkością.
function wheelLines() {
  const forced = +localStorage.getItem('ccp-wheel-lines');
  if (forced) return forced;
  if (!isHerdr(current)) return 1;                        // tmux na coding
  const { machine, pane } = herdrParts(current);
  if (machine !== localHost) return 3;
  const it = herdrItems.find((x) => x.machine === machine && x.pane === pane);
  return !it || it.agent === 'claude' ? 1 : 3;
}
const MAX_LINES_PER_FRAME = 12;    // więcej na klatkę tylko zapycha agenta - reszta czeka do następnej
function wheel(up, n) {
  const mode = term.modes.mouseTrackingMode;
  if (mode && mode !== 'none') {
    const col = Math.ceil(term.cols / 2), row = Math.ceil(term.rows / 2);
    wsSend({ t: 'i', d: `\x1b[<${up ? 64 : 65};${col};${row}M`.repeat(n) });
  } else {
    term.scrollLines(up ? -n * wheelLines() : n * wheelLines());
  }
}
function setupTouchScroll(elm) {
  let lastY = null, acc = 0, moved = false, pending = 0, raf = 0, glide = 0;
  let samples = []; // [czas, y] z ostatnich ~100 ms - prędkość na końcu gestu
  const cellHeight = () => term?._core?._renderService?.dimensions?.css?.cell?.height || fontSize * 1.2;
  const step = () => Math.max(8, cellHeight() * wheelLines()); // piksele palca na jedno kliknięcie kółka
  const flush = () => {
    raf = 0;
    if (!pending) return;
    const cap = Math.max(1, Math.round(MAX_LINES_PER_FRAME / wheelLines()));
    const n = Math.max(-cap, Math.min(cap, pending));
    pending -= n;
    wheel(n > 0, Math.abs(n));
    if (pending) raf = requestAnimationFrame(flush);
  };
  const push = (px) => {
    acc += px;
    const n = Math.trunc(acc / step());
    if (!n) return;
    acc -= n * step();
    pending += n;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const stopGlide = () => { if (glide) cancelAnimationFrame(glide); glide = 0; };
  elm.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    stopGlide(); pending = 0;              // dotknięcie zatrzymuje rozpęd jak w natywnym przewijaniu
    lastY = e.touches[0].clientY; acc = 0; moved = false;
    samples = [[e.timeStamp, lastY]];
  }, { capture: true, passive: true });
  elm.addEventListener('touchmove', (e) => {
    if (lastY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = y - lastY; lastY = y;
    samples.push([e.timeStamp, y]);
    while (samples.length > 2 && e.timeStamp - samples[0][0] > 100) samples.shift();
    if (!moved && Math.abs(acc + dy) < 8) { acc += dy; return; }
    moved = true;
    e.preventDefault(); e.stopPropagation();
    push(dy);
  }, { capture: true, passive: false });
  elm.addEventListener('touchend', (e) => {
    if (moved) { e.preventDefault(); e.stopPropagation(); } // przesunięcie to nie tapnięcie (nie otwieraj klawiatury)
    lastY = null;
    if (!moved || samples.length < 2) return;
    const [t0, y0] = samples[0], [t1, y1] = samples[samples.length - 1];
    if (e.timeStamp - t1 > 80) return;     // palec stał przed puszczeniem - bez rozpędu
    let v = (y1 - y0) / Math.max(16, t1 - t0) * 16; // px na klatkę (~16 ms)
    if (Math.abs(v) < 4) return;
    v = Math.max(-80, Math.min(80, v));
    const tick = () => {
      v *= 0.94;                             // tarcie: ~1 s do zatrzymania z szybkiego machnięcia
      if (Math.abs(v) < 1.5) { glide = 0; return; }
      push(v);
      glide = requestAnimationFrame(tick);
    };
    glide = requestAnimationFrame(tick);
  }, { capture: true, passive: false });
}

function wsSend(msg) { if (msg.t === 'i' && brainReadOnly) return; if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// current: nazwa sesji tmux albo 'h:<panel herdr>'
const isHerdr = (t) => !!t && t.startsWith('h:');
// 'h:<maszyna>/<panel>'
const herdrParts = (t) => { const i = t.indexOf('/'); return { machine: t.slice(2, i), pane: t.slice(i + 1) }; };
const targetApi = (t) => {
  if (!isHerdr(t)) return `/api/sessions/${encodeURIComponent(t)}`;
  const { machine, pane } = herdrParts(t);
  return `/api/herdr/${encodeURIComponent(machine)}/${encodeURIComponent(pane)}`;
};
async function targetInfo(t) {
  if (isHerdr(t)) {
    const { machine, pane } = herdrParts(t);
    const hd = await api('/api/herdr');
    const it = hd.items.find((x) => x.machine === machine && x.pane === pane);
    return it && { readOnly: isBrainPane(it), name: `${it.display || it.name} · ${it.machine}`, kind: it.kind, status: it.agent ? it.status : 'shell', label: it.agent ? STATUS[it.status] : 'bez agenta' };
  }
  const s = (await api('/api/sessions')).find((x) => x.name === t);
  return s && { name: s.name, kind: s.kind || s.cmd, status: s.status, label: STATUS[s.status] };
}

let brainReadOnly = true;
function setBrainReadOnly(value) {
  brainReadOnly = value;
  for (const id of ['keys', 'input-form', 'btn-kill']) $('#' + id).hidden = value;
  if (value) updateRc(null);
}
function openTerm(name) {
  setBrainReadOnly(isHerdr(name));
  showView('term');
  clearTimeout(listTimer);
  ensureTerm();
  $('#t-name').textContent = isHerdr(name) ? 'herdr ' + name.slice(2) : name;
  if (current === name && ws && ws.readyState <= 1) return;
  current = name;
  markSeen(termSeenKey(name));
  retry = 0;
  setLog(false);
  term.reset();
  // łączymy dopiero po pierwszym statusie: herdr startuje jako tylko-do-odczytu (bez klawiszy i pola wpisywania),
  // a odkrycie ich po podłączeniu zmniejszało terminal - Claude zostawiał dół narysowany dla starej wysokości
  pollStatus().finally(() => requestAnimationFrame(() => { if (current === name) { fit.fit(); connect(); } }));
}

function closeTerm() {
  if (current) markSeen(termSeenKey(current)); // to, co agent zrobił przy otwartym terminalu, już widziałeś
  current = null;
  clearTimeout(statusTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

function connect() {
  if (!current) return;
  const name = current;
  if (ws) { ws.onclose = null; ws.close(); }
  $('#t-conn').hidden = false;
  $('#t-conn').textContent = 'Łączenie…';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const hp = isHerdr(name) && herdrParts(name);
  const q = hp ? `h=${encodeURIComponent(hp.pane)}&m=${encodeURIComponent(hp.machine)}` : `s=${encodeURIComponent(name)}`;
  ws = new WebSocket(`${proto}://${location.host}/ws?${q}&c=${term.cols}&r=${term.rows}`);
  ws.onopen = () => { $('#t-conn').hidden = true; retry = 0; term.reset(); firePending(); };
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = async () => {
    if (current !== name) return;
    $('#t-conn').hidden = false;
    $('#t-conn').textContent = 'Rozłączono, ponawiam…';
    try {
      if (!(await targetInfo(name))) { $('#t-conn').textContent = 'Sesja zakończona'; return; }
    } catch { /* sieć padła, ponów */ }
    if (document.visibilityState === 'visible') setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
  };
}

async function pollStatus() {
  clearTimeout(statusTimer);
  if (!current) return;
  try {
    const t = current;
    const [s, hosts] = await Promise.all([targetInfo(t), api('/api/claude').catch(() => [])]);
    const hp = isHerdr(t) && herdrParts(t);
    const cl = hp ? (hosts.find((h) => h.host === hp.machine)?.sessions || []).find((c) => c.herdr === hp.pane)
      : (hosts.find((h) => h.local)?.sessions || []).find((c) => c.tmux === t);
    if (current !== t) return;
    setBrainReadOnly(isHerdr(t) && (!s || s.readOnly));
    updateRc(!s?.readOnly && s?.kind === 'claude' && s.status !== 'shell' ? (cl ? cl.rcUrl || 'off' : 'off') : null);
    currentInfo = s || null;
    if (s) {
      currentKind = s.kind;
      $('#t-name').textContent = s.name;
      statusDot(s.status, $('#t-dot'));
      $('#t-status').textContent = `${s.kind || '—'} · ${s.label}`;
      $('#t-status').className = 'small st-' + s.status;
    }
  } catch {}
  statusTimer = setTimeout(pollStatus, 3000);
}

$('#btn-back').addEventListener('click', () => goBack(SESSIONS_HASH, (h) => h === SESSIONS_HASH));

$('#btn-kill').addEventListener('click', async () => {
  const what = isHerdr(current) ? `panel herdr „${$('#t-name').textContent}”` : `sesję „${current}”`;
  if (!current || !confirm(`Zamknąć ${what}? Proces agenta zostanie zabity.`)) return;
  const name = current;
  closeTerm();
  try { await api(targetApi(name), { method: 'DELETE' }); } catch (e) { alert(e.message); }
  replaceHash(SESSIONS_HASH); // zamknięta sesja znika z historii, "wstecz" nie wraca do martwego terminala
});

// rozmiar terminala zmienia arkusz Wygląd (A−/A+); otwarty terminal dopasowuje się od razu
// motyw (arkusz Wygląd albo Auto za systemem) przemalowuje otwarty terminal bez przeładowania
let termResolved = Look.get().resolved;
Look.onChange(({ term: px, resolved }) => {
  if (term && resolved !== termResolved) Object.assign(term.options, Look.term());
  termResolved = resolved;
  if (px === fontSize) return;
  fontSize = px;
  if (!term) return;
  term.options.fontSize = fontSize;
  if (!$('#v-term').hidden) try { fit.fit(); } catch {}
});

// log: pełna historia jako zwykły tekst, wygodna do przewijania na telefonie
async function setLog(on) {
  $('#btn-log').setAttribute('aria-pressed', on);
  $('#log').hidden = !on;
  if (!on) return;
  $('#log').textContent = 'Ładowanie…';
  try {
    renderLog(await api(`${targetApi(current)}/log?lines=5000`));
    $('#log').scrollTop = $('#log').scrollHeight;
  } catch (e) { $('#log').textContent = e.message; }
}

// Zaznaczanie w xterm na iPhonie nie działa, więc polecenia „! …” z logu są do tapnięcia:
// trafiają do pola wiadomości (i schowka). Agent sam zawija tekst do szerokości panelu,
// dlatego linia prawie pełnej szerokości plus kolejna z tym samym wcięciem to dalszy ciąg polecenia.
const BANG_RE = /^(\s*(?:[⏺●•›*-]\s+|\d+[.)]\s+)?)!\s*\S/;
function renderLog(text) {
  const box = $('#log');
  const lines = text.replace(/\n+$/, '').split('\n');
  const width = Math.max(...lines.map((l) => l.trimEnd().length));
  box.replaceChildren();
  let plain = [];
  const flush = () => { if (plain.length) box.append(plain.join('\n') + '\n'); plain = []; };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(BANG_RE);
    if (!m) { plain.push(lines[i]); continue; }
    const col = m[1].length;
    let j = i + 1;
    while (j < lines.length && j - i <= 4 && lines[j - 1].trimEnd().length >= width - 20
      && /^\s*$/.test(lines[j].slice(0, col)) && lines[j][col] && lines[j][col] !== ' ' && !BANG_RE.test(lines[j])) j++;
    const raw = lines.slice(i, j);
    const cmd = raw.map((l) => l.slice(col).trimEnd()).join(' ');
    flush();
    const b = el('span', 'log-cmd', raw.join('\n'));
    b.addEventListener('click', () => {
      input.value = cmd;
      input.dispatchEvent(new Event('input'));
      Clips.copy(cmd).catch(() => {});
      if (navigator.vibrate) navigator.vibrate(8);
      b.classList.add('picked');
      setTimeout(() => b.classList.remove('picked'), 600);
    });
    box.append(b, '\n');
    i = j - 1;
  }
  flush();
}
$('#btn-log').addEventListener('click', () => setLog($('#btn-log').getAttribute('aria-pressed') !== 'true'));

// pasek klawiszy (public/term-keys.js, ten sam w doku shella); ⚙ Model, ! cmd i 📋 mają własne listenery
TermKeys.attach($('#keys'), { send: (d) => wsSend({ t: 'i', d }), appCursor: () => term.modes.applicationCursorKeysMode });

// pole tekstowe: wklejka (bracketed paste) + Enter
const input = $('#input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#input-form').requestSubmit(); }
});
$('#input-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  // „! polecenie”: Claude Code wchodzi w tryb bash tylko po osobno wpisanym „!”, wysłane razem z resztą jest zwykłym tekstem
  const bang = /^!\s*\S/.test(text) && !text.includes('\n');
  const body = bang ? text.slice(1).replace(/^\s+/, '') : text;
  if (bang) wsSend({ t: 'i', d: '!' });
  setTimeout(() => {
    if (body) wsSend({ t: 'i', d: body.includes('\n') ? `\x1b[200~${body}\x1b[201~` : body });
    setTimeout(() => wsSend({ t: 'i', d: '\r' }), body ? 80 : 0);
  }, bang ? 150 : 0);
  input.value = '';
  input.style.height = 'auto';
  if ($('#btn-log').getAttribute('aria-pressed') === 'true') setLog(false);
});

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
api('/api/sessions').then(route).catch(() => {});

// ---------- szybka zmiana modelu / effort ----------
function sendLine(text) {
  wsSend({ t: 'i', d: text });
  setTimeout(() => wsSend({ t: 'i', d: '\r' }), 80);
}
function chipGroup(title, items, onPick) {
  const wrap = el('div', 'chip-group');
  wrap.append(el('h3', '', title));
  const row = el('div', 'chip-row');
  for (const [value, label] of items) {
    const b = el('button', 'chip big', label);
    b.type = 'button';
    b.addEventListener('click', () => { onPick(value); $('#dlg-model').close(); });
    row.append(b);
  }
  wrap.append(row);
  return wrap;
}
$('#btn-model').addEventListener('click', async () => {
  const m = await getModels();
  const body = $('#model-body');
  body.replaceChildren();
  if (currentKind === 'codex') {
    $('#model-title').textContent = 'Codex: model i effort';
    body.append(el('p', 'muted small', 'Codex zmienia model i effort we własnym menu. Otwórz je i wybierz strzałkami oraz ⏎ z paska klawiszy.'));
    const b = el('button', 'btn primary wide', 'Otwórz /model w Codex');
    b.type = 'button';
    b.addEventListener('click', () => { sendLine('/model'); $('#dlg-model').close(); });
    body.append(b);
    if (m.codex.models.length) {
      body.append(el('p', 'muted small', 'Dostępne: ' + m.codex.models.map((x) => `${x.name} (${x.efforts.join('/')})`).join(', ')));
    }
  } else if (currentKind === 'claude') {
    $('#model-title').textContent = 'Claude: model i effort';
    body.append(
      chipGroup('Model', m.claude.models.map((x) => [x.id, x.name]), (v) => sendLine('/model ' + v)),
      chipGroup('Effort', m.claude.efforts.map((e) => [e, e]), (v) => sendLine('/effort ' + v)),
      chipGroup('Inne', [['/fast', '⚡ fast on/off'], ['/model', 'menu /model'], ['/effort', 'menu /effort']], (v) => sendLine(v)),
    );
  } else {
    $('#model-title').textContent = 'Model';
    body.append(el('p', 'muted', 'W tej sesji nie działa Claude ani Codex.'));
  }
  $('#dlg-model').showModal();
});
// polecenia z ostatnich odpowiedzi Claude (z transkryptu, bez zawijania): linie „! …” i bloki bash/sh/powershell jako karty
$('#btn-bang').addEventListener('click', async () => {
  const body = $('#model-body');
  $('#model-title').textContent = 'Polecenia od agenta';
  body.replaceChildren(el('p', 'muted small', 'Ładowanie…'));
  $('#dlg-model').showModal();
  let res;
  try { res = await api(`${targetApi(current)}/cmds`); } catch (e) { body.replaceChildren(el('p', 'err', e.message)); return; }
  // stary serwer (przed restartem) zwraca tylko `cmds`
  const list = res.blocks || (res.cmds || []).map((t) => ({ text: t.replace(/^!\s*/, ''), lang: 'sh', bang: true, multi: false }));
  body.replaceChildren(list.length
    ? el('p', 'muted small', '„Wstaw” wpisuje bez Entera, „Uruchom” pyta o potwierdzenie. Najnowsze na dole.')
    : el('p', 'muted', 'Brak poleceń w ostatnich odpowiedziach (działa dla Claude na tej maszynie).'));
  if (list.length) body.append(cmdCards(list, true));
  requestAnimationFrame(() => { body.lastElementChild?.lastElementChild?.scrollIntoView({ block: 'nearest' }); });
});
// ---------- schowek: historia skopiowanych tekstów, tapnięcie wkleja do sesji ----------
// Na iPhonie do terminala xterm nie da się wkleić (brak menu „Wklej”), a pole wiadomości wysyła od razu z Enterem.
// Historia zbiera wszystko, co skopiowano w panelu (zaznaczenie w terminalu, logu, czacie Dyspozytora i przyciski
// kopiowania), plus ręcznie dodane ze schowka systemowego. Leży tylko w localStorage tego urządzenia.
const Clips = ClipHistory.store;
document.addEventListener('copy', (e) => {
  const fromTerm = term && e.target instanceof Node && $('#xterm').contains(e.target);
  // xterm wypełnia clipboardData we własnym handlerze, więc czytamy po nim
  setTimeout(() => { const t = fromTerm ? term.getSelection() : String(getSelection() || ''); if (t) Clips.add(t); });
});
// Cmd+V do terminala na Macu też trafia do historii (wkleja sam xterm)
$('#xterm').addEventListener('paste', (e) => { const t = e.clipboardData?.getData('text/plain'); if (t) Clips.add(t); }, true);

function pasteToSession(text) {
  if (brainReadOnly || !ws || ws.readyState !== 1) return false;
  wsSend({ t: 'i', d: ClipHistory.pasteSeq(text) });
  if (navigator.vibrate) navigator.vibrate(8);
  return true;
}
const clipMsg = (text, err) => { $('#clips-msg').textContent = text; $('#clips-msg').className = err ? 'err' : 'muted small'; };
function renderClips() {
  const box = $('#clips-list');
  const list = Clips.list();
  box.replaceChildren();
  $('#clips-clear').hidden = !list.length;
  if (!list.length) { box.append(el('p', 'empty', 'Pusto. Skopiuj tekst w panelu albo dodaj ze schowka systemowego.')); return; }
  for (const it of list) {
    const row = el('div', 'clip' + (it.pin ? ' pinned' : ''));
    const pv = ClipHistory.preview(it.t);
    const paste = el('button', 'clip-paste');
    paste.type = 'button';
    paste.title = `Wklej ${clipTarget.where} (bez Entera)`;
    paste.append(el('pre', '', pv.text), el('span', 'clip-meta', `${it.pin ? '📌 ' : ''}${pv.lines > 1 ? pv.lines + ' linii · ' : ''}${it.t.length} zn. · ${ago(it.at / 1000)}`));
    paste.addEventListener('click', () => {
      if (!clipTarget.paste(it.t)) { clipMsg(`${clipTarget.who} nie jest połączona, nie wkleiłem.`, true); return; }
      Clips.add(it.t); // użyte = najświeższe
      $('#dlg-clips').close();
    });
    const pin = el('button', it.pin ? 'pin-on' : '', '📌');
    pin.type = 'button';
    pin.setAttribute('aria-label', it.pin ? 'Odepnij' : 'Przypnij');
    pin.addEventListener('click', () => {
      const before = Clips.list().filter((x) => x.pin).length;
      const after = Clips.togglePin(it.t).filter((x) => x.pin).length;
      if (!it.pin && after === before) clipMsg(`Najwyżej ${ClipHistory.PIN_LIMIT} przypiętych.`, true);
      renderClips();
    });
    const del = el('button', '', '🗑');
    del.type = 'button';
    del.setAttribute('aria-label', 'Usuń');
    del.addEventListener('click', () => { Clips.remove(it.t); renderClips(); });
    const btns = el('div', 'clip-btns');
    btns.append(pin, del);
    row.append(paste, btns);
    box.append(row);
  }
}
// cel wklejki z okna Schowka: terminal sesji albo dok shella (shell-dock.js woła openClips z własnym celem)
const SESSION_CLIPS = { paste: pasteToSession, who: 'Sesja', where: 'do sesji' };
let clipTarget = SESSION_CLIPS;
function openClips(target = SESSION_CLIPS, msg = '', err = false) {
  clipTarget = target;
  clipMsg(msg || `Tapnij pozycję, żeby wkleić ${target.where}. Enter wciskasz sam.`, err);
  $('#clips-text').value = '';
  renderClips();
  $('#dlg-clips').showModal();
}
$('#btn-clips').addEventListener('click', () => openClips());
// iOS pokazuje dymek „Wklej” i dopiero po jego tapnięciu oddaje tekst; odmowa albo brak API = pole „wklej tutaj”
$('#clips-read').addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.readText) throw new Error('brak API');
    const t = await navigator.clipboard.readText();
    if (!t.trim()) { clipMsg('Schowek systemowy jest pusty (albo nie zawiera tekstu).', true); return; }
    Clips.add(t);
    clipMsg('Dodałem ze schowka systemowego.');
    renderClips();
  } catch {
    clipMsg('Przeglądarka nie dała odczytać schowka. Przytrzymaj pole niżej → Wklej → Dodaj.', true);
    $('#clips-text').focus();
  }
});
$('#clips-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#clips-text').value;
  if (!t.trim()) return;
  Clips.add(t);
  $('#clips-text').value = '';
  clipMsg(`Dodane. Tapnij, żeby wkleić ${clipTarget.where}.`);
  renderClips();
});
$('#clips-clear').addEventListener('click', () => {
  if (!confirm('Usunąć całą historię schowka z tego urządzenia (z przypiętymi)?')) return;
  Clips.clear();
  clipMsg('Historia wyczyszczona.');
  renderClips();
});
$('#clips-close').addEventListener('click', () => $('#dlg-clips').close());
$('#dlg-clips').addEventListener('click', (e) => { if (e.target.id === 'dlg-clips') e.target.close(); });

// ---------- polecenia od agentów: karty „Kopiuj / Wstaw / Uruchom” ----------
// Agenci podają polecenia do odpalenia przez „!” (klasyfikator blokuje im część komend). Karty pokazują je w czacie
// Dyspozytora i w oknie „! cmd”. Wykonanie wyłącznie przez WebSocket otwartego terminala tej sesji (auth + Origin jak
// cały /ws), dopiero po tapnięciu „Uruchom” w oknie potwierdzenia. Serwer nie ma endpointu, który coś uruchamia.
let currentInfo = null;   // ostatni status otwartego terminalu (pollStatus)
let pendingCmd = null;    // { c, mode, target } - z czatu: czeka na połączenie z wybraną sesją
let runState = null;      // { c, target } - otwarte okno potwierdzenia
const cmdLabel = (c) => c.lang === 'ps' ? 'PowerShell' : c.multi ? `skrypt · ${c.text.split('\n').length} linii` : c.bang ? '! w Claude Code' : c.run === false ? 'polecenie' : 'bash';
const cmdCopyText = (c) => (c.bang ? '! ' + c.text : c.text);
const cmdBang = (c, kind) => c.lang === 'sh' && kind === 'claude';
function flash(b, text) {
  const old = b.dataset.label || (b.dataset.label = b.textContent);
  b.textContent = text;
  clearTimeout(b._flash);
  b._flash = setTimeout(() => { b.textContent = old; }, 1400);
}
// Desktop: schowek systemowy + historia; bez navigator.clipboard (inny kontekst niż HTTPS/localhost, odmowa przeglądarki)
// zapasowo execCommand('copy') z ukrytego pola - w otwartym oknie modalnym, bo reszta strony jest wtedy inert.
function copyText(t) {
  Clips.add(t);
  const legacy = () => {
    const ta = el('textarea', '');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    (document.querySelector('dialog[open]') || document.body).append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('Brak dostępu do schowka'));
  };
  if (!window.isSecureContext || !navigator.clipboard?.writeText) return legacy();
  return navigator.clipboard.writeText(t).catch(legacy);
}
function cmdCard(c, here) {
  const desk = desktopCopy.matches;
  const warn = AgentCmds.danger(c.text);
  const card = el('div', 'cmd-card' + (warn.length ? ' danger' : ''));
  const head = el('div', 'cmd-head');
  head.append(el('span', 'cmd-kind', cmdLabel(c)));
  if (warn.length) head.append(el('span', 'cmd-warn', '⚠ może usunąć dane'));
  const pre = el('pre', 'cmd-text');
  if (c.bang) pre.append(el('span', 'cmd-bang', '! '));
  pre.append(c.text);
  const btns = el('div', 'cmd-btns');
  const copy = el('button', 'act-btn', 'Kopiuj');
  copy.type = 'button';
  if (desk) {
    // na Macu polecenie trafia do Terminala: samo polecenie, bez „! ” trybu bash Claude Code
    copy.title = 'Kopiuj samo polecenie (bez „! ”)';
    copy.addEventListener('click', () => copyText(c.text).then(() => flash(copy, 'Skopiowane ✓'), () => flash(copy, 'W historii 📋')));
  } else copy.addEventListener('click', () => Clips.copy(cmdCopyText(c)).then(() => flash(copy, 'Skopiowane ✓'), () => flash(copy, 'W historii 📋')));
  const note = c.note ? el('div', 'cmd-note') : null;
  if (note) mozgInline(note, c.note);
  if (c.run === false) { // desktop: polecenie do wpisania samemu (np. na Macu) - tylko kopiowanie
    btns.append(copy);
    card.classList.add('copy-only');
    card.append(head, pre, ...(note ? [note] : []), btns);
    return card;
  }
  const ins = el('button', 'act-btn', here ? 'Wstaw' : 'Wstaw…');
  ins.type = 'button';
  ins.title = 'Wstaw do sesji bez Entera';
  ins.addEventListener('click', () => (here ? insertCmd(c, ins) : pickTarget(c, 'insert')));
  btns.append(copy, ins);
  if (c.lang !== 'ps') {
    const run = el('button', 'act-btn primary' + (warn.length ? ' danger' : ''), here ? '▶ Uruchom' : '▶ Uruchom…');
    run.type = 'button';
    run.title = 'Uruchom w sesji Claude Code przez „!” (po potwierdzeniu)';
    run.addEventListener('click', () => { if (here) { $('#dlg-model').close(); openRunConfirm(c); } else pickTarget(c, 'run'); });
    btns.append(run);
  }
  card.append(head, pre, ...(note ? [note] : []), btns);
  return card;
}
function cmdCards(list, here) {
  const box = el('div', 'cmd-cards');
  if (desktopCopy.matches && list.length > 1) {
    const all = el('button', 'act-btn cmd-copy-all', `Kopiuj wszystkie (${list.length})`);
    all.type = 'button';
    all.title = 'Polecenia po kolei, każde w osobnej linii, bez „! ” i numeracji';
    all.addEventListener('click', () => copyText(AgentCmds.copyAll(list)).then(() => flash(all, 'Skopiowane ✓'), () => flash(all, 'W historii 📋')));
    box.append(all);
  }
  for (const c of list) box.append(cmdCard(c, here));
  return box;
}
// Desktop: kliknięcie w `kod` w odpowiedzi Dyspozytora kopiuje go (bez wiodącego „! ”); przeciągnięcie myszą dalej zaznacza
$('#mozg-thread').addEventListener('click', (e) => {
  const code = e.target.closest?.('.mozg-rich code');
  if (!code || !desktopCopy.matches || code.closest('.mozg-message.user')) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  const t = code.textContent.replace(/^!\s*(?=\S)/, '').trim();
  if (!t) return;
  copyText(t).then(() => {
    code.classList.add('copied');
    clearTimeout(code._copied);
    code._copied = setTimeout(() => code.classList.remove('copied'), 1200);
  }, () => {});
});

// klawisze po kolei do panelu `target`; przerwane, gdy terminal zmienił sesję albo się rozłączył
function sendSteps(list, target) {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= list.length) return resolve(true);
      const st = list[i++];
      setTimeout(() => {
        if (current !== target || brainReadOnly || !ws || ws.readyState !== 1) return resolve(false);
        wsSend({ t: 'i', d: st.d });
        next();
      }, st.wait);
    };
    next();
  });
}
async function insertCmd(c, btn) {
  const target = current;
  const info = (await targetInfo(target).catch(() => null)) || currentInfo || {};
  const ok = AgentCmds.allowed(info, 'insert', c.lang);
  if (!ok.ok) { if (btn) flash(btn, 'Nie teraz'); alert(ok.why); return; }
  $('#dlg-model').close();
  const sent = await sendSteps(AgentCmds.steps(c.text, { mode: 'insert', bang: cmdBang(c, info.kind) }), target);
  if (sent && navigator.vibrate) navigator.vibrate(8);
}

// okno potwierdzenia: pełna treść, sesja docelowa, ostrzeżenie destrukcyjne; wykonuje dopiero „Uruchom”
async function openRunConfirm(c) {
  const target = current;
  runState = { c, target };
  const warn = AgentCmds.danger(c.text);
  const line = AgentCmds.bashLine(c.text);
  $('#run-cmd').textContent = c.text;
  $('#run-sent-wrap').hidden = !c.multi;
  $('#run-sent').textContent = line;
  $('#run-danger').hidden = !warn.length;
  $('#run-danger').replaceChildren(el('b', '', '⚠ Uwaga: polecenie może usunąć lub nadpisać dane'), el('ul', ''));
  for (const w of warn) $('#run-danger ul').append(el('li', '', w));
  $('#run-go').classList.toggle('danger', !!warn.length);
  $('#run-go').textContent = warn.length ? 'Uruchom mimo to' : 'Uruchom';
  $('#run-target').textContent = $('#t-name').textContent;
  $('#run-status').textContent = 'sprawdzam…';
  $('#run-status').className = 'small';
  $('#run-why').textContent = '';
  $('#run-go').disabled = true;
  if (!$('#dlg-run').open) $('#dlg-run').showModal();
  const info = await targetInfo(target).catch(() => null);
  if (runState?.target !== target || runState.c !== c) return;
  const ok = info ? AgentCmds.allowed(info, 'run', c.lang) : { ok: false, why: 'Sesja nie istnieje.' };
  if (info) {
    $('#run-target').textContent = info.name;
    $('#run-status').textContent = `${info.kind || '—'} · ${info.label}`;
    $('#run-status').className = 'small st-' + info.status;
  }
  $('#run-why').textContent = ok.why;
  $('#run-go').disabled = !ok.ok;
}
$('#run-go').addEventListener('click', async () => {
  const st = runState;
  if (!st) return;
  $('#run-go').disabled = true;
  // stan sesji mógł się zmienić od otwarcia okna: sprawdź jeszcze raz tuż przed wysłaniem
  const info = await targetInfo(st.target).catch(() => null);
  const ok = !info ? { ok: false, why: 'Sesja nie istnieje.' } : current !== st.target ? { ok: false, why: 'Terminal pokazuje już inną sesję.' }
    : !ws || ws.readyState !== 1 ? { ok: false, why: 'Terminal nie jest połączony.' } : AgentCmds.allowed(info, 'run', st.c.lang);
  if (runState !== st) return;
  if (!ok.ok) { $('#run-why').textContent = ok.why; return; }
  runState = null;
  $('#dlg-run').close();
  if ($('#btn-log').getAttribute('aria-pressed') === 'true') setLog(false);
  const sent = await sendSteps(AgentCmds.steps(st.c.text, { mode: 'run' }), st.target);
  if (navigator.vibrate) navigator.vibrate(sent ? 12 : [8, 60, 8]);
  if (!sent) alert('Przerwane: terminal się rozłączył albo zmienił sesję. Sprawdź, co zostało w polu wpisywania.');
});
$('#run-cancel').addEventListener('click', () => $('#dlg-run').close());
$('#dlg-run').addEventListener('close', () => { runState = null; });

// z czatu Dyspozytora: wybór sesji (panel Dyspozytora jest tylko do podglądu), potem terminal tej sesji
async function pickTarget(c, mode) {
  const dlg = $('#dlg-run-target');
  $('#rt-title').textContent = mode === 'run' ? 'Gdzie uruchomić?' : 'Gdzie wstawić?';
  $('#rt-cmd').textContent = cmdCopyText(c);
  $('#rt-msg').textContent = 'Ładowanie sesji…';
  $('#rt-list').replaceChildren();
  dlg.showModal();
  let rows = [];
  try {
    const [hd, tm] = await Promise.all([api('/api/herdr').catch(() => ({ items: [] })), api('/api/sessions').catch(() => [])]);
    rows = [
      ...hd.items.filter((it) => it.agent && ['claude', 'codex'].includes(it.kind) && !isBrainPane(it)).map((it) => ({
        hash: `#/h/${encodeURIComponent(it.machine)}/${encodeURIComponent(it.pane)}`, target: `h:${it.machine}/${it.pane}`,
        name: `${it.display || it.name} · ${it.machine}`, kind: it.kind, status: it.status, cwd: it.cwd })),
      ...tm.filter((s) => ['claude', 'codex'].includes(s.kind)).map((s) => ({
        hash: '#/s/' + encodeURIComponent(s.name), target: s.name, name: s.name + ' · tmux', kind: s.kind, status: s.status, cwd: s.cwd })),
    ];
  } catch (e) { $('#rt-msg').textContent = e.message; return; }
  if (!dlg.open) return;
  const project = mozgThreads.find((t) => t.id === mozgActive)?.project || '';
  const inProject = (r) => !!project && (shortPath(r.cwd || '') + '/').startsWith(project + '/');
  for (const r of rows) r.ok = AgentCmds.allowed(r, mode, c.lang);
  rows.sort((a, b) => (inProject(b) - inProject(a)) || (b.ok.ok - a.ok.ok) || ((STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3)));
  $('#rt-msg').textContent = rows.length
    ? (project ? `Najpierw sesje w ${project}. ` : '') + (mode === 'run' ? 'Potem pokażę jeszcze okno potwierdzenia.' : 'Wstawię bez Entera.')
    : 'Brak działających sesji Claude/Codex. Załóż sesję na liście sesji.';
  for (const r of rows) {
    const b = dirRow(r.name, [inProject(r) ? '★ ten projekt' : '', r.kind, STATUS[r.status] || r.status, shortPath(r.cwd || '')].filter(Boolean).join(' · ')
      + (r.ok.ok ? '' : ' - ' + r.ok.why), () => {
      dlg.close();
      pendingCmd = { c, mode, target: r.target };
      if (location.hash === r.hash) firePending(); else location.hash = r.hash;
    });
    b.disabled = !r.ok.ok;
    $('#rt-list').append(b);
  }
}
$('#rt-close').addEventListener('click', () => $('#dlg-run-target').close());
$('#dlg-run-target').addEventListener('click', (e) => { if (e.target.id === 'dlg-run-target') e.target.close(); });
// po połączeniu terminalu wybranej sesji: potwierdzenie (run) albo wstawienie (insert)
function firePending() {
  const p = pendingCmd;
  if (!p || p.target !== current || !ws || ws.readyState !== 1) return;
  pendingCmd = null;
  setTimeout(() => { if (current === p.target) (p.mode === 'run' ? openRunConfirm(p.c) : insertCmd(p.c)); }, 600);
}

$('#model-close').addEventListener('click', () => $('#dlg-model').close());
$('#dlg-model').addEventListener('click', (e) => { if (e.target.id === 'dlg-model') e.target.close(); });

// ---------- Remote Control dla sesji z panelu ----------
let rcState = null; // null = nie Claude, 'off' = RC wyłączone, albo URL sesji
let rcPending = 0;
function updateRc(state) {
  rcState = state;
  const b = $('#btn-rc');
  b.hidden = !state;
  if (!state) return;
  const on = state !== 'off';
  if (on) rcPending = 0;
  b.textContent = on ? 'RC ↗' : (Date.now() - rcPending < 15000 ? 'RC…' : 'RC wł.');
  b.classList.toggle('on', on);
}
$('#btn-rc').addEventListener('click', () => {
  if (rcState && rcState !== 'off') { window.open(rcState, '_blank', 'noopener'); return; }
  if (Date.now() - rcPending < 15000) return; // /remote-control to przełącznik: nie wysyłaj dwa razy
  rcPending = Date.now();
  sendLine('/remote-control');
  updateRc('off');
});

// ---------- powiadomienia push ----------
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const b64ToBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
async function currentSub() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
// Ikony nagłówka (Aa wygląd, 📅 kalendarz, 🔔 dzwonek) - jeden komponent wstawiany do każdego '.hdr-actions' (Sesje, Dyspozytor)
for (const box of $$('.hdr-actions')) {
  const look = el('button', 'icon-btn look-btn', 'Aa');
  Object.assign(look, { type: 'button', title: 'Wygląd (rozmiar tekstu, terminal)' });
  look.setAttribute('aria-label', 'Wygląd');
  box.append(look);
  const cal = el('a', 'icon-btn cal-btn', '📅');
  Object.assign(cal, { href: '#/kalendarz', title: 'Kalendarz (crony, timery, harmonogramy)' });
  cal.setAttribute('aria-label', 'Kalendarz');
  const bell = el('button', 'icon-btn bell-btn');
  bell.type = 'button';
  bell.setAttribute('aria-label', 'Powiadomienia');
  bell.append(el('span', 'bell-icon'), el('span', 'bell-badge'));
  bell.firstChild.innerHTML = HdrIcons.svg('bell-off');
  bell.lastChild.hidden = true;
  box.append(cal, bell);
}
// ---------- arkusz Wygląd (Aa): motyw, rozmiar tekstu S/M/L/XL, gęstość, A−/A+ terminala, legenda; zapis per urządzenie (look.js) ----------
const lookDlg = $('#dlg-look');
// grupa radiowa: data-v = wartość, aria-checked z showLook, strzałki przesuwają wybór (jak natywne radio)
function lookRadio(box, b, v, set) {
  b.type = 'button';
  b.dataset.v = v;
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => set(v));
  box.append(b);
}
for (const t of Look.THEMES) {
  const b = el('button', 'look-theme-btn');
  const sw = el('span', 'look-sw');
  // próbka w kolorach motywu: tokeny [data-theme] z style.css; Auto = pół ciemnego, pół jasnego
  for (const part of t === 'auto' ? ['dark', 'light'] : [t]) {
    const half = el('span');
    half.dataset.theme = part;
    half.append(el('i'), el('i'), el('i', 'a'));
    sw.append(half);
  }
  b.append(sw, el('b', '', Look.THEME_NAMES[t]));
  b.title = `${Look.THEME_NAMES[t]}: ${Look.THEME_HINTS[t]}`;
  b.setAttribute('aria-label', `Motyw ${Look.THEME_NAMES[t]}, ${Look.THEME_HINTS[t]}`);
  lookRadio($('#look-themes'), b, t, Look.setTheme);
}
for (const sz of Look.SIZES) {
  const b = el('button', 'look-size-btn', 'A');
  b.title = `${sz}: ${Look.PX[sz]} px`;
  b.setAttribute('aria-label', `Tekst ${Look.NAMES[sz]}, ${String(Look.PX[sz]).replace('.', ',')} px`);
  b.style.fontSize = `${Look.PX[sz]}px`; // podgląd: każda litera w swoim rozmiarze
  lookRadio($('#look-size'), b, sz, Look.setSize);
}
for (const d of Look.DENSITIES) lookRadio($('#look-density'), el('button', 'look-size-btn', Look.DENSITY_NAMES[d]), d, Look.setDensity);
for (const shape of StatusIcons.SHAPES) {
  const row = el('span', 'look-st si-' + shape);
  row.append(statusDot(Object.keys(StatusIcons.SHAPE).find((k) => StatusIcons.SHAPE[k] === shape)), el('span', '', StatusIcons.LABEL[shape]));
  $('#look-legend').append(row);
}
function showLook({ size, term: px, theme, resolved, density }) {
  for (const [box, v] of [['#look-themes', theme], ['#look-size', size], ['#look-density', density]]) {
    for (const b of $$(`${box} [role=radio]`)) {
      const on = b.dataset.v === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  $('#look-theme-hint').textContent = theme === 'auto'
    ? `Auto: jak system, teraz ${Look.THEME_NAMES[resolved]}.` : `${Look.THEME_NAMES[theme]}: ${Look.THEME_HINTS[theme]}.`;
  $('#look-term-val').textContent = `${px} px`;
  $('#look-term-dec').disabled = px <= Look.TERM_MIN;
  $('#look-term-inc').disabled = px >= Look.TERM_MAX;
}
Look.onChange(showLook);
$('#look-term-dec').addEventListener('click', () => Look.setTerm(Look.get().term - 1));
$('#look-term-inc').addEventListener('click', () => Look.setTerm(Look.get().term + 1));
for (const [box, list, key, set] of [['#look-themes', Look.THEMES, 'theme', Look.setTheme], ['#look-size', Look.SIZES, 'size', Look.setSize],
  ['#look-density', Look.DENSITIES, 'density', Look.setDensity]]) {
  $(box).addEventListener('keydown', (e) => { // strzałki w grupie radiowej
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const i = list.indexOf(Look.get()[key]), next = list[Math.max(0, Math.min(list.length - 1, i + d))];
    set(next);
    $(`${box} [data-v="${next}"]`).focus();
  });
}
function openLook() {
  showLook(Look.get());
  lookDlg.showModal();
}
for (const b of $$('.look-btn')) b.addEventListener('click', openLook);
$('#look-close').addEventListener('click', () => lookDlg.close());
lookDlg.addEventListener('click', (e) => { if (e.target === lookDlg) lookDlg.close(); }); // tap w tło zamyka

async function refreshBell() {
  const sub = await currentSub().catch(() => null);
  const on = !!sub && Notification.permission === 'granted';
  for (const x of $$('.bell-icon')) x.innerHTML = HdrIcons.svg(on ? 'bell' : 'bell-off');
  for (const b of $$('.bell-btn')) b.setAttribute('aria-label', on ? 'Powiadomienia (włączone)' : 'Powiadomienia (wyłączone)');
  return sub;
}
const pushPrefs = () => ({ done: $('#push-done').checked, approval: $('#push-approval').checked, mozg: $('#push-mozg').checked, limit: $('#push-limit').checked,
  limitCodex: $('#push-limit-codex').checked });

// historia powiadomień: licznik nieprzeczytanych na dzwonku (przeczytane = otwarte okno 🔔, per urządzenie)
let notifs = [], attentionItems = [];
const SEEN_KEY = 'ccp-notif-seen';
const seenAt = () => { try { return +localStorage.getItem(SEEN_KEY) || 0; } catch { return 0; } };
function updateBellBadge() {
  const n = attentionItems.length;
  for (const b of $$('.bell-badge')) { b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); }
}
function renderNotifs() {
  const box = $('#push-history');
  box.replaceChildren();
  if (!notifs.length) { box.append(el('p', 'empty', 'Brak powiadomień.')); return; }
  const seen = seenAt();
  for (const x of notifs.slice(0, 50)) {
    const row = el('div', 'notif-row' + (x.at > seen ? ' unread' : ''));
    const head = el('div', 'notif-head');
    head.append(el('span', 'notif-title', x.title || ''), el('span', 'muted small', ago(x.at)));
    row.append(head, el('div', 'muted small notif-body', String(x.body || '').replace(/\n/g, ' · ')));
    const hash = String(x.url || '').replace(/^[^#]*/, '');
    if (hash && hash !== '#/') {
      row.classList.add('clickable');
      row.addEventListener('click', () => { $('#dlg-push').close(); location.hash = hash; });
    }
    box.append(row);
  }
}
async function loadNotifs() {
  [notifs, attentionItems] = await Promise.all([api('/api/notifications').catch(() => notifs), api('/api/attention').catch(() => attentionItems)]);
  const box = $('#attention-list');
  box.replaceChildren();
  if (!attentionItems.length) box.append(el('p', 'empty', 'Nic nie czeka na Ciebie ✅'));
  for (const item of attentionItems) {
    const row = el('div', 'notif-row clickable');
    row.append(el('div', 'notif-title', item.title));
    if (item.body) row.append(el('div', 'muted small', item.body));
    row.addEventListener('click', () => { $('#dlg-push').close(); location.hash = item.url.slice(item.url.indexOf('#')); });
    box.append(row);
  }
  updateBellBadge();
}

async function openBell() {
  $('#push-err').textContent = '';
  const sub = await refreshBell();
  const on = !!sub && Notification.permission === 'granted';
  let info;
  if (!pushSupported) {
    info = standalone ? 'Ta przeglądarka nie obsługuje powiadomień push.'
      : 'Na iPhonie powiadomienia działają tylko w aplikacji z ekranu głównego: Udostępnij → Do ekranu początkowego, potem otwórz ją stamtąd.';
  } else if (Notification.permission === 'denied') {
    info = 'Powiadomienia są zablokowane w ustawieniach systemu dla tej aplikacji.';
  } else {
    info = on ? 'Powiadomienia są włączone na tym urządzeniu.' : 'Dostaniesz powiadomienie, gdy agent skończy pracę albo poprosi o zgodę — także przy zamkniętej aplikacji.';
  }
  $('#push-info').textContent = info;
  if (on) {
    const { prefs } = await api('/api/push/prefs', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => ({}));
    if (prefs) { $('#push-done').checked = prefs.done; $('#push-approval').checked = prefs.approval; $('#push-mozg').checked = prefs.mozg ?? true; $('#push-limit').checked = prefs.limit ?? true; $('#push-limit-codex').checked = prefs.limitCodex ?? true; }
  }
  $('#push-on').hidden = !pushSupported || Notification.permission === 'denied';
  $('#push-on').textContent = on ? 'Zapisz' : 'Włącz';
  $('#push-off').hidden = !on;
  $('#push-test').hidden = !on;
  await loadNotifs();
  renderNotifs(); // pogrubione = nieprzeczytane do tej chwili
  try { localStorage.setItem(SEEN_KEY, String(Date.now() / 1000)); } catch {}
  updateBellBadge();
  $('#notification-history').open = false;
  $('#dlg-push').showModal();
}
for (const b of $$('.bell-btn')) b.addEventListener('click', openBell);

$('#push-on').addEventListener('click', async () => {
  $('#push-err').textContent = '';
  try {
    if (await Notification.requestPermission() !== 'granted') throw new Error('Brak zgody na powiadomienia.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api('/api/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    }
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs: pushPrefs() } });
    await refreshBell();
    $('#dlg-push').close();
  } catch (e) { $('#push-err').textContent = e.message; }
});
$('#push-test').addEventListener('click', async () => {
  const sub = await currentSub();
  if (sub) await api('/api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } }).catch((e) => { $('#push-err').textContent = e.message; });
});
$('#push-off').addEventListener('click', async () => {
  const sub = await currentSub();
  if (sub) {
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  await refreshBell();
  $('#dlg-push').close();
});
$('#push-close').addEventListener('click', () => $('#dlg-push').close());
refreshBell();

setInterval(() => { if ($('#dlg-push').open) loadNotifs(); }, 5000);

let mozgProjectPath = '', mozgProjectSeq = 0, mozgProjectTimer = null;
async function openMozgProjects() {
  $('#mozg-project-search').value = ''; $('#mozg-project-error').textContent = '';
  $('#dlg-mozg-project').showModal();
  await browseMozgProjects('');
}
async function browseMozgProjects(path = mozgProjectPath) {
  const seq = ++mozgProjectSeq;
  const query = $('#mozg-project-search').value.trim();
  try {
    const result = await api('/api/mozg/projects?' + (query ? 'q=' + encodeURIComponent(query) : 'path=' + encodeURIComponent(path)));
    if (seq !== mozgProjectSeq || !$('#dlg-mozg-project').open) return;
    mozgProjectPath = path;
    $('#mozg-project-path').textContent = query ? 'Wyniki wyszukiwania' : '~/Projekty/' + path;
    const box = $('#mozg-project-list'); box.replaceChildren();
    if (!query && path) {
      const up = el('button', 'btn', '↑ Katalog wyżej'); up.type = 'button';
      up.addEventListener('click', () => browseMozgProjects(path.split('/').slice(0, -1).join('/'))); box.append(up);
      const select = el('button', 'btn primary', 'Wybierz ten projekt'); select.type = 'button';
      select.addEventListener('click', () => createMozgThread(path)); box.append(select);
    }
    for (const dir of result.dirs || []) {
      const rel = query ? dir : (path ? path + '/' + dir : dir);
      const row = el('div', 'mozg-project-row');
      const select = el('button', 'btn', dir); select.type = 'button';
      select.addEventListener('click', () => createMozgThread(rel));
      const browse = el('button', 'btn', '›'); browse.type = 'button'; browse.setAttribute('aria-label', 'Podkatalogi ' + dir);
      browse.addEventListener('click', () => { $('#mozg-project-search').value = ''; browseMozgProjects(rel); });
      row.append(select, browse); box.append(row);
    }
    if (!(result.dirs || []).length) box.append(el('p', 'muted', 'Brak podkatalogów.'));
  } catch (e) { if (seq === mozgProjectSeq) $('#mozg-project-error').textContent = e.message; }
}
async function createMozgThread(project) {
  const box = $('#mozg-project-list');
  for (const button of box.querySelectorAll('button')) button.disabled = true;
  try {
    const thread = await api('/api/mozg/threads', { method: 'POST', body: { project } });
    $('#dlg-mozg-project').close(); location.hash = mozgHash(thread.id);
  } catch (e) { $('#mozg-project-error').textContent = e.message; }
  finally { for (const button of box.querySelectorAll('button')) button.disabled = false; }
}
$('#mozg-project-search').addEventListener('input', () => { clearTimeout(mozgProjectTimer); mozgProjectTimer = setTimeout(() => browseMozgProjects(), 200); });
$('#mozg-project-close').addEventListener('click', () => { ++mozgProjectSeq; $('#dlg-mozg-project').close(); });
$('#mozg-archive').addEventListener('click', async () => {
  const thread = mozgThreads.find(t => t.id === mozgActive);
  if (!thread || thread.id === 'general' || thread.busy || mozgPendingByThread.has(thread.id)) return;
  if (!confirm('Zarchiwizować zakładkę „' + thread.title + '”?')) return;
  $('#mozg-archive').disabled = true;
  try {
    await api('/api/mozg/archive', { method: 'POST', body: { id: thread.id } });
    mozgDrafts.delete(thread.id); location.hash = mozgHash('general');
  } catch (e) { $('#mozg-error').textContent = e.message; $('#mozg-archive').disabled = false; }
});

// ---------- podpięte panele Herdr (mozgd panel_inventory / panel_bind / panel_unbind) ----------
let mpPanels = [], mpThread = 'general', mpPicked = null, mpSeq = 0, mpTimer = null;
const mpTitle = id => mozgThreads.find(t => t.id === id)?.title || id;
function mpRow(p, sub, action) {
  const txt = el('span', 'mp-txt');
  txt.append(el('b', '', p.label || p.id), el('span', '', sub));
  const row = el(action ? 'div' : 'button', 'mp-row');
  row.append(txt);
  if (action) row.append(action);
  else row.type = 'button';
  return row;
}
function renderMozgPanels() {
  const tokens = SessionSearch.parse($('#mp-search').value);
  const { bound, candidates, hidden } = MozgPanels.split(mpPanels, mpThread, tokens, SessionSearch.matches);
  const boxB = $('#mp-bound'); boxB.replaceChildren();
  for (const p of bound) {
    const unbind = el('button', 'btn', 'Odepnij'); unbind.type = 'button';
    unbind.addEventListener('click', () => unbindMozgPanel(p));
    boxB.append(mpRow(p, MozgPanels.detail(p) + ` · co najmniej ${MozgPanels.minutes(p.binding.min_interval_s)} min`, unbind));
  }
  if (!bound.length) boxB.append(el('p', 'mp-empty', 'Brak podpiętych paneli.'));
  const form = $('#mp-form'), list = $('#mp-list');
  form.hidden = !mpPicked;
  list.hidden = !!mpPicked;
  list.replaceChildren();
  for (const p of candidates) {
    const row = mpRow(p, MozgPanels.detail(p) + (p.binding ? ` · podpięty do „${mpTitle(p.binding.thread_id)}”` : ''));
    row.disabled = !!p.binding;
    row.addEventListener('click', () => pickMozgPanel(p));
    list.append(row);
  }
  if (!candidates.length) list.append(el('p', 'mp-empty', tokens.length ? 'Nic nie pasuje.' : 'Brak paneli do podpięcia.'));
  $('#mp-hidden').textContent = hidden ? `Pominąłem ${hidden} paneli mózgu i workerów rotatora - tych się nie podpina.` : '';
}
function pickMozgPanel(p) {
  mpPicked = p;
  $('#mp-picked').textContent = (p.label || p.id) + ' (' + p.id + ')';
  const sel = $('#mp-thread'); sel.replaceChildren();
  for (const t of MozgTabs.sortThreads(mozgThreads)) {
    const o = el('option', '', t.title); o.value = t.id; o.selected = t.id === mpThread; sel.append(o);
  }
  $('#mp-interval').value = '';
  $('#mp-error').textContent = ''; $('#mp-ok').textContent = '';
  renderMozgPanels();
}
async function loadMozgPanels() {
  const seq = ++mpSeq;
  $('#mp-error').textContent = '';
  try {
    const { panels } = await api('/api/mozg/panels');
    if (seq !== mpSeq || !$('#dlg-mozg-panels').open) return;
    mpPanels = panels || [];
    if (mpPicked) mpPicked = mpPanels.find(p => p.id === mpPicked.id && p.bindable && !p.binding) || null;
    renderMozgPanels();
  } catch (e) { if (seq === mpSeq) $('#mp-error').textContent = e.message; }
}
async function openMozgPanels() {
  mpThread = mozgActive; mpPicked = null; mpPanels = [];
  $('#mp-title').textContent = 'Panele · ' + mpTitle(mpThread);
  $('#mp-search').value = ''; $('#mp-ok').textContent = ''; $('#mp-hidden').textContent = '';
  $('#mp-bound').replaceChildren(el('p', 'mp-empty', 'Wczytuję panele z Herdr…'));
  $('#mp-list').replaceChildren(); $('#mp-form').hidden = true;
  $('#dlg-mozg-panels').showModal();
  await loadMozgPanels();
}
async function bindMozgPanel() {
  if (!mpPicked) return;
  const raw = $('#mp-interval').value.trim();
  const body = { panel: mpPicked.selector, thread_id: $('#mp-thread').value };
  if (raw) body.min_interval_min = Number(raw);
  const btn = $('#mp-bind'); btn.disabled = true;
  $('#mp-error').textContent = '';
  try {
    const row = await api('/api/mozg/panels/bind', { method: 'POST', body });
    $('#mp-ok').textContent = `Podpięty: ${row.label || row.pane} → zakładka „${mpTitle(row.thread_id)}”.`;
    mpPicked = null; $('#mp-search').value = '';
    await loadMozgPanels();
  } catch (e) { $('#mp-error').textContent = e.message; }
  finally { btn.disabled = false; }
}
async function unbindMozgPanel(p) {
  if (!confirm(`Odpiąć panel „${p.label || p.id}” od zakładki „${mpTitle(p.binding.thread_id)}”?\nPanel działa dalej, Dyspozytor przestanie dostawać jego powiadomienia.`)) return;
  $('#mp-error').textContent = ''; $('#mp-ok').textContent = '';
  try {
    await api('/api/mozg/panels/unbind', { method: 'POST', body: { panel: p.id } });
    $('#mp-ok').textContent = `Odpięty: ${p.label || p.id}.`;
    await loadMozgPanels();
  } catch (e) { $('#mp-error').textContent = e.message; }
}
$('#mozg-panels').addEventListener('click', openMozgPanels);
$('#mp-close').addEventListener('click', () => { ++mpSeq; $('#dlg-mozg-panels').close(); });
$('#mp-search').addEventListener('input', () => { clearTimeout(mpTimer); mpTimer = setTimeout(renderMozgPanels, 120); });
$('#mp-unpick').addEventListener('click', () => { mpPicked = null; renderMozgPanels(); });
$('#mp-bind').addEventListener('click', bindMozgPanel);
