// Ikony nagłówka Dyspozytora na telefonie (05.10): SVG inline zamiast emoji i napisów, ta sama siatka 20x20 co status-icons.js.
// Do tego stan Dyspozytora jako ikona (pełny tekst po tapnięciu) i pierścień limitu 5h/7d. Bez DOM - zwraca tekst SVG.
(function (root) {
  'use strict';
  const PATH = {
    // SESJE: siatka kart (nie ≡, żeby nie myliła się z menu ⋯)
    list: '<path fill="currentColor" d="M4 2.5h3.5A1.5 1.5 0 0 1 9 4v3.5A1.5 1.5 0 0 1 7.5 9H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5ZM12.5 2.5H16A1.5 1.5 0 0 1 17.5 4v3.5A1.5 1.5 0 0 1 16 9h-3.5A1.5 1.5 0 0 1 11 7.5V4a1.5 1.5 0 0 1 1.5-1.5ZM4 11h3.5A1.5 1.5 0 0 1 9 12.5V16a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 16v-3.5A1.5 1.5 0 0 1 4 11ZM12.5 11H16a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 1-1.5 1.5h-3.5A1.5 1.5 0 0 1 11 16v-3.5a1.5 1.5 0 0 1 1.5-1.5Z"/>',
    // CHAT: dymek z kropkami (kafelki Claude / ChatGPT)
    chat: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4.5 3h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.6l-4.1 3v-3h-1a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path fill="currentColor" d="M6.1 7.6h1.8v1.8H6.1ZM9.1 7.6h1.8v1.8H9.1ZM12.1 7.6h1.8v1.8h-1.8Z"/>',
    link: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8.6 11.4a3.5 3.5 0 0 0 5 0l2.8-2.8a3.5 3.5 0 0 0-5-5l-1 1M11.4 8.6a3.5 3.5 0 0 0-5 0l-2.8 2.8a3.5 3.5 0 0 0 5 5l1-1"/>',
    more: '<path fill="currentColor" d="M4 8.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 1 0 0-3.6ZM10 8.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 1 0 0-3.6ZM16 8.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 1 0 0-3.6Z"/>',
    bell: '<path fill="currentColor" d="M10 1.8a1.2 1.2 0 0 1 1.2 1.2v.6A5.5 5.5 0 0 1 15.5 9v3.6l1.7 2.2a.8.8 0 0 1-.6 1.3H3.4a.8.8 0 0 1-.6-1.3l1.7-2.2V9a5.5 5.5 0 0 1 4.3-5.4V3A1.2 1.2 0 0 1 10 1.8ZM7.8 17.2h4.4a2.2 2.2 0 0 1-4.4 0Z"/>',
    'bell-off': '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4.5 15.3h11.1l-1.6-2.1V9A4 4 0 0 0 6 9v4.2ZM8.2 17.4a1.9 1.9 0 0 0 3.6 0"/><path stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 3l14 14"/>',
    cal: '<path fill-rule="evenodd" fill="currentColor" d="M6 1.5h1.6v1.7h4.8V1.5H14v1.7h1.5A2.5 2.5 0 0 1 18 5.7v9.8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 2 15.5V5.7a2.5 2.5 0 0 1 2.5-2.5H6Zm-2.3 6.3v7.7c0 .5.4.8.8.8h11c.4 0 .8-.3.8-.8V7.8ZM6 10h2.2v2.2H6Zm3.9 0h2.2v2.2H9.9Z"/>',
    archive: '<path fill-rule="evenodd" fill="currentColor" d="M2.5 3h15A1.5 1.5 0 0 1 19 4.5v2A1.5 1.5 0 0 1 17.8 8v7.5a2.5 2.5 0 0 1-2.5 2.5H4.7a2.5 2.5 0 0 1-2.5-2.5V8A1.5 1.5 0 0 1 1 6.5v-2A1.5 1.5 0 0 1 2.5 3Zm.2 1.7v1.6h14.6V4.7ZM3.9 8v7.5c0 .4.4.8.8.8h10.6c.4 0 .8-.4.8-.8V8ZM7.5 9.6h5v1.7h-5Z"/>',
    aa: '<path fill="currentColor" d="M6.3 3.5h2l4.6 13h-2l-1.1-3.3H4.7l-1.1 3.3h-2Zm1 2.6-2 5.4h4Zm8.4 2.4c2 0 3 1 3 2.9v5.1h-1.6l-.1-.9c-.5.7-1.2 1.1-2.2 1.1-1.5 0-2.5-.9-2.5-2.2 0-1.6 1.3-2.4 3.5-2.4h1.2v-.4c0-1-.5-1.5-1.5-1.5-.8 0-1.4.3-1.9.8l-.9-1.1c.7-.8 1.8-1.4 3-1.4Zm-.6 5.2c-1.1 0-1.7.4-1.7 1.1 0 .6.5 1 1.2 1 1 0 1.8-.7 1.8-1.7v-.4Z"/>',
    // stan Dyspozytora
    queue: '<path fill-rule="evenodd" fill="currentColor" d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17Zm0 1.9a6.6 6.6 0 1 1 0 13.2 6.6 6.6 0 1 1 0-13.2ZM9.1 5.5h1.8v4.1l2.9 1.7-.9 1.6-3.8-2.2Z"/>',
    offline: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M2.2 7.6a11 11 0 0 1 15.6 0M5 10.5a7 7 0 0 1 10 0M7.8 13.3a3 3 0 0 1 4.4 0"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 3l14 14"/>',
  };
  const svg = (name, cls = 'hi') => `<svg class="${cls}" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${PATH[name]}</svg>`;

  // tekst ze setMozgStatus -> ikona; 'online' = nic do pokazania (ikona znika), reszta to stan albo komunikat błędu
  function mozgStatusKind(text) {
    const t = String(text || '');
    if (!t || t === 'online') return { kind: 'online', label: 'online' };
    if (t === 'pracuje') return { kind: 'work', label: 'Dyspozytor pracuje' };
    if (t === 'czeka w kolejce') return { kind: 'queue', label: 'Dyspozytor czeka w kolejce' };
    if (t === 'offline') return { kind: 'offline', label: 'Dyspozytor offline' };
    return { kind: 'err', label: 'Błąd: ' + t };
  }

  // pierścień limitu: zewnętrzny = 5h, wewnętrzny = 7d (items z UsageMini.miniUsage), w środku % gorszego okna
  const RANK = { crit: 3, warn: 2, ok: 1, '': 0 };
  function worstItem(items) {
    let best = null;
    for (const x of items) {
      if (x.dim) continue;
      if (!best || RANK[x.level] > RANK[best.level] || (RANK[x.level] === RANK[best.level] && x.pct > best.pct)) best = x;
    }
    return best;
  }
  // tag: litera providera ("C" Claude, "X" Codex) w plakietce na dole pierścienia - tylko gdy pierścienie są dwa
  // ghost (Codex, stare dane): wartość pokazana na szaro zamiast "–", gdy nie ma nic świeżego
  function ringSvg(items, tag = '', cls = '') {
    let w = worstItem(items), ghost = false;
    if (!w) { w = worstItem(items.filter((x) => x.ghost).map((x) => ({ ...x, dim: false }))); ghost = !!w; }
    const arc = (x, r, cls) => {
      const lvl = x ? (x.dim ? ' dim' : x.level ? ' ' + x.level : '') : ' dim';
      const p = x && (!x.dim || x.ghost) ? Math.round(x.pct) : 0;
      return `<circle class="ur-track" cx="18" cy="18" r="${r}"/>` +
        (p ? `<circle class="ur-arc${lvl}${cls}" cx="18" cy="18" r="${r}" pathLength="100" stroke-dasharray="${p} 100" transform="rotate(-90 18 18)"/>` : '');
    };
    // poziom czytelny bez koloru: "!" po liczbie przy warn i crit (jak "72%!" w wersji tekstowej)
    const center = w ? Math.round(w.pct) + (w.level === 'warn' || w.level === 'crit' ? '!' : '') : '–';
    const size = { 1: 11, 2: 11, 3: 9, 4: 7.5 }[center.length] || 7.5;
    const badge = tag ? `<rect class="ur-tag-bg" x="11.5" y="27.6" width="13" height="8.4" rx="4.2"/>` +
      `<text class="ur-tag" x="18" y="31.9" text-anchor="middle" dominant-baseline="central" font-size="7.4">${tag}</text>` : '';
    return `<svg class="um-ring${cls ? ' ' + cls : ''}" viewBox="0 0 36 36" aria-hidden="true" focusable="false">${arc(items[0], 15.5, ' ur-5h')}${arc(items[1], 10.5, ' ur-7d')}` +
      `<text class="ur-num${ghost ? ' dim' : w && w.level ? ' ' + w.level : ''}" x="18" y="18.5" text-anchor="middle" dominant-baseline="central" font-size="${size}">${center}</text>${badge}</svg>`;
  }

  const api = { PATH, svg, mozgStatusKind, worstItem, ringSvg, ICONS: Object.keys(PATH) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HdrIcons = api;
})(typeof window === 'undefined' ? globalThis : window);
