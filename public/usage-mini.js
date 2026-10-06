// Mini-wskaźnik limitu planu w nagłówku Dyspozytora (05.10): skrót odpowiedzi /api/usage do dwóch pozycji 5h i 7d,
// plus te same dwie pozycje dla Codexa (u.codex), gdy są jego próbki.
// Bez DOM. Poziom czytelny też bez koloru: warn = "!" po procencie, crit = "!!".
// Brak danych (błąd fetch, brak bazy mozgd, okno bez próbek, dane nieświeże) = pozycja wyszarzona, nie błąd.
(function (root) {
  'use strict';
  const KEYS = ['5h', '7d'];
  const MARK = { ok: '', warn: '!', crit: '!!' };
  const WORD = { ok: '', warn: ' (uwaga)', crit: ' (blisko limitu)' };

  // wiek danych: "przed chwilą", "sprzed 12 min", "sprzed 3 h", "sprzed 2 d"
  function agePl(sec) {
    const m = Math.floor(Math.max(0, sec) / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? `sprzed ${d} d` : h ? `sprzed ${h} h` : m ? `sprzed ${m} min` : 'przed chwilą';
  }

  // Codex (sekcja u.codex z lib/codex-usage.js, 05.10): próbki tylko w trakcie pracy Codexa, więc zwykle stare -
  // stare = wyszarzone, ale z ostatnią wartością. null = brak danych, wskaźnik Codex się nie pokazuje.
  function codexMini(c, hhmm) {
    if (!c || !Array.isArray(c.windows) || !c.windows.length) return null;
    const m = windowsMini(c.windows, hhmm);
    // ghost: stara, ale prawdziwa wartość - pierścień rysuje ją na szaro zamiast "–"
    c.windows.forEach((w, i) => { if (w.state === 'ok' && m.items[i]) m.items[i].ghost = !!w.stale; });
    const age = agePl(c.age || 0);
    const reached = c.reached ? `, limit osiągnięty (${c.reached})` : '';
    const parts = m.parts.map((x) => x.replace(', dane nieaktualne', '')); // wiek danych podany raz, na końcu
    return { ...m, stale: !!c.stale, age, label: `Codex: ${parts.join('; ')}${reached}, dane ${age}` };
  }

  function windowsMini(windows, hhmm) {
    const items = [], parts = [];
    for (const w of windows) {
      if (w.state === 'ok') {
        const pct = Math.round(w.pct), level = MARK[w.level] != null ? w.level : 'ok';
        items.push({ key: w.key, text: `${pct}%${MARK[level]}`, level, dim: !!w.stale, pct: Math.min(100, Math.max(0, w.pct)) });
        const fc = w.forecast?.state === 'limit' ? `, limit ~${hhmm(w.forecast.at)} przy obecnym tempie` : '';
        parts.push(`${w.key} ${pct}%${WORD[level]}, reset ${hhmm(w.resetsAt)}${fc}${w.stale ? ', dane nieaktualne' : ''}`);
      } else if (w.state === 'expired') {
        items.push({ key: w.key, text: '0%', level: '', dim: true, pct: 0 });
        parts.push(`${w.key} okno zresetowane, czekam na próbki`);
      } else {
        items.push({ key: w.key, text: '–', level: '', dim: true, pct: 0 });
        parts.push(`${w.key} brak próbek`);
      }
    }
    return { off: items.every((x) => x.dim), items, parts };
  }

  // u: odpowiedź /api/usage albo null (fetch nieudany); hhmm(t): formatowanie godziny resetu/prognozy
  // codex: wynik codexMini albo null; label opisuje oba limity (title/aria-label wskaźnika)
  function miniUsage(u, hhmm = (t) => String(t)) {
    const codex = codexMini(u?.codex, hhmm);
    const tail = codex ? `. ${codex.label}` : '';
    const reason = !u ? 'brak połączenia z /api/usage' : u.error || (!u.windows?.length ? 'brak danych' : '');
    if (reason) {
      return { off: true, items: KEYS.map((key) => ({ key, text: '–', level: '', dim: true, pct: 0 })), codex,
        label: `Limit planu${codex ? ' Claude' : ''}: ${reason}${tail}` };
    }
    const m = windowsMini(u.windows, hhmm);
    return { off: m.off, items: m.items, codex, label: `Limit planu${codex ? ' Claude' : ''}: ${m.parts.join('; ')}${tail}` };
  }

  const api = { miniUsage, codexMini, agePl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UsageMini = api;
})(typeof window === 'undefined' ? globalThis : window);
