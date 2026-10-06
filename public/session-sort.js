// Tryby porządkowania listy sesji (05.10): Uwaga (domyślny), Projekt, Nazwa A-Z.
// Wejście: płaska lista pozycji { key, name, status, time, machine, project, agent, background } ze wszystkich źródeł
// (herdr, RC, Codex, tmux). Wyjście: sekcje [{ key, title, items }] w kolejności wyświetlania. Bez DOM.
(function (root) {
  'use strict';
  const MODES = ['attention', 'project', 'name'];
  const LABELS = { attention: 'Uwaga', project: 'Projekt', name: 'Nazwa A-Z' };
  // proszący blokuje, pracujący nie: approval przed working
  const RANK = { approval: 0, working: 1, bg: 2, done: 3, idle: 3, shell: 4 };
  const rank = (it) => RANK[it.status] ?? 3;
  const coll = new Intl.Collator('pl', { sensitivity: 'base', numeric: true });
  const byName = (a, b) => coll.compare(String(a.name ?? ''), String(b.name ?? ''));
  const byTime = (a, b) => (b.time || 0) - (a.time || 0);
  const tail = (a, b) => coll.compare(String(a.machine ?? ''), String(b.machine ?? '')) || String(a.key).localeCompare(String(b.key));

  const parseMode = (m) => (MODES.includes(m) ? m : 'attention');
  const nextMode = (m) => MODES[(MODES.indexOf(parseMode(m)) + 1) % MODES.length];

  // Uwaga: „Do Ciebie” = prośba o zgodę albo agent, który skończył po ostatnim obejrzeniu tej sesji.
  // Bez wpisu w seen liczy się base (moment pierwszego uruchomienia trybu), żeby start nie zalał sekcji starymi sesjami.
  const ATTENTION = [
    { key: 'you', title: 'Do Ciebie' },
    { key: 'work', title: 'Pracuje' },
    { key: 'idle', title: 'Bezczynne', collapsed: true },
    { key: 'bg', title: 'Tło', collapsed: true },
  ];
  function attentionOf(it, seen = {}, base = 0) {
    if (it.status === 'approval') return 'you';
    if (it.background) return 'bg';
    if (it.agent === false || it.status === 'shell') return 'idle';
    if (it.status === 'working' || it.status === 'bg') return 'work';
    return (it.time || 0) > Math.max(seen[it.key] || 0, base || 0) ? 'you' : 'idle';
  }
  const attentionCmp = (a, b) => (a.status === 'approval' ? 0 : 1) - (b.status === 'approval' ? 0 : 1) || byTime(a, b) || byName(a, b) || tail(a, b);
  function attentionSections(items, seen, base) {
    const out = ATTENTION.map((s) => ({ ...s, items: [] }));
    for (const it of items) out.find((s) => s.key === attentionOf(it, seen, base)).items.push(it);
    for (const s of out) s.items.sort(attentionCmp);
    return out.filter((s) => s.items.length);
  }

  // Projekt: grupy po katalogu; grupa z prośbą o zgodę, potem z pracującym, wyżej; dalej świeższa grupa wyżej.
  const statusCmp = (a, b) => rank(a) - rank(b) || byTime(a, b) || byName(a, b) || tail(a, b);
  function projectSections(items) {
    const groups = new Map();
    for (const it of items) {
      const k = it.project || '';
      if (!groups.has(k)) groups.set(k, { key: 'p:' + k, title: k || '(bez katalogu)', items: [] });
      groups.get(k).items.push(it);
    }
    const hot = (g) => Math.min(2, ...g.items.map(rank));
    const last = (g) => Math.max(0, ...g.items.map((it) => it.time || 0));
    const list = [...groups.values()];
    for (const g of list) g.items.sort(statusCmp);
    return list.sort((a, b) => hot(a) - hot(b) || last(b) - last(a) || coll.compare(a.title, b.title));
  }

  // Nazwa A-Z: stała kolejność między odświeżeniami (status i czas nie grają roli).
  function nameSections(items) {
    return items.length ? [{ key: 'az', title: 'Wszystkie', items: [...items].sort((a, b) => byName(a, b) || tail(a, b)) }] : [];
  }

  function sections(mode, items, opts = {}) {
    const m = parseMode(mode);
    if (m === 'project') return projectSections(items);
    if (m === 'name') return nameSections(items);
    return attentionSections(items, opts.seen, opts.base);
  }

  // „obejrzane”: { key: sekundy }; wpisy starsze niż 14 dni wypadają przy zapisie
  function pruneSeen(seen, now, maxAge = 14 * 86400) {
    const out = {};
    for (const [k, t] of Object.entries(seen || {})) if (now - t < maxAge) out[k] = t;
    return out;
  }

  const api = { MODES, LABELS, parseMode, nextMode, attentionOf, sections, pruneSeen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionSort = api;
})(typeof window === 'undefined' ? globalThis : window);
