// Kalendarz (E1, tylko odczyt): crony, timery systemd, harmonogramy mozgd. Wyświetlanie zawsze w czasie Europe/Warsaw:
// serwer daje ISO UTC, tu zamiana na czas ścienny Warsaw (Intl, DST per chwila) podawany EventCalendar jako "floating".
// EventCalendar 5.15 nie zna stref IANA, a jego tryb "local" przelicza wszystko jednym offsetem (wynik spike'u E0).
(function (root) {
  'use strict';
  const TZ = 'Europe/Warsaw';
  const wallFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  // ISO UTC -> "YYYY-MM-DDTHH:MM:SS" czasu ściennego Warsaw (bez offsetu)
  const warsawWall = (iso) => wallFmt.format(new Date(iso)).replace(' ', 'T');
  // bieżący offset Warsaw "+02:00"/"+01:00" - opcja timeZone EC, żeby "dzisiaj" i linia "teraz" były warszawskie
  function warsawOffset(d = new Date()) {
    const part = new Intl.DateTimeFormat('en', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName');
    return (part && part.value.replace('GMT', '')) || '+00:00';
  }
  const addMin = (wall, min) => {
    const t = Date.parse(wall + 'Z') + min * 60e3;
    return new Date(t).toISOString().slice(0, 19);
  };
  const nextDay = (day) => new Date(Date.parse(day + 'T00:00:00Z') + 86400e3).toISOString().slice(0, 10);
  const every = (sec) => !sec ? '' : sec % 86400 === 0 ? `co ${sec / 86400} d` : sec % 3600 === 0 ? `co ${sec / 3600} h`
    : sec >= 60 ? `co ${Math.round(sec / 60)} min` : `co ${sec} s`;

  // filtr źródeł: crony, timery użytkownika, timery systemowe, mózg, rutyna (zwinięte gęste)
  function category(e) {
    if (e.source === 'mozg') return 'mozg';
    if (e.recurring && e.recurring.collapsed) return 'rutyna';
    if (e.system) return 'system';
    return e.source; // cron | timer
  }
  // zdarzenia API -> zdarzenia EventCalendar; w miesiącu i liście rutyna zgrupowana w jedną pigułkę na dzień
  function toEcEvents(events, filters, { groupRoutine = false } = {}) {
    const out = [], groups = new Map();
    for (const e of events) {
      const cat = category(e);
      if (!filters[cat] || (e.system && !filters.system)) continue;
      const start = warsawWall(e.start);
      const failed = ['failed', 'expired', 'uncertain'].includes(e.state) || (e.detail && e.detail.last && e.detail.last.result && e.detail.last.result !== 'success');
      const waiting = e.state === 'waiting_capacity';
      const cls = ['ev', 'ev-' + (e.source === 'timer' && e.system ? 'sys' : e.source), cat === 'rutyna' ? 'ev-rutyna' : '', failed ? 'ev-failed' : '',
        waiting ? 'ev-waiting' : '', e.state === 'cancelled' ? 'ev-cancelled' : '', e.approx ? 'ev-approx' : ''].filter(Boolean);
      if (e.allDay) {
        const day = start.slice(0, 10);
        if (groupRoutine && cat === 'rutyna') {
          if (!groups.has(day)) groups.set(day, []);
          groups.get(day).push(e);
          continue;
        }
        out.push({ id: e.id, title: e.title, start: day, end: nextDay(day), allDay: true, classNames: cls, extendedProps: { src: e } });
      } else {
        out.push({ id: e.id, title: e.title, start, end: e.end ? warsawWall(e.end) : addMin(start, 30), classNames: cls, extendedProps: { src: e } });
      }
    }
    for (const [day, list] of groups) {
      out.push({ id: 'rutyna:' + day, title: `Rutyny · ${list.length}`, start: day, end: nextDay(day), allDay: true,
        classNames: ['ev', 'ev-rutyna', 'ev-group'], extendedProps: { group: list } });
    }
    return out;
  }
  const api = { warsawWall, warsawOffset, toEcEvents, category, every, TZ };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.CalUtil = api;

  // ---------- widok (tylko przeglądarka) ----------
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const DEF_FILTERS = { cron: true, timer: true, system: false, mozg: true, rutyna: true };
  const VIEWS = { day: 'timeGridDay', week: 'timeGridWeek', month: 'dayGridMonth', list: 'listWeek' };
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  let cal = null, data = null, loadedRange = '', fetchSeq = 0, timer = null, lib = null;
  let filters = { ...DEF_FILTERS, ...(store.get('ccp-cal-filters') || {}) };
  let view = store.get('ccp-cal-view') || (wide() ? 'week' : 'list');
  let current = null; // {start, end} - widoczny zakres (Date z EC)

  function loadLib() {
    if (lib) return lib;
    lib = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = '/vendor/event-calendar.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = '/vendor/event-calendar.js';
      s.onload = resolve;
      s.onerror = () => { lib = null; reject(new Error('Nie udało się wczytać biblioteki kalendarza (offline?)')); };
      document.head.appendChild(s);
    });
    return lib;
  }
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const MOZG_GLYPH = { pending: ['○', 'zaplanowane'], fired: ['✓', 'wykonane'], failed: ['!', 'błąd'], cancelled: ['✕', 'anulowane'],
    waiting_capacity: ['⏳', 'czeka'], creating_task: ['…', 'zakładam zadanie'], starting: ['…', 'uruchamiam agenta'],
    started: ['▶', 'agent wystartował'], uncertain: ['?', 'stan niepewny'], expired: ['⌛', 'wygasło'] };
  function statusGlyph(src) {
    if (!src) return null;
    if (src.source === 'mozg') return MOZG_GLYPH[src.state] || null;
    const last = src.detail && src.detail.last;
    if (last && last.result && last.result !== 'success') return ['!', 'ostatnio błąd'];
    return null;
  }
  function eventContent(info) {
    const p = info.event.extendedProps;
    const nodes = [];
    if (p.group) {
      nodes.push(el('span', 'ev-ico', '↻'), el('span', 'ev-title', info.event.title));
      return { domNodes: [wrap(nodes)] };
    }
    const src = p.src;
    if (!info.event.allDay && info.timeText) nodes.push(el('span', 'ev-time', info.timeText.split(/[–-]/)[0].trim()));
    if (src.recurring) nodes.push(el('span', 'ev-ico', '↻'));
    const t = src.recurring && src.recurring.collapsed ? `${src.title} · ${every(src.recurring.every_sec)}` : src.title;
    nodes.push(el('span', 'ev-title', t));
    if (src.source !== 'mozg') nodes.push(el('span', 'ev-lock', '🔒'));
    const g = statusGlyph(src);
    if (g) { const s = el('span', 'ev-st', g[0]); s.title = g[1]; nodes.push(s); }
    return { domNodes: [wrap(nodes)] };
  }
  function wrap(nodes) { const d = el('div', 'ev-in'); d.append(...nodes); return d; }

  function setWarn() {
    const msgs = [];
    const dev = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (dev && dev !== TZ) msgs.push(`Godziny w czasie polskim (${TZ}); urządzenie: ${dev}.`);
    if (data) {
      const s = data.sources || {};
      if (s.mozg && !s.mozg.available) msgs.push('Harmonogramy mózgu niedostępne: ' + (s.mozg.error || 'brak połączenia') + '.');
      if (s.mozg && s.mozg.paused) msgs.push('⏸ Pauza awaryjna: zaplanowane zadania nie startują (python -m mozgd.schedule pause off).');
      for (const [k, label] of [['cron', 'crontab'], ['timers_user', 'timery użytkownika'], ['timers_system', 'timery systemowe']]) {
        if (s[k] && s[k].error) msgs.push(`Błąd odczytu (${label}): ${s[k].error}`);
      }
      if (data.truncated) msgs.push('Za dużo zdarzeń w zakresie - część pominięto (limit 2000).');
    }
    $('#cal-warn').textContent = msgs.join(' ');
    $('#cal-warn').hidden = !msgs.length;
  }

  function render() {
    if (!cal || !data) return;
    const grouped = view === 'month' || view === 'list';
    cal.setOption('events', toEcEvents(data.events, filters, { groupRoutine: grouped }));
    const n = data.events.filter((e) => filters[category(e)]).length;
    $('#cal-meta').textContent = `${n} zdarzeń`;
    setWarn();
  }

  // zakres widoku + 1 dzień zapasu z obu stron (offset Warsaw), max 62 dni po stronie serwera
  function rangeOf(info) {
    const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return { from: new Date(day(info.start) - 86400e3).toISOString(), to: new Date(day(info.end) + 86400e3).toISOString() };
  }
  async function fetchRange(force = false) {
    if (!current) return;
    const r = rangeOf(current);
    const key = r.from + '|' + r.to;
    if (!force && key === loadedRange && data) return render();
    const seq = ++fetchSeq;
    $('#cal-meta').textContent = 'wczytuję…';
    try {
      const res = await fetch(`/api/calendar?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`, { headers: { 'X-CCP': '1' } });
      if (res.status === 401) { location.hash = '#/'; return; }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      if (seq !== fetchSeq) return;
      data = body; loadedRange = key;
      render();
    } catch (e) {
      if (seq !== fetchSeq) return;
      $('#cal-meta').textContent = '';
      $('#cal-warn').textContent = navigator.onLine === false ? 'Brak sieci - kalendarz wymaga połączenia z panelem.' : 'Nie udało się wczytać kalendarza: ' + e.message;
      $('#cal-warn').hidden = false;
    }
  }

  function syncControls() {
    for (const b of document.querySelectorAll('#cal-views button')) b.setAttribute('aria-pressed', String(b.dataset.v === view));
    for (const b of document.querySelectorAll('#cal-filters button')) b.setAttribute('aria-pressed', String(!!filters[b.dataset.f]));
  }

  function fmtWarsaw(iso, opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) {
    return new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, ...opts }).format(new Date(iso));
  }
  function fmtDevice(iso) {
    return new Intl.DateTimeFormat('pl-PL', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
  }

  const SRC_LABEL = { cron: 'Cron (crontab użytkownika)', timer: 'Timer systemd (--user)', sys: 'Timer systemowy', mozg: 'Harmonogram mózgu' };
  const MOZG_STATE = { pending: 'zaplanowane', fired: 'wykonane', failed: 'błąd', cancelled: 'anulowane',
    waiting_capacity: 'czeka', creating_task: 'zakładam zadanie', starting: 'uruchamiam agenta', started: 'agent wystartował',
    uncertain: 'stan niepewny - sprawdź', expired: 'wygasło (minął termin startu)' };
  const MOZG_WAIT = { capacity: 'wolnego miejsca (limit 3 agentów)', daily_limit: 'limitu dobowego (10 startów)', paused: 'końca pauzy awaryjnej',
    adapters: 'połączenia z Hubem/rotatorem', retry: 'Hubu (ponawiam)' };
  function row(dl, label, value, cls) {
    if (value == null || value === '') return;
    dl.append(el('dt', null, label));
    const dd = el('dd', cls, String(value));
    dl.append(dd);
  }
  function showDetail(src, group) {
    const body = $('#cal-detail');
    body.replaceChildren();
    if (group) {
      $('#cal-detail-title').textContent = `Rutyny (${group.length})`;
      const list = el('div', 'cal-group');
      for (const e of group) {
        const b = el('button', 'cal-group-row');
        b.type = 'button';
        b.append(el('span', 'ev-ico', '↻'), el('span', 'cal-group-name', e.title), el('span', 'muted small', `${every(e.recurring.every_sec)} · ${e.recurring.count}×`));
        b.addEventListener('click', () => showDetail(e));
        list.append(b);
      }
      body.append(list);
      if (!$('#dlg-cal').open) $('#dlg-cal').showModal();
      return;
    }
    $('#cal-detail-title').textContent = src.title;
    const d = src.detail || {};
    const dl = el('dl', 'cal-dl');
    row(dl, 'Źródło', SRC_LABEL[src.source === 'timer' && src.system ? 'sys' : src.source]);
    if (src.recurring && src.recurring.collapsed) {
      row(dl, 'Dzień', fmtWarsaw(src.start, { weekday: 'long', day: 'numeric', month: 'long' }));
      row(dl, 'Uruchomienia', src.recurring.monotonic ? `${every(src.recurring.every_sec)}; następne ${fmtWarsaw(src.start, { hour: '2-digit', minute: '2-digit' })}`
        : `${src.recurring.count}× (${every(src.recurring.every_sec)}), ${fmtWarsaw(src.start, { hour: '2-digit', minute: '2-digit' })}-${fmtWarsaw(src.end, { hour: '2-digit', minute: '2-digit' })}${src.recurring.estimated ? ', liczba szacowana' : ''}`);
    } else {
      row(dl, 'Kiedy', fmtWarsaw(src.start) + (src.approx ? ' (przybliżone)' : ''));
      const dev = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (dev !== TZ) row(dl, 'Czas urządzenia', fmtDevice(src.start));
    }
    if (src.recurring) row(dl, 'Reguła', src.recurring.expr, 'mono');
    if (src.source === 'cron') {
      row(dl, 'Polecenie', d.command, 'mono pre');
      row(dl, 'Wynik', d.status_note);
    }
    if (src.source === 'timer') {
      row(dl, 'Opis', d.description);
      row(dl, 'Jednostka', `${d.unit} → ${d.service}`, 'mono');
      if (src.recurring && src.recurring.monotonic) row(dl, 'Uwaga', 'Timer monotoniczny: znane jest tylko następne uruchomienie, bez prognozy dalszych.');
      if (d.randomized_delay_sec) row(dl, 'Losowe opóźnienie', every(d.randomized_delay_sec).replace('co ', 'do '));
      const last = d.last || {};
      if (last.at || last.result) {
        const ok = last.result === 'success';
        row(dl, 'Ostatnie uruchomienie', [last.at && fmtWarsaw(last.at), last.result && (ok ? 'sukces' : `błąd (${last.result}, kod ${last.status})`)].filter(Boolean).join(' · '), ok ? 'ok' : 'bad');
      } else row(dl, 'Ostatnie uruchomienie', 'brak danych');
    }
    if (src.source === 'mozg') {
      row(dl, 'Stan', MOZG_STATE[src.state] || src.state);
      row(dl, 'Zakładka', d.thread_title || d.thread_id);
      if (d.action === 'worker_task') {
        const p = d.params || {};
        if (d.wait_reason) row(dl, 'Czeka na', MOZG_WAIT[d.wait_reason] || d.wait_reason);
        row(dl, 'Projekt', p.project, 'mono');
        row(dl, 'Treść', p.body, 'pre');
        if (d.latest_start_at) row(dl, 'Start najpóźniej', fmtWarsaw(d.latest_start_at));
        row(dl, 'Zadanie w Hubie', d.task_id, 'mono');
        row(dl, 'Etykieta agenta', d.label, 'mono');
        row(dl, 'Źródło wpisu', d.source);
      } else row(dl, 'Akcja', d.action + (d.params ? ' ' + JSON.stringify(d.params) : ''), 'mono');
      if (d.created) row(dl, 'Utworzono', fmtWarsaw(d.created));
      if (d.fired_at) row(dl, d.action === 'worker_task' ? 'Agent wystartował' : 'Wykonano', fmtWarsaw(d.fired_at));
    }
    if (d.error) row(dl, 'Błąd', d.error, 'bad');
    body.append(dl);
    if (src.source !== 'mozg') body.append(el('p', 'muted small', '🔒 Tylko do odczytu. Crontab i timery zmieniasz w terminalu, nie z panelu.'));
    if (src.source === 'cron' && d.command && navigator.clipboard) {
      const b = el('button', 'btn wide', 'Kopiuj polecenie');
      b.type = 'button';
      b.addEventListener('click', () => ClipHistory.store.copy(d.command).then(() => { b.textContent = 'Skopiowane ✓'; }, () => {}));
      body.append(b);
    }
    if (!$('#dlg-cal').open) $('#dlg-cal').showModal();
  }

  // mini-kalendarz (desktop): miesiąc z widocznym zakresem, klik = przejście do dnia
  let miniMonth = null;
  function renderMini() {
    const box = $('#cal-mini');
    if (!wide() || !current) { box.hidden = true; return; }
    box.hidden = false;
    const today = warsawWall(new Date().toISOString()).slice(0, 10);
    const mid = new Date((current.start.getTime() + current.end.getTime()) / 2);
    const base = miniMonth || new Date(mid.getFullYear(), mid.getMonth(), 1);
    miniMonth = base;
    const head = el('div', 'mini-head');
    const prev = el('button', 'icon-btn', '‹'), next = el('button', 'icon-btn', '›');
    prev.addEventListener('click', () => { miniMonth = new Date(base.getFullYear(), base.getMonth() - 1, 1); renderMini(); });
    next.addEventListener('click', () => { miniMonth = new Date(base.getFullYear(), base.getMonth() + 1, 1); renderMini(); });
    head.append(prev, el('b', null, new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric' }).format(base)), next);
    const grid = el('div', 'mini-grid');
    for (const d of ['pn', 'wt', 'śr', 'cz', 'pt', 'sb', 'nd']) grid.append(el('span', 'mini-dow', d));
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    const pad = (n) => String(n).padStart(2, '0');
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const b = el('button', 'mini-day', String(d.getDate()));
      b.type = 'button';
      if (d.getMonth() !== base.getMonth()) b.classList.add('other');
      if (key === today) b.classList.add('today');
      if (d >= current.start && d < current.end) b.classList.add('in');
      b.addEventListener('click', () => { cal.setOption('date', key); });
      grid.append(b);
    }
    box.replaceChildren(head, grid);
  }

  async function open() {
    syncControls();
    try { await loadLib(); } catch (e) { $('#cal-warn').textContent = e.message; $('#cal-warn').hidden = false; return; }
    if (!cal) {
      cal = root.EventCalendar.create($('#cal'), {
        view: VIEWS[view], locale: 'pl', firstDay: 1, timeZone: warsawOffset(), nowIndicator: true,
        headerToolbar: { start: '', center: '', end: '' }, height: '100%',
        scrollTime: `${String(Math.max(0, +warsawWall(new Date().toISOString()).slice(11, 13) - 2)).padStart(2, '0')}:00:00`,
        allDaySlot: true, allDayContent: 'rutyna', dayMaxEvents: true, slotDuration: '01:00:00', slotHeight: 44,
        eventTimeFormat: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
        slotLabelFormat: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
        dayHeaderFormat: wide() ? { weekday: 'short', day: 'numeric', month: 'numeric' } : { weekday: 'narrow', day: 'numeric' },
        views: { dayGridMonth: { dayHeaderFormat: { weekday: wide() ? 'long' : 'narrow' } },
          timeGridDay: { dayHeaderFormat: { weekday: 'long', day: 'numeric', month: 'long' } } },
        listDayFormat: { weekday: 'long', day: 'numeric', month: 'long' }, listDaySideFormat: false,
        noEventsContent: 'Brak zdarzeń w tym zakresie',
        eventContent, events: [],
        eventClick: (info) => showDetail(info.event.extendedProps.src, info.event.extendedProps.group),
        datesSet: (info) => {
          current = { start: info.start, end: info.end };
          $('#cal-title').textContent = info.view.title;
          miniMonth = null; renderMini();
          fetchRange();
        },
      });
    } else {
      cal.setOption('timeZone', warsawOffset());
      fetchRange(true);
    }
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) fetchRange(true); }, 5 * 60e3);
  }
  function close() { clearInterval(timer); timer = null; if ($('#dlg-cal').open) $('#dlg-cal').close(); }

  function bind() {
    $('#cal-today').addEventListener('click', () => cal && cal.setOption('date', warsawWall(new Date().toISOString()).slice(0, 10)));
    $('#cal-prev').addEventListener('click', () => cal && cal.prev());
    $('#cal-next').addEventListener('click', () => cal && cal.next());
    $('#cal-refresh').addEventListener('click', () => fetchRange(true));
    for (const b of document.querySelectorAll('#cal-views button')) b.addEventListener('click', () => {
      view = b.dataset.v; store.set('ccp-cal-view', view); syncControls();
      if (cal) { cal.setOption('view', VIEWS[view]); render(); }
    });
    for (const b of document.querySelectorAll('#cal-filters button')) b.addEventListener('click', () => {
      filters[b.dataset.f] = !filters[b.dataset.f]; store.set('ccp-cal-filters', filters); syncControls(); render();
    });
    $('#cal-detail-close').addEventListener('click', () => $('#dlg-cal').close());
    $('#dlg-cal').addEventListener('click', (e) => { if (e.target === $('#dlg-cal')) $('#dlg-cal').close(); });
  }
  root.Kalendarz = { open, close, bind };
})(typeof window === 'undefined' ? globalThis : window);
