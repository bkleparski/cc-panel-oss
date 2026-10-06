// Widok CHAT (05.10): kafelki Claude i ChatGPT. Bez iframe - oba serwisy blokują osadzanie.
// iPhone/iPad: ścieżki, które są universal linkami w AASA domen (sprawdzone 05.10), więc iOS otwiera natywną aplikację:
//   claude.ai/new      -> aplikacja Claude; bez aplikacji nowa rozmowa w przeglądarce
//   chatgpt.com/open-app -> aplikacja ChatGPT; bez aplikacji serwer przekierowuje do App Store
// Strony główne obu domen NIE są universal linkami, więc link "w przeglądarce" (iOS) to po prostu strona główna.
// Komputer: strona główna; CC Panel.app na Macu przechwytuje ją po stronie powłoki i otwiera natywną aplikację
// (open -b), a bez niej własne okno. Zwykła przeglądarka na komputerze: nowa karta.
(function (root) {
  'use strict';
  const SERVICES = [
    { id: 'claude', name: 'Claude', mark: 'C', host: 'claude.ai', web: 'https://claude.ai/', app: 'https://claude.ai/new',
      appName: 'aplikację Claude', noApp: 'nowa rozmowa w przeglądarce' },
    { id: 'chatgpt', name: 'ChatGPT', mark: 'G', host: 'chatgpt.com', web: 'https://chatgpt.com/', app: 'https://chatgpt.com/open-app',
      appName: 'aplikację ChatGPT', noApp: 'App Store' },
  ];

  // iPadOS 13+ udaje Maca (MacIntel) - odróżnia go ekran dotykowy; Mac z CC Panel.app ma maxTouchPoints = 0
  function isIOS(nav) {
    if (!nav) return false;
    const ua = String(nav.userAgent || '');
    return /iPhone|iPad|iPod/.test(ua) || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
  }

  // macApp: strona działa w CC Panel.app (powłoka wstrzykuje window.CCPDesktop)
  function tiles(ios, macApp) {
    return SERVICES.map((s) => ({
      id: s.id, name: s.name, mark: s.mark, host: s.host,
      href: ios ? s.app : s.web,
      web: ios ? s.web : null, // drugi link tylko na iOS, na komputerze byłby tym samym adresem
      hint: ios ? `Otwiera ${s.appName} (bez aplikacji: ${s.noApp})`
        : macApp ? `Otwiera ${s.appName} na Macu`
        : `Otwiera ${s.host} w nowej karcie`,
    }));
  }

  const api = { SERVICES, isIOS, tiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatLinks = api;
})(typeof window === 'undefined' ? globalThis : window);
