// Wyszukiwanie na liście sesji: bez wielkości liter i bez polskich znaków ("zrodla" znajduje "źródła"),
// wiele słów = wszystkie muszą pasować (AND, każde w dowolnym polu).
(function (root) {
  'use strict';
  const EXTRA = { 'ł': 'l', 'Ł': 'l', 'ø': 'o', 'Ø': 'o', 'ß': 'ss', 'đ': 'd', 'Đ': 'd' };
  const foldChar = ch => EXTRA[ch] || ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  // tekst po normalizacji + dla każdego jego znaku zakres [start, end) w oryginale (do wyróżniania)
  function fold(text) {
    let out = '';
    const start = [], end = [];
    let i = 0;
    for (const ch of String(text ?? '')) {
      const f = foldChar(ch);
      for (let k = 0; k < f.length; k++) { start.push(i); end.push(i + ch.length); }
      out += f;
      i += ch.length;
    }
    return { text: out, start, end };
  }
  const normalize = text => fold(text).text;
  const parse = query => [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
  function matches(texts, tokens) {
    if (!tokens.length) return true;
    const hay = texts.filter(t => t != null && t !== '').map(normalize).join('\n');
    return tokens.every(t => hay.includes(t));
  }
  // posortowane, scalone zakresy trafień [start, end) w oryginalnym tekście
  function ranges(text, tokens) {
    if (!tokens.length || !text) return [];
    const f = fold(text), found = [];
    for (const t of tokens) {
      for (let i = f.text.indexOf(t); i !== -1; i = f.text.indexOf(t, i + 1)) found.push([f.start[i], f.end[i + t.length - 1]]);
    }
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const r of found) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    return merged;
  }
  const api = { normalize, parse, matches, ranges };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionSearch = api;
})(typeof window === 'undefined' ? globalThis : window);
