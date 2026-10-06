'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createCalendar, cmdEnv, parseCrontab, parseCronExpr, cronOccurrences, wallToUtc, collapse, parseSpan, parseSystemdTime, cronTitle } = require('../lib/calendar');

const H = 3600e3, D = 86400e3;
const occ = (expr, from, to) => cronOccurrences(parseCronExpr(expr), Date.parse(from), Date.parse(to));
const isoList = (list) => list.map((o) => new Date(o.t).toISOString().slice(0, 16) + (o.approx ? '~' : ''));

test('wallToUtc: luka wiosenna, powtórzona godzina jesienią, zwykły dzień', () => {
  assert.deepEqual(wallToUtc(Date.UTC(2027, 2, 28, 2, 30)), []);
  assert.deepEqual(wallToUtc(Date.UTC(2026, 9, 25, 2, 30)).map((t) => new Date(t).toISOString()), ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
  assert.deepEqual(wallToUtc(Date.UTC(2026, 9, 26, 10, 0)), [Date.parse('2026-10-26T09:00:00Z')]);
});

test('cron "30 2 * * *": jesienią raz (pierwsze wystąpienie), wiosną zaraz po zmianie czasu', () => {
  assert.deepEqual(isoList(occ('30 2 * * *', '2026-10-24T00:00:00Z', '2026-10-26T12:00:00Z')),
    ['2026-10-24T00:30', '2026-10-25T00:30', '2026-10-26T01:30']);
  // 28.03.2027 02:30 nie istnieje -> Debian cron odpala tuż po skoku (03:00 CEST = 01:00 UTC), oznaczone jako przybliżone
  assert.deepEqual(isoList(occ('30 2 * * *', '2027-03-27T00:00:00Z', '2027-03-29T12:00:00Z')),
    ['2027-03-27T01:30', '2027-03-28T01:00~', '2027-03-29T00:30']);
});

test('cron wildcard "*/10" i "5-59/10": jesienią 25 h, wiosną 23 h', () => {
  const day = (expr, d) => occ(expr, d + 'T00:00:00+02:00', d === '2026-10-25' ? '2026-10-26T00:00:00+01:00' : d + 'T23:59:59+02:00');
  assert.equal(day('*/10 * * * *', '2026-10-25').length, 150);
  assert.equal(day('5-59/10 * * * *', '2026-10-25').length, 150);
  const spring = occ('*/10 * * * *', '2027-03-28T00:00:00+01:00', '2027-03-29T00:00:00+02:00');
  assert.equal(spring.length, 138);
  assert.ok(spring.every((o) => !o.approx));
  assert.deepEqual(isoList(occ('5-59/10 * * * *', '2026-10-03T10:00:00Z', '2026-10-03T10:30:00Z')), ['2026-10-03T10:05', '2026-10-03T10:15', '2026-10-03T10:25']);
});

test('cron: dzień miesiąca LUB dzień tygodnia, nazwy, zakres miesięcy', () => {
  // 13. dnia albo w piątek (Vixie: oba pola ograniczone = OR)
  const days = occ('0 12 13 * 5', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z').map((o) => new Date(o.t).getUTCDate());
  assert.deepEqual(days, [6, 13, 20, 27]);
  const or = occ('0 12 10 * 5', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z').map((o) => new Date(o.t).getUTCDate());
  assert.deepEqual(or, [6, 10, 13, 20, 27]);
  // tylko dzień tygodnia (dom = *) -> AND
  assert.equal(occ('0 9 * * mon-fri', '2026-10-05T00:00:00Z', '2026-10-12T00:00:00Z').length, 5);
  assert.equal(occ('0 9 * jan-mar 7', '2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z').length, 0);
  assert.equal(occ('0 9 * * 7', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z').length, 4); // 7 = niedziela
});

test('parseCrontab: komentarze, zmienne, makra, @reboot, błędne linie', () => {
  const e = parseCrontab([
    '# komentarz', 'MAILTO=""', 'SHELL=/bin/bash', '',
    '*/10 * * * * $HOME/bin/a.sh >> $HOME/a.log 2>&1',
    '@daily cd /x && ./backup.sh',
    '@reboot /usr/bin/foo --start',
    '61 * * * * /bin/zle',
    '@co5 /bin/x',
  ].join('\n'));
  assert.deepEqual(e.map((x) => [x.expr, x.title, !!x.error, x.reboot]), [
    ['*/10 * * * *', 'a.sh', false, false], ['@daily', 'backup.sh', false, false],
    ['@reboot', 'foo', false, true], ['61 * * * *', 'zle', true, false], [undefined, undefined, true, undefined]]);
  assert.equal(e[0].spec.wildcard, true);
  assert.equal(parseCronExpr('0 0 * * *').wildcard, false);
  assert.throws(() => parseCronExpr('* * * *'));
  assert.throws(() => parseCronExpr('*/0 * * * *'));
  assert.equal(cronTitle('FOO=1 nice /opt/run.py --x'), 'run.py');
  assert.equal(cronTitle('cd /x && ./b.sh'), 'b.sh');
});

test('collapse: co godzinę i częściej = jeden pasek dziennie, rzadziej = pojedyncze', () => {
  const hourly = occ('0 * * * *', '2026-10-05T00:00:00+02:00', '2026-10-07T00:00:00+02:00');
  const c = collapse(hourly, (o, agg) => agg || o);
  assert.equal(c.dense, true);
  assert.equal(c.every, 3600);
  assert.deepEqual(c.events.map((x) => [x.day, x.count]), [['2026-10-05', 24], ['2026-10-06', 24]]);
  const rare = occ('0 */2 * * *', '2026-10-05T00:00:00+02:00', '2026-10-07T00:00:00+02:00');
  assert.equal(collapse(rare, (o) => o).dense, false);
});

test('parseSpan i parseSystemdTime', () => {
  assert.equal(parseSpan('1min'), 60);
  assert.equal(parseSpan('1h 30min'), 5400);
  assert.equal(parseSpan('12h'), 43200);
  assert.equal(parseSpan('0'), 0);
  assert.equal(parseSystemdTime('Sat 2026-10-03 21:38:25 CEST'), Date.parse('2026-10-03T19:38:25Z'));
  assert.equal(parseSystemdTime('Sun 2026-10-25 02:30:00 CET'), Date.parse('2026-10-25T01:30:00Z'));
  assert.equal(parseSystemdTime(''), null);
});

// atrapy systemctl / systemd-analyze / crontab
function fakeRun(calls) {
  const usec = (iso) => Date.parse(iso) * 1000;
  return async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const user = args[0] === '--user';
    if (cmd === 'systemctl' && args.includes('list-timers')) {
      return { ok: true, stdout: JSON.stringify(user
        ? [{ unit: 'rot.timer', activates: 'rot.service', next: usec('2026-10-05T08:00:30Z'), last: usec('2026-10-05T07:59:30Z') }]
        : [{ unit: 'daily.timer', activates: 'daily.service', next: usec('2026-10-05T22:00:00Z'), last: 0 },
          { unit: 'off.timer', activates: 'off.service', next: null, last: 0 }]), stderr: '' };
    }
    if (cmd === 'systemctl' && args.includes('show') && args.some((a) => a.endsWith('.timer'))) {
      return { ok: true, stdout: user
        ? 'Id=rot.timer\nDescription=Rotator\nTimersMonotonic={ OnUnitActiveUSec=1min ; next_elapse=1h }\nTimersMonotonic={ OnBootUSec=2min ; next_elapse=2min }\nPersistent=no\nAccuracyUSec=10s\nRandomizedDelayUSec=0\nUnit=rot.service\nActiveState=active\n'
        : 'Id=daily.timer\nTimersCalendar={ OnCalendar=*-*-* 00:00:00 ; next_elapse=x }\nRandomizedDelayUSec=0\nActiveState=active\n\nId=off.timer\nTimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=(null) }\nActiveState=inactive\n', stderr: '' };
    }
    if (cmd === 'systemctl' && args.includes('show')) {
      return { ok: true, stdout: 'Id=rot.service\nResult=exit-code\nExecMainStatus=2\nExecMainStartTimestamp=Mon 2026-10-05 09:59:30 CEST\nActiveState=failed\n\nId=daily.service\nResult=success\nExecMainStatus=0\n', stderr: '' };
    }
    if (cmd === 'systemd-analyze') {
      const base = +args.find((a) => a.startsWith('--base-time=@')).slice(13) + 1;
      const n = +args.find((a) => a.startsWith('--iterations=')).slice(13);
      const lines = [];
      let t = Math.ceil((base * 1000 - Date.parse('2026-10-04T22:00:00Z')) / D) * D + Date.parse('2026-10-04T22:00:00Z');
      for (let i = 0; i < n; i++, t += D) lines.push(`       (in UTC): Xxx ${new Date(t).toISOString().slice(0, 19).replace('T', ' ')} UTC`);
      return { ok: true, stdout: lines.join('\n'), stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'nieznane polecenie' };
  };
}

test('createCalendar: crony, timery (monotoniczny tylko następny, nieaktywny pominięty), mozgd offline nie wywraca', async () => {
  const calls = [];
  const cal = createCalendar({
    runCmd: fakeRun(calls),
    readCrontab: async () => ({ ok: true, stdout: '*/10 * * * * /x/hub-autocommit.sh\n0 8 * * 1 /x/raport.sh\n', stderr: '' }),
    mozg: { call: async () => { throw new Error('Dyspozytor offline'); } },
  });
  const r = await cal.list('2026-10-04T22:00:00Z', '2026-10-11T22:00:00Z');
  assert.equal(r.sources.mozg.available, false);
  assert.equal(r.sources.mozg.error, 'Dyspozytor offline');
  const bySrc = (s, title) => r.events.filter((e) => e.source === s && e.title === title);
  const hub = bySrc('cron', 'hub-autocommit.sh');
  assert.equal(hub.length, 7);
  assert.ok(hub.every((e) => e.allDay && e.recurring.collapsed && e.recurring.count === 144 && e.recurring.every_sec === 600));
  assert.equal(hub[0].detail.last_result, null);
  const rap = bySrc('cron', 'raport.sh');
  assert.deepEqual(rap.map((e) => e.start), ['2026-10-05T06:00:00.000Z']);
  const rot = bySrc('timer', 'rot');
  assert.equal(rot.length, 1, 'monotoniczny: tylko znane następne wystąpienie');
  assert.deepEqual([rot[0].recurring.every_sec, rot[0].recurring.monotonic, rot[0].detail.last.result, rot[0].detail.last.status], [60, true, 'exit-code', 2]);
  const daily = r.events.filter((e) => e.source === 'timer' && e.title === 'daily');
  assert.equal(daily.length, 7);
  assert.ok(daily.every((e) => e.system && e.start.endsWith('T22:00:00.000Z')));
  assert.deepEqual(r.sources.timers_system.inactive.map((x) => x.unit), ['off.timer']);
  assert.ok(!r.events.some((e) => e.title === 'off'));
  assert.ok(r.events.every((e) => e.editable === false));
  assert.ok(calls.every((c) => !/crontab -[er]|systemctl( --user)? (start|stop|enable|disable|restart)/.test(c)), 'tylko odczyt');
});

test('createCalendar: harmonogramy mozgd i walidacja zakresu', async () => {
  const cal = createCalendar({
    runCmd: async () => ({ ok: true, stdout: '[]', stderr: '' }), readCrontab: async () => ({ ok: false, stdout: '', stderr: 'no crontab for user' }),
    mozg: { call: async (m, p) => { assert.equal(m, 'calendar_list'); assert.deepEqual(Object.keys(p), ['from', 'to']);
      return { truncated: false, items: [{ id: 's1', thread_id: 'general', thread_title: 'Ogólne', run_at: Date.parse('2026-10-10T13:30:00Z') / 1000, action: 'usage_report', params: { days: 7 }, state: 'pending', created: 1, fired_at: null }] }; } },
  });
  const r = await cal.list('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  assert.equal(r.sources.cron.error, null);
  assert.deepEqual(r.events.map((e) => [e.source, e.title, e.start, e.state]), [['mozg', 'Raport zużycia (7 d)', '2026-10-10T13:30:00.000Z', 'pending']]);
  await assert.rejects(cal.list('2026-10-01T00:00:00Z', '2026-12-03T00:00:00Z'), (e) => e.code === 400);
  await assert.rejects(cal.list('x', '2026-12-03T00:00:00Z'), (e) => e.code === 400);
  await assert.rejects(cal.list('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z'), (e) => e.code === 400);
});

test('GET /api/calendar: autoryzacja, tylko odczyt, mozgd niedostępny', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-cal-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.config/cc-panel'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/cc-panel/token'), 'test-token-123\n');
  const port = 17000 + Math.floor(Math.random() * 900);
  const srv = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, HOME: home, PORT: String(port), REPORT_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serwer nie wstał')), 10000);
    const poll = () => fetch(`http://127.0.0.1:${port}/`).then(() => { clearTimeout(timer); resolve(); }, () => setTimeout(poll, 100));
    poll();
  });
  const base = `http://127.0.0.1:${port}/api/calendar?from=2026-10-05T00:00:00Z&to=2026-10-12T00:00:00Z`;
  const cookie = { Cookie: 'ccp=test-token-123' };
  assert.equal((await fetch(base)).status, 401);
  const ok = await fetch(base, { headers: cookie });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.tz, 'Europe/Warsaw');
  assert.equal(body.sources.mozg.available, false);
  assert.ok(Array.isArray(body.events));
  assert.equal((await fetch(base.replace('2026-10-12', '2026-12-12'), { headers: cookie })).status, 400);
  assert.equal((await fetch(base, { method: 'POST', headers: { ...cookie, 'X-CCP': '1' } })).status, 405);
  assert.equal((await fetch(base, { method: 'DELETE', headers: cookie })).status, 403);
  const vendor = await fetch(`http://127.0.0.1:${port}/vendor/event-calendar.js`);
  assert.equal(vendor.status, 200);
});

test('frontend: czas ścienny Warsaw niezależnie od strefy procesu, grupowanie rutyny, filtr systemowych', () => {
  const { warsawWall, toEcEvents } = require('../public/calendar');
  assert.equal(warsawWall('2026-10-25T00:30:00Z'), '2026-10-25T02:30:00');
  assert.equal(warsawWall('2026-10-25T01:30:00Z'), '2026-10-25T02:30:00');
  assert.equal(warsawWall('2026-10-26T09:00:00Z'), '2026-10-26T10:00:00');
  const ev = [
    { id: 'a', source: 'cron', title: 'a.sh', start: '2026-10-05T22:00:00Z', end: '2026-10-06T21:50:00Z', allDay: true, recurring: { collapsed: true, every_sec: 600, count: 144 } },
    { id: 'b', source: 'timer', title: 'rot', start: '2026-10-06T10:00:00Z', allDay: true, recurring: { collapsed: true, every_sec: 60, monotonic: true } },
    { id: 'c', source: 'mozg', title: 'Raport', start: '2026-10-10T13:30:00Z', state: 'pending' },
    { id: 'd', source: 'timer', system: true, title: 'logrotate', start: '2026-10-06T22:00:00Z', recurring: { collapsed: false } },
  ];
  const all = { cron: true, timer: true, system: false, mozg: true, rutyna: true };
  const week = toEcEvents(ev, all);
  assert.deepEqual(week.map((e) => [e.id, e.start, e.end, !!e.allDay]), [
    ['a', '2026-10-06', '2026-10-07', true], ['b', '2026-10-06', '2026-10-07', true], ['c', '2026-10-10T15:30:00', '2026-10-10T16:00:00', false]]);
  const month = toEcEvents(ev, { ...all, system: true }, { groupRoutine: true });
  assert.deepEqual(month.map((e) => e.id), ['c', 'd', 'rutyna:2026-10-06']);
  assert.equal(month[2].extendedProps.group.length, 2);
  assert.equal(month.find((e) => e.id === 'd').start, '2026-10-07T00:00:00');
  assert.deepEqual(toEcEvents(ev, { ...all, rutyna: false, mozg: false }).map((e) => e.id), []);
});

test('createCalendar: worker_task (E2) - tytuł, stan, szczegóły, pauza; kolory stanów w widoku', async () => {
  const at = Date.parse('2026-10-10T08:00:00Z') / 1000;
  const item = (id, state, extra = {}) => ({ id, thread_id: 'general', thread_title: 'Ogólne', run_at: at, action: 'worker_task',
    params: { project: 'sandbox', title: 'Raport X', body: 'zrob' }, state, created: 1, fired_at: null, latest_start_at: at + 21600,
    task_id: null, label: null, wait_reason: null, error: null, revision: 1, source: 'cli', ...extra });
  const cal = createCalendar({
    runCmd: async () => ({ ok: true, stdout: '[]', stderr: '' }), readCrontab: async () => ({ ok: false, stdout: '', stderr: 'no crontab for user' }),
    mozg: { call: async () => ({ truncated: false, paused: true, items: [item('a', 'waiting_capacity', { wait_reason: 'capacity' }),
      item('b', 'started', { task_id: 'task_1', label: 'plan-b' }), item('c', 'uncertain', { error: 'Nie wiem' })] }) },
  });
  const r = await cal.list('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  assert.equal(r.sources.mozg.paused, true);
  assert.deepEqual(r.events.map((e) => [e.title, e.state, e.editable]), [['🤖 Raport X', 'waiting_capacity', false], ['🤖 Raport X', 'started', false], ['🤖 Raport X', 'uncertain', false]]);
  const [a, b, c] = r.events;
  assert.equal(a.detail.wait_reason, 'capacity');
  assert.equal(a.detail.latest_start_at, '2026-10-10T14:00:00.000Z');
  assert.equal(b.detail.task_id, 'task_1');
  assert.equal(c.detail.error, 'Nie wiem');
  const { toEcEvents } = require('../public/calendar.js');
  const ec = toEcEvents(r.events, { cron: true, timer: true, system: false, mozg: true, rutyna: true });
  assert.ok(ec[0].classNames.includes('ev-waiting'));
  assert.ok(!ec[1].classNames.includes('ev-failed') && !ec[1].classNames.includes('ev-waiting'));
  assert.ok(ec[2].classNames.includes('ev-failed'));
});

// Regresja 04.10: usługa systemowa cc-panel (User=user) nie ma XDG_RUNTIME_DIR, więc
// "Błąd odczytu (timery użytkownika): systemctl user: Failed to connect to bus: No medium found".
test('cmdEnv: uzupełnia XDG_RUNTIME_DIR i bus użytkownika, nie nadpisuje istniejących', () => {
  const yes = () => true, no = () => false;
  const e = cmdEnv({ HOME: '/h', PATH: '/usr/bin' }, 1001, yes);
  assert.equal(e.XDG_RUNTIME_DIR, '/run/user/1001');
  assert.equal(e.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1001/bus');
  assert.equal(e.LC_ALL, 'C');
  const own = cmdEnv({ XDG_RUNTIME_DIR: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/y' }, 1001, yes);
  assert.equal(own.XDG_RUNTIME_DIR, '/x');
  assert.equal(own.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/y');
  const none = cmdEnv({ HOME: '/h' }, 1001, no);
  assert.equal(none.XDG_RUNTIME_DIR, undefined);
  assert.equal(none.DBUS_SESSION_BUS_ADDRESS, undefined);
});

test('timery użytkownika czytają się bez XDG_RUNTIME_DIR (jak w usłudze systemd)', { skip: !fs.existsSync(`/run/user/${process.getuid()}/bus`) && 'brak busa użytkownika' }, async () => {
  const code = `require(${JSON.stringify(path.join(__dirname, '../lib/calendar'))}).createCalendar({ readCrontab: async () => ({ ok: true, stdout: '' }) })
    .list(new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 864e5).toISOString())
    .then((r) => process.stdout.write(JSON.stringify(r.sources.timers_user)))`;
  const env = { HOME: os.homedir(), PATH: process.env.PATH, LANG: 'C.UTF-8' };
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code], { env });
    let s = ''; p.stdout.on('data', (d) => { s += d; }); p.on('error', reject);
    p.on('close', () => resolve(s));
  });
  assert.equal(JSON.parse(out).error, null);
});
