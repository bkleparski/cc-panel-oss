'use strict';
// Kalendarz (E1, tylko odczyt): crontab użytkownika, timery systemd (--user i systemowe), harmonogramy mozgd.
// Nic tu nie zmienia crontaba, timerów ani harmonogramów. Czasy w API: ISO UTC; strefa crona/timerów: Europe/Warsaw.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const TZ = 'Europe/Warsaw';
const MAX_RANGE_MS = 62 * 86400e3;
const MAX_EVENTS = 2000;
const DENSE_PER_DAY = 24; // co godzinę lub częściej = rutyna zwinięta w jeden pasek dziennie

// ---------- strefa ----------
const wallFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
// czas ścienny Warsaw jako "UTC" (ms) - do porównań i arytmetyki dat
function wallOf(ms) {
  const p = Object.fromEntries(wallFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
// wszystkie chwile UTC o danym czasie ściennym: [] w luce wiosennej, 2 w powtórzonej godzinie jesienią
function wallToUtc(wall) {
  const out = new Set();
  for (const probe of [wall - 3 * 3600e3, wall + 3 * 3600e3]) {
    const t = wall - (wallOf(probe) - probe);
    if (wallOf(t) === wall) out.add(t);
  }
  return [...out].sort((a, b) => a - b);
}
const dayKey = (ms) => new Date(wallOf(ms)).toISOString().slice(0, 10);

// ---------- cron (Debian/Vixie, 5 pól) ----------
const NAMES = { month: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  dow: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] };
const FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['dom', 1, 31], ['month', 1, 12], ['dow', 0, 7]];
const MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };

function parseField(text, [name, lo, hi]) {
  const set = new Set();
  const num = (s) => {
    const i = (NAMES[name] || []).indexOf(s.toLowerCase());
    const n = i >= 0 ? i + (name === 'month' ? 1 : 0) : /^\d+$/.test(s) ? +s : NaN;
    if (!(n >= lo && n <= hi)) throw new Error(`zła wartość ${name}: ${s}`);
    return n;
  };
  for (const part of text.split(',')) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) throw new Error(`zła składnia ${name}: ${part}`);
    const step = m[2] ? +m[2] : 1;
    if (!(step >= 1)) throw new Error(`zły krok ${name}`);
    let a, b;
    if (m[1] === '*') [a, b] = [lo, hi];
    else if (m[1].includes('-')) [a, b] = m[1].split('-').map(num);
    else { a = num(m[1]); b = m[2] ? hi : a; }
    if (a > b) throw new Error(`zły zakres ${name}: ${part}`);
    for (let v = a; v <= b; v += step) set.add(name === 'dow' && v === 7 ? 0 : v);
  }
  return set;
}

function parseCronExpr(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('wyrażenie cron musi mieć 5 pól');
  const [minute, hour, dom, month, dow] = f.map((t, i) => parseField(t, FIELDS[i]));
  return { minute, hour, dom, month, dow,
    domStar: f[2].startsWith('*'), dowStar: f[4].startsWith('*'),
    // Debian cron: zadania z "*" w minucie lub godzinie idą według czasu ściennego (wildcard), reszta to "stałe godziny"
    wildcard: f[0].startsWith('*') || f[1].startsWith('*') };
}

// Linie crontaba: komentarze, zmienne, makra, @reboot. Zwraca wpisy z wyrażeniem albo błędem (nie wywraca kalendarza).
function parseCrontab(text) {
  const entries = [];
  for (const [i, raw] of String(text || '').split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;
    let expr, command, reboot = false;
    const macro = line.match(/^(@\w+)\s+(.*)$/);
    if (macro) {
      if (macro[1] === '@reboot') { reboot = true; expr = '@reboot'; command = macro[2]; }
      else if (MACROS[macro[1]]) { expr = MACROS[macro[1]]; command = macro[2]; }
      else { entries.push({ line: i + 1, raw: line, error: `nieznane makro ${macro[1]}` }); continue; }
    } else {
      const f = line.split(/\s+/);
      expr = f.slice(0, 5).join(' ');
      command = line.replace(/^(\S+\s+){5}/, '');
    }
    const entry = { line: i + 1, expr: macro ? macro[1] : expr, command: command.slice(0, 500), reboot, title: cronTitle(command) };
    if (!reboot) {
      try { entry.spec = parseCronExpr(expr); } catch (e) { entry.error = e.message; }
    }
    entries.push(entry);
  }
  return entries;
}

// nazwa skryptu: pierwszy token polecenia bez ścieżki (pomija "cd x &&", przypisania zmiennych i nice/flock/timeout)
function cronTitle(command) {
  const segs = command.split(/&&|;|\|\|/).map((s) => s.trim()).filter((s) => s && !/^cd\s/.test(s));
  const toks = (segs[0] || command).split(/\s+/).filter((t) => !/^[A-Za-z_]\w*=/.test(t) && !/^(nice|ionice|flock|timeout|nohup|sudo|-\S*|\d+)$/.test(t));
  return (toks[0] || command).replace(/^.*\//, '').replace(/^["']|["']$/g, '').slice(0, 80) || 'cron';
}

// Wystąpienia wpisu w [from, to) (ms UTC) z regułami DST Debian cron (man 8 cron):
// stałe godziny z luki wiosennej odpalają zaraz po zmianie (oznaczone approx), z powtórzonej godziny jesienią raz;
// wildcardy według czasu ściennego (wiosną nic nie nadrabiają, jesienią powtórzona godzina przebiega normalnie).
function cronOccurrences(spec, from, to, cap = 20000) {
  const out = [];
  const startWall = wallOf(from), lastDay = wallOf(to);
  let day = startWall - (startWall % 86400e3); // północ (czas ścienny) dnia, w którym zaczyna się zakres
  const hours = [...spec.hour].sort((a, b) => a - b), minutes = [...spec.minute].sort((a, b) => a - b);
  for (; day <= lastDay && out.length < cap; day += 86400e3) {
    const d = new Date(day);
    if (!spec.month.has(d.getUTCMonth() + 1)) continue;
    const domOk = spec.dom.has(d.getUTCDate()), dowOk = spec.dow.has(d.getUTCDay());
    if (!(spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk)) continue;
    for (const h of hours) for (const m of minutes) {
      const wall = day + h * 3600e3 + m * 60e3;
      const utc = wallToUtc(wall);
      let picks = utc.map((t) => ({ t }));
      if (!utc.length) {
        if (spec.wildcard) continue;
        // luka: najbliższa chwila po zmianie czasu (pierwsza istniejąca minuta po wall)
        let w = wall; while (!wallToUtc(w).length && w - wall < 3 * 3600e3) w += 60e3;
        picks = [{ t: wallToUtc(w)[0], approx: true }];
      } else if (utc.length === 2 && !spec.wildcard) picks = [picks[0]];
      for (const p of picks) if (p.t >= from && p.t < to) out.push(p);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- pomocnicze ----------
// cc-panel działa jako usługa systemowa (User=user) bez sesji logowania: brak XDG_RUNTIME_DIR, więc
// `systemctl --user` kończy się "Failed to connect to bus: No medium found". Menedżer użytkownika żyje
// (linger), jego bus jest w /run/user/<uid>/bus - uzupełniamy zmienne tylko, gdy ich nie ma.
function cmdEnv(base = process.env, uid = process.getuid?.(), exists = fs.existsSync) {
  const env = { ...base, LC_ALL: 'C', SYSTEMD_COLORS: '0' };
  const dir = env.XDG_RUNTIME_DIR || (uid != null && exists(`/run/user/${uid}`) ? `/run/user/${uid}` : null);
  if (dir) {
    env.XDG_RUNTIME_DIR = dir;
    if (!env.DBUS_SESSION_BUS_ADDRESS && exists(`${dir}/bus`)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${dir}/bus`;
  }
  return env;
}

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 << 20, env: cmdEnv() },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const iso = (ms) => new Date(ms).toISOString();
function median(arr) { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; }

// Gęste wystąpienia -> jeden pasek dziennie (gęstość liczona w żądanym zakresie, nie z jednej przerwy)
function collapse(times, makeEvent) {
  const byDay = new Map();
  for (const o of times) { const k = dayKey(o.t); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(o); }
  const maxPerDay = Math.max(0, ...[...byDay.values()].map((l) => l.length));
  if (maxPerDay < DENSE_PER_DAY) return { dense: false, events: times.map((o) => makeEvent(o, null)) };
  const gaps = []; for (let i = 1; i < times.length; i++) gaps.push(times[i].t - times[i - 1].t);
  const every = Math.round(median(gaps) / 1000);
  return { dense: true, every, events: [...byDay.entries()].map(([day, list]) => makeEvent(list[0], { day, count: list.length, first: list[0].t, last: list[list.length - 1].t, every })) };
}

// "1min", "1h 30min", "2d", "500ms" -> sekundy
function parseSpan(s) {
  let sec = 0;
  for (const [, n, u] of String(s).matchAll(/([\d.]+)\s*(us|ms|s|sec|min|m|h|d|w|month|y)\b/g)) {
    sec += +n * ({ us: 1e-6, ms: 1e-3, s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400, w: 604800, month: 2629800, y: 31557600 }[u]);
  }
  return sec;
}
const human = (sec) => sec >= 86400 && sec % 86400 === 0 ? `co ${sec / 86400} d` : sec >= 3600 && sec % 3600 === 0 ? `co ${sec / 3600} h`
  : sec >= 60 ? `co ${Math.round(sec / 60)} min` : `co ${sec} s`;
// "Sat 2026-10-03 21:38:25 CEST" -> ms (strefa Warsaw: CEST/CET); pusty/"n/a" -> null
function parseSystemdTime(s) {
  const m = String(s || '').match(/(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?: (\S+))?/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7] === 'UTC') return wall;
  const c = wallToUtc(wall);
  return c.length ? c[m[7] === 'CET' && c.length === 2 ? 1 : 0] : null;
}

// ---------- źródło: crontab ----------
async function cronEvents(from, to, readCrontab) {
  const res = await readCrontab();
  if (!res.ok && !/no crontab/i.test(res.stderr)) return { events: [], error: 'crontab -l: ' + (res.stderr.trim() || 'błąd') };
  const events = [], info = [];
  for (const e of parseCrontab(res.ok ? res.stdout : '')) {
    const id = 'cron:' + hash(e.expr + '\n' + e.command);
    const detail = { command: e.command, expr: e.expr, line: e.line, last_result: null, status_note: 'brak danych o wyniku (cron nie zapisuje kodu wyjścia)' };
    if (e.error) { info.push({ id, title: e.title, error: e.error, line: e.line }); continue; }
    if (e.reboot) { info.push({ id, title: e.title, note: 'przy starcie systemu (@reboot)', detail }); continue; }
    const occ = cronOccurrences(e.spec, from, to);
    const c = collapse(occ, (o, agg) => agg
      ? { id: `${id}:${agg.day}`, source: 'cron', title: e.title, start: iso(agg.first), end: iso(agg.last), allDay: true, kind: 'forecast',
        recurring: { expr: e.expr, every_sec: agg.every, collapsed: true, count: agg.count }, state: null, editable: false, detail }
      : { id: `${id}:${o.t / 1000}`, source: 'cron', title: e.title, start: iso(o.t), end: null, kind: 'forecast',
        recurring: { expr: e.expr, every_sec: null, collapsed: false }, approx: !!o.approx, state: null, editable: false, detail });
    events.push(...c.events);
  }
  return { events, info };
}

// ---------- źródło: timery systemd ----------
function parseShow(text) {
  const units = [];
  let cur = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) { if (Object.keys(cur).length) units.push(cur); cur = {}; continue; }
    const i = line.indexOf('=');
    const k = line.slice(0, i), v = line.slice(i + 1);
    if (k === 'TimersMonotonic' || k === 'TimersCalendar') (cur[k] = cur[k] || []).push(v);
    else cur[k] = v;
  }
  if (Object.keys(cur).length) units.push(cur);
  return units;
}

async function analyzeCalendar(expr, from, to, runCmd) {
  // najpierw 2 doby, żeby ocenić gęstość; potem tyle iteracji, ile potrzeba na zakres (max MAX_EVENTS)
  const once = async (n) => {
    const r = await runCmd('systemd-analyze', ['calendar', `--iterations=${n}`, `--base-time=@${Math.floor(from / 1000) - 1}`, expr]);
    if (!r.ok) throw new Error('systemd-analyze: ' + (r.stderr.trim().split('\n')[0] || 'błąd'));
    return [...r.stdout.matchAll(/\(in UTC\): \S+ (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC/g)].map((m) => Date.parse(m[1].replace(' ', 'T') + 'Z'));
  };
  let ts = await once(60);
  if (ts.length === 60 && ts[59] < to) {
    // gęstość z pierwszej próbki -> liczba iteracji na cały zakres (max MAX_EVENTS + 1, nadmiar = obcięcie)
    const rate = 59 / Math.max(1, ts[59] - ts[0]);
    ts = await once(Math.min(MAX_EVENTS + 1, Math.ceil(rate * (to - from)) + 5));
  }
  return { times: ts.filter((t) => t >= from && t < to).map((t) => ({ t })), truncated: ts.length > MAX_EVENTS };
}

async function timerEvents(scope, from, to, runCmd, cache) {
  const base = scope === 'user' ? ['--user'] : [];
  const list = await runCmd('systemctl', [...base, 'list-timers', '--all', '-o', 'json']);
  if (!list.ok) return { events: [], error: `systemctl ${scope}: ` + (list.stderr.trim() || 'błąd') };
  let timers;
  try { timers = JSON.parse(list.stdout); } catch { return { events: [], error: `systemctl ${scope}: zła odpowiedź` }; }
  if (!timers.length) return { events: [] };
  const show = await runCmd('systemctl', [...base, 'show', ...timers.map((t) => t.unit),
    '-p', 'Id,Description,TimersMonotonic,TimersCalendar,Persistent,AccuracyUSec,RandomizedDelayUSec,Unit,ActiveState']);
  const services = [...new Set(timers.map((t) => t.activates).filter(Boolean))];
  const svc = await runCmd('systemctl', [...base, 'show', ...services,
    '-p', 'Id,Description,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ActiveState']);
  const tInfo = Object.fromEntries(parseShow(show.stdout).map((u) => [u.Id, u]));
  const sInfo = Object.fromEntries(parseShow(svc.stdout).map((u) => [u.Id, u]));
  const events = [], inactive = [];
  for (const t of timers) {
    const ti = tInfo[t.unit] || {}, si = sInfo[t.activates] || {};
    const id = `timer:${scope}:${t.unit}`;
    const random = parseSpan(ti.RandomizedDelayUSec || '0');
    const last = {
      at: t.last ? iso(Math.floor(t.last / 1000)) : null,
      result: si.Result || null, status: si.ExecMainStatus != null ? +si.ExecMainStatus : null,
      started: parseSystemdTime(si.ExecMainStartTimestamp) && iso(parseSystemdTime(si.ExecMainStartTimestamp)),
      active: si.ActiveState || null,
    };
    const detail = { unit: t.unit, service: t.activates, scope, description: ti.Description || '', service_description: si.Description || '',
      persistent: ti.Persistent === 'yes', accuracy_sec: parseSpan(ti.AccuracyUSec || '0'), randomized_delay_sec: random,
      monotonic: (ti.TimersMonotonic || []).map((s) => s.replace(/^\{ | ;.*$/g, '')),
      calendar: (ti.TimersCalendar || []).map((s) => (s.match(/OnCalendar=([^;]+?) ;/) || [])[1]).filter(Boolean),
      next: t.next ? iso(Math.floor(t.next / 1000)) : null, last };
    const title = t.unit.replace(/\.timer$/, '');
    // nieaktywny timer (np. warunek nie spełniony, brak "next") nic nie odpali: bez prognozy, tylko informacja
    if (ti.ActiveState !== 'active' || !t.next) { inactive.push({ unit: t.unit, scope, state: ti.ActiveState || null }); continue; }
    if (detail.calendar.length) {
      // kalendarzowe: wystąpienia nominalne z systemd-analyze (DST liczy systemd); RandomizedDelay = przybliżone
      let times = [], truncated = false, err = null;
      for (const expr of detail.calendar) {
        const key = `${expr}|${from}|${to}`;
        try {
          if (!cache.has(key)) cache.set(key, { at: Date.now(), v: await analyzeCalendar(expr, from, to, runCmd) });
          const r = cache.get(key).v; times.push(...r.times); truncated ||= r.truncated;
        } catch (e) { err = e.message; }
      }
      times = times.sort((a, b) => a.t - b.t).filter((o, i, a) => !i || o.t !== a[i - 1].t);
      if (err) detail.error = err;
      const c = collapse(times, (o, agg) => agg
        ? { id: `${id}:${agg.day}`, source: 'timer', title, start: iso(agg.first), end: iso(agg.last), allDay: true, kind: 'forecast',
          recurring: { expr: detail.calendar.join('; '), every_sec: agg.every, collapsed: true, count: agg.count }, state: null, editable: false, detail }
        : { id: `${id}:${o.t / 1000}`, source: 'timer', title, start: iso(o.t), end: null, kind: 'forecast', approx: random > 0,
          recurring: { expr: detail.calendar.join('; '), every_sec: null, collapsed: false }, state: null, editable: false, detail });
      if (truncated && c.dense && c.events.length) {
        // limit iteracji systemd-analyze nie sięgnął końca zakresu: reguła kalendarzowa jest deterministyczna,
        // więc kolejne dni dostają pasek z liczbą szacowaną ze średniej (estimated) zamiast znikać
        const full = c.events.slice(0, -1), lastDay = c.events[c.events.length - 1];
        const perDay = Math.round(full.reduce((n, e) => n + e.recurring.count, 0) / Math.max(1, full.length)) || lastDay.recurring.count;
        const dayStart = (ms) => { const w = wallOf(ms); return wallToUtc(w - (w % 86400e3))[0] ?? ms; };
        for (let d = dayStart(Date.parse(lastDay.start)) + 30 * 3600e3; d < to; d += 86400e3) {
          const s = dayStart(d), k = dayKey(s);
          const end = Math.min(to - 1, wallToUtc(wallOf(s) + 86400e3 - 60e3)[0] ?? s + 86340e3);
          events.push({ ...lastDay, id: `${id}:${k}`, start: iso(s), end: iso(end), recurring: { ...lastDay.recurring, count: perDay, estimated: true } });
        }
      }
      events.push(...c.events);
    } else {
      // monotoniczne: tylko znane następne wystąpienie + opis reguły, bez fikcyjnych przyszłych
      const next = Math.floor(t.next / 1000);
      const every = Math.max(0, ...detail.monotonic.filter((s) => /OnUnit(Active|Inactive)USec/.test(s)).map((s) => parseSpan(s.split('=')[1])));
      if (next >= from && next < to) events.push({ id: `${id}:${next / 1000}`, source: 'timer', title, start: iso(next), end: null,
        allDay: every > 0 && every < 3600, kind: 'forecast', recurring: { expr: detail.monotonic.join('; '), every_sec: every || null, collapsed: every > 0 && every < 3600, monotonic: true },
        state: null, editable: false, detail });
    }
  }
  return { events, inactive };
}

// ---------- źródło: mozgd ----------
const MOZG_TITLES = { usage_report: (p) => `Raport zużycia (${p.days} d)`, worker_task: (p) => `🤖 ${p.title || 'zadanie'}` };
async function mozgEvents(from, to, mozg) {
  let res;
  try { res = await mozg.call('calendar_list', { from: from / 1000, to: to / 1000 }); }
  catch (e) {
    const old = /unknown method|register first/.test(e.message);
    return { events: [], error: old ? 'mozgd bez metody calendar_list (wymaga restartu mozgd)' : e.message, unavailable: true };
  }
  return {
    truncated: !!res.truncated,
    events: (res.items || []).map((s) => ({
      id: `mozg:${s.id}`, source: 'mozg', title: (MOZG_TITLES[s.action] || (() => s.action))(s.params || {}), start: iso(s.run_at * 1000), end: null,
      kind: 'scheduled', recurring: null, state: s.state, editable: false,
      detail: { schedule_id: s.id, action: s.action, params: s.params, thread_id: s.thread_id, thread_title: s.thread_title,
        created: s.created && iso(s.created * 1000), fired_at: s.fired_at && iso(s.fired_at * 1000),
        // worker_task (E2): termin ważności, zadanie w Hubie, powód czekania, błąd; tylko odczyt
        latest_start_at: s.latest_start_at ? iso(s.latest_start_at * 1000) : null, task_id: s.task_id || null, label: s.label || null,
        wait_reason: s.wait_reason || null, error: s.error || null, revision: s.revision ?? null, source: s.source || null },
    })),
    paused: !!res.paused,
  };
}

// ---------- całość ----------
function createCalendar({ mozg, runCmd = run, readCrontab = () => run('crontab', ['-l']), now = () => Date.now() } = {}) {
  const cache = new Map();
  async function list(fromIn, toIn) {
    const from = Date.parse(fromIn), to = Date.parse(toIn);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { const e = new Error('Podaj from i to (ISO), from < to'); e.code = 400; throw e; }
    if (to - from > MAX_RANGE_MS) { const e = new Error('Zakres maksymalnie 62 dni'); e.code = 400; throw e; }
    for (const [k, v] of cache) if (now() - v.at > 300e3) cache.delete(k);
    const [cron, userT, sysT, brain] = await Promise.all([
      cronEvents(from, to, readCrontab), timerEvents('user', from, to, runCmd, cache), timerEvents('system', from, to, runCmd, cache),
      mozg ? mozgEvents(from, to, mozg) : { events: [], error: 'brak połączenia z mozgd', unavailable: true }]);
    for (const e of sysT.events) e.system = true;
    // przy obcięciu pierwszeństwo: mózg, timery użytkownika, crony, timery systemowe
    let events = [...brain.events, ...userT.events, ...cron.events, ...sysT.events];
    const truncated = events.length > MAX_EVENTS || !!brain.truncated;
    events = events.slice(0, MAX_EVENTS).sort((a, b) => a.start.localeCompare(b.start));
    const collapsed = events.filter((e) => e.recurring?.collapsed).length;
    return {
      from: iso(from), to: iso(to), tz: TZ, generated: iso(now()), truncated, collapsed, events,
      sources: {
        cron: { error: cron.error || null, other: cron.info || [] },
        timers_user: { error: userT.error || null, inactive: userT.inactive || [] },
        timers_system: { error: sysT.error || null, inactive: sysT.inactive || [] },
        mozg: { error: brain.error || null, available: !brain.unavailable, paused: !!brain.paused },
      },
    };
  }
  return { list };
}

module.exports = { createCalendar, cmdEnv, parseCrontab, parseCronExpr, cronOccurrences, wallToUtc, wallOf, collapse, parseSpan, parseSystemdTime, cronTitle, human, TZ };
