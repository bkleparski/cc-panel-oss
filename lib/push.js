'use strict';
// Web Push (standard W3C): powiadomienia trafiają przez usługę push przeglądarki (na iPhonie Apple),
// zaszyfrowane kluczem subskrypcji — bez zewnętrznych serwisów typu ntfy.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DEFAULT_PREFS = { done: true, approval: true, mozg: true, limit: true, limitCodex: true }; // limit: prognoza limitu planu Claude, limitCodex: crit Codexa (lib/usage-alerts.js)

function createPush(cfgDir, subject) {
  const vapidFile = path.join(cfgDir, 'vapid.json');
  const subsFile = path.join(cfgDir, 'push-subscriptions.json');
  if (!fs.existsSync(vapidFile)) {
    fs.writeFileSync(vapidFile, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
  }
  const keys = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  let subs = [];
  try { subs = JSON.parse(fs.readFileSync(subsFile, 'utf8')); } catch {}
  const save = () => fs.writeFileSync(subsFile, JSON.stringify(subs, null, 1), { mode: 0o600 });
  const trySave = () => { try { save(); } catch (e) { console.error('push: zapis subskrypcji:', e.message); } };

  // historia wysłanych powiadomień (bez testów): ostatnie HISTORY_MAX, w pliku, żeby przeżyła restart
  const HISTORY_MAX = 100;
  const historyFile = path.join(cfgDir, 'notify-history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(historyFile, 'utf8')); if (!Array.isArray(hist)) hist = []; } catch {}
  const saveHistory = () => fs.writeFile(historyFile, JSON.stringify(hist), { mode: 0o600 },
    (e) => e && console.error('push: zapis historii:', e.message));
  const find = (endpoint) => subs.find((s) => s.sub.endpoint === endpoint);

  function subscribe(sub, prefs) {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Zła subskrypcja');
    const existing = find(sub.endpoint);
    const p = { ...DEFAULT_PREFS, ...(existing?.prefs || {}), ...(prefs || {}) };
    subs = subs.filter((s) => s.sub.endpoint !== sub.endpoint);
    subs.push({ sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs: p, at: Date.now() });
    save();
    return p;
  }
  function unsubscribe(endpoint) {
    subs = subs.filter((s) => s.sub.endpoint !== endpoint);
    save();
  }
  function prefsFor(endpoint) { const s = find(endpoint); return s ? { ...DEFAULT_PREFS, ...s.prefs } : null; }

  // type: 'done' | 'approval' | 'mozg' | 'limit' | 'limitCodex' | 'test' | 'alarm' (alarm ze skryptu - jak test, bez wyłącznika w preferencjach)
  async function notify(type, payload, onlyEndpoint) {
    const targets = subs.filter((s) => (onlyEndpoint ? s.sub.endpoint === onlyEndpoint : type === 'test' || type === 'alarm' || (s.prefs[type] ?? DEFAULT_PREFS[type])));
    let gone = false, failed = 0;
    await Promise.all(targets.map(async (s) => {
      try {
        // timeout bezczynności gniazda (nie całkowity limit): zawieszony serwer push odpada po ok. 10 s (w teście ~2x wartości);
        // świadomie bez twardego deadline'u - wysyłka idzie w tle (notifySafe), subskrypcji jest kilka
        await webpush.sendNotification(s.sub, JSON.stringify(payload), { timeout: 5000, TTL: 3600, urgency: 'high', topic: (payload.tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { s.dead = true; gone = true; }
        else { failed++; console.error('push:', e.statusCode || '', e.message); }
      }
    }));
    if (gone) { subs = subs.filter((s) => !s.dead); trySave(); } // błąd zapisu nie może zgubić wyniku wysyłki
    // tylko gdy nie doszło do zadnego urzadzenia - inaczej ponowienie dubluje push na dzialajacych
    if (type === 'mozg' && failed && failed === targets.length) throw new Error('Nie udało się dostarczyć push dyspozytora');
    if (type !== 'test') {
      hist.unshift({ at: Date.now() / 1000, type, title: payload.title, body: payload.body, url: payload.url, sent: targets.length });
      hist = hist.slice(0, HISTORY_MAX);
      saveHistory();
    }
    return targets.length;
  }

  return { publicKey: keys.publicKey, subscribe, unsubscribe, prefsFor, notify, count: () => subs.length, history: () => hist };
}

module.exports = { createPush };
