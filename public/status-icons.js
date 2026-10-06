// Statusy sesji kształtem, nie tylko kolorem (05.10, etap 1 wyglądu): trójkąt = prosi o zgodę, dymek = czeka na Ciebie,
// kółko ładowania = pracuje, ptaszek = skończył, kwadrat = bezczynna, ośmiokąt z X = błąd.
// SVG inline z prawdziwymi wycięciami (fill-rule evenodd), więc ikona wygląda tak samo na każdym tle i w każdym motywie.
// Kolor z CSS: .si-<kształt> { color: var(--st-…) }. Bez DOM - zwraca tekst SVG.
(function (root) {
  'use strict';
  // status sesji (serwer/herdr) -> kształt; 'bg' = czeka, ale pracują zadania w tle, więc też kółko ładowania
  const SHAPE = { approval: 'ask', idle: 'you', working: 'work', bg: 'work', done: 'done', shell: 'idle', error: 'err' };
  const LABEL = { ask: 'prosi o zgodę', you: 'czeka na Ciebie', work: 'pracuje', done: 'skończył', idle: 'bezczynna', err: 'błąd' };
  const PATH = {
    ask: '<path fill-rule="evenodd" fill="currentColor" d="M10 1.6 19.2 18H.8ZM9 7.2h2v5.6H9ZM10 14.1a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 1 0 0-2.6Z"/>',
    you: '<path fill-rule="evenodd" fill="currentColor" d="M5.5 2h9A2.5 2.5 0 0 1 17 4.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4.5 4v-4A1.5 1.5 0 0 1 3 12.5v-8A2.5 2.5 0 0 1 5.5 2ZM7 6.9a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 1 0 0-2.2ZM10 6.9a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 1 0 0-2.2ZM13 6.9a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 1 0 0-2.2Z"/>',
    work: '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="3"/><path class="si-arc" d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    done: '<path fill-rule="evenodd" fill="currentColor" d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17ZM5.3 10.4 6.7 9l2.1 2.1 4.5-4.5 1.4 1.4-5.9 5.9Z"/>',
    idle: '<rect x="3.5" y="3.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
    err: '<path fill-rule="evenodd" fill="currentColor" d="M7 1.5h6L18.5 7v6L13 18.5H7L1.5 13V7ZM12.16 6.22 13.78 7.84 11.63 10 13.78 12.16 12.16 13.78 10 11.63 7.84 13.78 6.22 12.16 8.37 10 6.22 7.84 7.84 6.22 10 8.37Z"/>',
  };

  const shapeOf = (status) => SHAPE[status] || 'idle';
  // aria-hidden: status zawsze stoi obok jako tekst (karta, nagłówek terminala), ikona go nie dubluje dla czytnika
  const statusSvg = (status) => `<svg class="si-svg" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${PATH[shapeOf(status)]}</svg>`;

  const api = { SHAPE, LABEL, shapeOf, statusSvg, SHAPES: Object.keys(PATH) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatusIcons = api;
})(typeof window === 'undefined' ? globalThis : window);
