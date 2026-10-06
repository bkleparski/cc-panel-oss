(function (root) {
  'use strict';
  // Obrazy do czatu mózgu: co wysłać bez zmian, a co przekodować w przeglądarce do JPEG.
  // Claude i tak zmniejsza obraz do ~1568 px dłuższego boku - 2048 px zostawia zapas na czytelny zrzut ekranu.
  const MAX_EDGE = 2048, KEEP_BYTES = 2.5 * 1024 * 1024, MAX_BYTES = 10 * 1024 * 1024, MAX_FILES = 6, QUALITY = 0.85;
  const KEEP_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  function plan(type, size, width, height) {
    const edge = Math.max(width, height);
    if (KEEP_TYPES.includes(type) && size <= KEEP_BYTES && edge <= MAX_EDGE) return { reencode: false, width, height };
    const k = edge > MAX_EDGE ? MAX_EDGE / edge : 1;
    return { reencode: true, width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
  }
  const isImage = (file) => /^image\//.test(file.type || '') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name || '');
  // 1 obraz, 2-4 obrazy, 5+ obrazów (12-14 obrazów) - jak images_label w mozgd
  function imagesLabel(n) {
    if (n === 1) return '1 obraz';
    return `${n} ${[2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'obrazy' : 'obrazów'}`;
  }
  // „Pobierz” w podglądzie: share = arkusz udostępniania (iPhone/PWA: Zdjęcia, Pliki), download = zwykłe pobranie (desktop),
  // hold = tylko podpowiedź „przytrzymaj obraz”. iOS w trybie standalone ignoruje atrybut download i nawiguje całą
  // aplikację do pliku - widok bez paska i bez wstecz, z którego nie da się wyjść. Tam nigdy link do pliku.
  function saveMode({ canShareFiles, standalone, touch, ios }) {
    if (canShareFiles && (standalone || touch)) return 'share';
    if (ios && (standalone || touch)) return 'hold';
    return 'download';
  }
  // Rozmiar obrazu w podglądzie (px CSS) dla obszaru aw x ah. fit = cały obraz na ekranie, wide = na szerokość ekranu
  // (bez powiększania ponad naturalny rozmiar). Długi obraz (infografika z telefonu) w trybie fit byłby wąskim paskiem,
  // więc startuje od wide i przewija się w pionie. maxW = górna granica powiększenia (pinch, tapnięcie).
  function viewSize(nw, nh, aw, ah) {
    const s = Math.min(1, aw / nw, ah / nh);
    const fit = { w: Math.round(nw * s), h: Math.round(nh * s) };
    const wideW = Math.min(aw, nw);
    const wide = { w: Math.round(wideW), h: Math.round(nh * wideW / nw) };
    const long = fit.w < 0.6 * wide.w;
    const maxW = Math.round(Math.max(wide.w, Math.min(2 * Math.max(nw, aw), 4 * aw)));
    return { fit, wide, long, maxW, start: long ? wide.w : fit.w };
  }
  // Upuszczone / wklejone / wybrane pliki: co dołączyć, a co pominąć i dlaczego (type = nie obraz, limit = ponad MAX_FILES).
  // have = obrazy już dołączone do tej wiadomości.
  function triage(files, have = 0) {
    const take = [], skipped = [];
    for (const file of files) {
      if (!isImage(file)) skipped.push({ name: file.name || 'plik', why: 'type' });
      else if (have + take.length >= MAX_FILES) skipped.push({ name: file.name || 'obraz', why: 'limit' });
      else take.push(file);
    }
    return { take, skipped };
  }
  const names = (list) => {
    const shown = list.slice(0, 3).map(s => `„${s.name}”`).join(', ');
    return list.length > 3 ? `${shown} i ${list.length - 3} inne` : shown;
  };
  // Czytelny komunikat dla pominiętych plików (pusty, gdy nic nie pominięto).
  function skippedText(skipped) {
    const type = skipped.filter(s => s.why === 'type'), limit = skipped.filter(s => s.why === 'limit');
    const parts = [];
    if (type.length) parts.push(`Pominąłem ${names(type)} - Dyspozytor przyjmuje tylko obrazy (JPEG, PNG, WebP, HEIC), do 10 MB.`);
    if (limit.length) parts.push(`Limit ${MAX_FILES} obrazów w jednej wiadomości - pominąłem ${names(limit)}.`);
    return parts.join(' ');
  }
  const api = { plan, isImage, imagesLabel, saveMode, viewSize, triage, skippedText, MAX_EDGE, MAX_BYTES, MAX_FILES, QUALITY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MozgImages = api;
})(typeof window === 'undefined' ? globalThis : window);
