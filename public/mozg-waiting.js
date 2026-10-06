(function (root) {
  'use strict';
  // Wiadomość Dyspozytora -> sesje, o których pisze, że czekają („medley-falcon: panel czeka na Twoje …”).
  // Tekst jest wolny (bez ID), więc dopasowanie idzie po nazwach z bieżącej listy sesji; przycisk niesie
  // stabilny klucz (herdr: maszyna/pane, tmux: nazwa sesji) i przed przejściem sprawdza go jeszcze raz.
  const WAIT = /(?<![\p{L}\p{N}])(czeka(ją|jąc[aey]?|ł[aoy]?|li)?|prosi|pyta|zgod[aęyz]|zgodzie|decyzj[aęiy])(?![\p{L}\p{N}])/iu;
  const WAITING = new Set(['approval', 'blocked', 'idle', 'done', 'bg']);
  const isBrainPane = (it) => typeof it?.tabLabel === 'string' && it.tabLabel.startsWith('mozg-g');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const usable = (alias) => typeof alias === 'string' && alias.trim().length >= 3 && !/^\d+$/.test(alias.trim());

  // herdr: /api/herdr .items, tmux: /api/sessions; tylko sesje agentów (bez shelli i paneli Dyspozytora)
  function candidates(herdrItems = [], tmuxSessions = []) {
    const out = [];
    for (const it of herdrItems) {
      if (!it?.agent || isBrainPane(it) || !it.machine || !it.pane) continue;
      const label = it.display || it.name;
      const aliases = [it.display, it.name, it.workspace, it.tabLabel];
      // herdr nazywa niegłówne karty „workspace · tytuł” - sam tytuł też jest nazwą
      if (typeof it.name === 'string' && it.name.includes(' · ')) aliases.push(it.name.slice(it.name.indexOf(' · ') + 3));
      out.push({ key: `h:${it.machine}/${it.pane}`, hash: `#/h/${encodeURIComponent(it.machine)}/${encodeURIComponent(it.pane)}`,
        label, status: it.status, aliases: [...new Set(aliases.filter(usable).map((a) => a.trim()))] });
    }
    for (const s of tmuxSessions) {
      if (!s?.name || !['claude', 'codex'].includes(s.kind)) continue;
      out.push({ key: 's:' + s.name, hash: '#/s/' + encodeURIComponent(s.name), label: s.name, status: s.status,
        aliases: usable(s.name) ? [s.name.trim()] : [] });
    }
    return out;
  }

  // alias -> jedna sesja; alias pasujący do kilku sesji odpada (nie zgadujemy „pierwszej”)
  function aliasIndex(cands) {
    const map = new Map();
    for (const c of cands) for (const a of c.aliases) {
      const k = a.toLocaleLowerCase('pl');
      const prev = map.get(k);
      map.set(k, prev && prev !== c ? null : c);
    }
    return [...map].filter(([, c]) => c).sort((a, b) => b[0].length - a[0].length);
  }

  // zdania (i linie) z „czeka/prosi/pyta/zgoda/decyzja” -> nazwy sesji w tym samym zdaniu, w kolejności z tekstu
  function refs(text, cands) {
    const index = aliasIndex(cands);
    if (!index.length || !text) return [];
    const found = new Map();
    for (const sentence of String(text).split(/\n+|(?<=[.!?])\s+/)) {
      if (!WAIT.test(sentence)) continue;
      const hits = [];
      for (const [alias, c] of index) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(alias)}(?![\\p{L}\\p{N}_-])`, 'giu');
        for (const m of sentence.matchAll(re)) hits.push({ at: m.index, c });
      }
      hits.sort((a, b) => a.at - b.at);
      for (const h of hits) if (!found.has(h.c.key)) found.set(h.c.key, h.c);
    }
    return [...found.values()].map(({ key, hash, label, status }) => ({ key, hash, label, status, waiting: WAITING.has(status) }));
  }

  // przed przejściem: ta sama sesja po kluczu w świeżej liście; null = zniknęła
  function resolve(key, cands) {
    const c = cands.find((x) => x.key === key);
    return c ? { key: c.key, hash: c.hash, label: c.label, status: c.status, waiting: WAITING.has(c.status) } : null;
  }

  const api = { candidates, refs, resolve, WAITING };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MozgWaiting = api;
})(typeof window === 'undefined' ? globalThis : window);
