// Polecenia od agentów do wykonania przez użytkownika: wykrywanie w tekście odpowiedzi (czat Dyspozytora, transkrypt Claude),
// ostrzeżenia przed destrukcją, sekwencja klawiszy trybu „!” w Claude Code. Czyste funkcje (UMD), testy w test/agent-cmds.test.js.
// Wykonanie zawsze w otwartym terminalu sesji, po potwierdzeniu w UI - ten moduł niczego nie wysyła.
(function (root) {
  'use strict';
  const MAX = 12;            // kart na jedną wiadomość
  const MAX_CHARS = 20000;   // dłuższy „blok poleceń” to raczej log albo plik
  const BANG_DELAY = 150;    // Claude Code wchodzi w tryb bash tylko po osobno wpisanym „!”
  const ENTER_DELAY = 80;    // jak pole „Wiadomość do agenta”

  // jak ClipHistory.clean: ESC i inne znaki sterujące nie mogą dojść do terminala (zostają \t i \n)
  const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '');

  const SH = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shell-session', 'terminal']);
  const PS = new Set(['powershell', 'pwsh', 'ps1', 'ps', 'posh']);
  const langOf = (tag) => { const t = String(tag || '').trim().toLowerCase().split(/[\s{]/)[0]; return SH.has(t) ? 'sh' : PS.has(t) ? 'ps' : t ? 'other' : ''; };

  // „! cmd” w kodzie w linii albo jako początek linii listy; sama „!” albo „!!” w zdaniu to nie polecenie
  const BANG_LINE = /^\s*(?:[-*•⏺●›]\s+|\d+[.)]\s+)?(?:[^`!\n]{0,40}?:\s+)?!\s*([~./$\w"'][^\n]*)$/;
  const trimBlock = (lines) => {
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines;
  };

  // blok kodu -> polecenia: linie „! …” osobno; „console” tylko linie z „$ ”; bash/sh/powershell = cały blok jako jedno
  function fromBlock(lang, body) {
    const lines = trimBlock(body.split('\n'));
    if (!lines.length) return [];
    const bangs = lines.filter((l) => /^\s*!\s*\S/.test(l));
    if (bangs.length && bangs.length === lines.filter((l) => l.trim() && !/^\s*#/.test(l)).length) {
      return bangs.map((l) => ({ text: l.replace(/^\s*!\s*/, '').trim(), lang: 'sh', bang: true }));
    }
    const kind = langOf(lang);
    if (kind !== 'sh' && kind !== 'ps') return [];
    const prompts = lines.filter((l) => /^\s*\$\s+\S/.test(l));
    if (prompts.length && (lang.trim().toLowerCase().startsWith('console') || prompts.length === lines.filter((l) => l.trim()).length)) {
      return [{ text: prompts.map((l) => l.replace(/^\s*\$\s+/, '').trimEnd()).join('\n'), lang: 'sh', bang: false }];
    }
    return [{ text: lines.map((l) => l.trimEnd()).join('\n'), lang: kind, bang: false }];
  }

  // Wykrywanie w markdownie agenta. Wynik: [{text, lang: 'sh'|'ps', bang, multi}], kolejność jak w tekście, bez powtórzeń.
  function extract(md) {
    const src = clean(md);
    const found = [];
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    let last = 0, m;
    const inline = (part) => {
      for (const line of part.split('\n')) {
        const codes = [...line.matchAll(/`(!\s*[^`\n]+)`/g)];
        if (codes.length) { for (const c of codes) found.push({ text: c[1].replace(/^!\s*/, '').trim(), lang: 'sh', bang: true }); continue; }
        const b = line.match(BANG_LINE);
        if (b && !line.includes('`')) found.push({ text: b[1].trim(), lang: 'sh', bang: true });
      }
    };
    while ((m = re.exec(src))) {
      inline(src.slice(last, m.index));
      found.push(...fromBlock(m[1], m[2]));
      last = re.lastIndex;
    }
    inline(src.slice(last));
    const seen = new Set();
    const out = [];
    for (const c of found) {
      if (!c.text || c.text.length > MAX_CHARS || seen.has(c.text)) continue;
      seen.add(c.text);
      out.push({ ...c, multi: c.text.includes('\n') });
      if (out.length >= MAX) break;
    }
    return out;
  }

  // Kod w linii, który wygląda na polecenie: słowo/ścieżka + argumenty albo sama ścieżka do uruchomienia.
  // Nie: identyfikatory (task_…, ho_…), same nazwy plików, liczby, zdania.
  const CMD_HEAD = /^(?:sudo\s+)?(?:[a-z][\w.+-]*|~?\.{0,2}\/[\w./~*-]+)(?:\s|$)/;
  const looksLikeCmd = (t) => CMD_HEAD.test(t) && (/\s/.test(t) || /^~?\.{0,2}\//.test(t)) && !/^[a-z]+_\w+$/.test(t);
  // „1. `cmd` (backup)”, „2) Mac: `cmd`”, „- `cmd` - na pytanie odpowiedz n” - kod na początku punktu listy.
  // Etykieta przed kodem tylko w numerowanej („- Przyczyna: `funes update`” to opis, nie krok do zrobienia).
  const LIST_CMD = /^\s*(?:\d+[.)]\s+(?:[^`\n]{0,40}?:\s+)?|[-*•]\s+)`([^`\n]+)`(.*)$/;
  const noteOf = (rest) => rest.trim().replace(/^[-–—:]\s*/, '').replace(/^\((.*)\)$/, '$1').trim();

  // Desktop (MacBook): wszystko, co agent podał do skopiowania i wpisania samemu - wynik extract() bez „! ” plus
  // punkty list zaczynające się od kodu, który wygląda na polecenie. Tylko „Kopiuj”: ścieżka „Uruchom” zostaje przy extract().
  // Wynik: [{text, lang, bang, multi, run, note}] - run = to samo polecenie jest w extract() (ma karty Wstaw/Uruchom).
  function copyables(md) {
    const strict = extract(md);
    const byText = new Map(strict.map((c) => [c.text, c]));
    const src = clean(md).replace(/```[^\n`]*\n[\s\S]*?```/g, (b) => b.replace(/[^\n]/g, ' '));
    const found = [];
    for (const line of src.split('\n')) {
      const m = line.match(LIST_CMD);
      if (!m) continue;
      const text = m[1].replace(/^!\s*/, '').trim();
      if (byText.has(text) || looksLikeCmd(text)) found.push({ text, note: noteOf(m[2]) });
    }
    const seen = new Set();
    const out = [];
    const push = (c) => {
      if (!c.text || seen.has(c.text) || out.length >= MAX) return;
      seen.add(c.text);
      out.push(c);
    };
    // kolejność jak w tekście: punkty listy w miejscu, w którym stoją, reszta extract() w swojej kolejności
    const listed = new Set(found.map((f) => f.text));
    let si = 0;
    const flushStrict = (until) => {
      while (si < strict.length && strict[si].text !== until) {
        const s = strict[si++];
        if (!listed.has(s.text)) push({ ...s, run: true, note: '' });
      }
      if (until !== undefined && si < strict.length) si++;
    };
    for (const f of found) {
      if (seen.has(f.text)) continue;
      const s = byText.get(f.text);
      if (s) { flushStrict(s.text); push({ ...s, run: true, note: f.note }); }
      else push({ text: f.text, lang: 'sh', bang: false, multi: false, run: false, note: f.note });
    }
    flushStrict(undefined);
    return out;
  }

  // Treść do „Kopiuj wszystkie”: polecenia w kolejności, każde od nowej linii (bez „! ” i bez numeracji)
  const copyAll = (list) => list.map((c) => c.text).join('\n');

  // rm z flagami r i f w dowolnym układzie: -rf, -fr, -r -f, -Rf, --recursive --force (także po sudo, w potoku, po ;)
  function rmRecursiveForce(t) {
    for (const m of t.matchAll(/(?:^|[\s;&|(`'"])rm((?:\s+-{1,2}[\w-]+)+)/g)) {
      const flags = m[1].trim().split(/\s+/);
      const short = flags.filter((f) => /^-[^-]/.test(f)).join('');
      const r = /[rR]/.test(short) || flags.includes('--recursive');
      const f = /f/.test(short) || flags.includes('--force');
      if (r && f) return true;
    }
    return false;
  }
  // Oznaki destrukcji -> czerwone ostrzeżenie w potwierdzeniu (nie blokada: decyduje użytkownik)
  const DANGER = [
    [rmRecursiveForce, 'rm -rf (rekurencyjne kasowanie)'],
    [/(?:^|\s)--delete(?:-[a-z-]+)?\b/, '--delete (kasowanie po stronie celu)'],
    [/\bgit\s+push\b[^\n]*(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/, 'git push --force (nadpisanie historii)'],
    [/\bdrop\s+(?:table|database|schema|index|view|user|role)\b|\bdropdb\b|\bdocker\s+(?:volume|network)\s+rm\b|\bdocker\s+(?:system|volume|image)\s+prune\b/i, 'drop / prune (usunięcie danych)'],
    [/\bmkfs(?:\.\w+)?\b|\bwipefs\b|\bshred\b|\bfdisk\b|\bparted\b|\bsgdisk\b/, 'mkfs / wipefs / partycje (formatowanie dysku)'],
    [/(?:^|[\s;&|(])dd\s+[^\n]*\bof=/, 'dd of= (zapis bezpośrednio na urządzenie/plik)'],
    [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f)/, 'git reset --hard / clean -f (utrata zmian)'],
    [/>\s*\/dev\/(?:sd|nvme|vd|xvd|mmcblk|disk)/, 'zapis na urządzenie blokowe'],
    [/\btruncate\s+[^\n]*-s\s*0\b|\bRemove-Item\b[^\n]*-Recurse|\bFormat-Volume\b|\bClear-Disk\b/i, 'kasowanie / formatowanie (PowerShell, truncate)'],
  ];
  function danger(text) {
    const t = clean(text);
    return DANGER.filter(([test]) => (typeof test === 'function' ? test(t) : test.test(t))).map(([, why]) => why);
  }

  // Wieloliniowe polecenie = jedna linia `bash -c $'…'`: jedno wejście w tryb „!”, jeden wynik dla agenta,
  // semantyka skryptu (linie po kolei, kontynuacje „\” działają), bez pliku tymczasowego na serwerze.
  const ansiQuote = (s) => "$'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'";
  function bashLine(text) {
    const t = clean(text).trim();
    return t.includes('\n') ? `bash -c ${ansiQuote(t)}` : t;
  }

  // Klawisze do wysłania do panelu: [{d, wait}] - wait = ms przed tym zapisem.
  // run: „!”, 150 ms, polecenie, 80 ms, Enter. insert: to samo bez Entera (użytkownik widzi polecenie w trybie bash i sam wciska ⏎).
  // shell=false (np. PowerShell albo agent bez „!”): zwykła wklejka bez Entera.
  function steps(text, { mode = 'run', bang = true } = {}) {
    if (!bang) {
      const body = clean(text).replace(/\n/g, '\r');
      return body.trim() ? [{ d: `\x1b[200~${body}\x1b[201~`, wait: 0 }] : [];
    }
    const line = bashLine(text);
    if (!line) return [];
    const out = [{ d: '!', wait: 0 }, { d: line, wait: BANG_DELAY }];
    if (mode === 'run') out.push({ d: '\r', wait: ENTER_DELAY });
    return out;
  }

  // Czy wolno uruchomić/wstawić w sesji o danym statusie (statusy z app.js: idle, done, bg, working, approval, shell).
  // „prosi o zgodę”: Enter zatwierdziłby okno uprawnień - nigdy. Pracuje: tylko wstawienie (bez Entera).
  function allowed({ kind, status, readOnly }, mode, lang = 'sh') {
    if (readOnly) return { ok: false, why: 'Panel Dyspozytora jest tylko do podglądu.' };
    if (mode === 'run' && kind !== 'claude') return { ok: false, why: 'Uruchamianie przez „!” działa tylko w sesji Claude Code.' };
    if (mode === 'run' && lang === 'ps') return { ok: false, why: 'To polecenie PowerShell - sesje Claude działają na Linuksie. Skopiuj je albo wstaw.' };
    if (status === 'approval') return { ok: false, why: 'Sesja prosi o zgodę - Enter zatwierdziłby to okno. Najpierw odpowiedz agentowi.' };
    if (status === 'shell' && mode === 'run') return { ok: false, why: 'W panelu nie działa agent.' };
    if (status === 'working' && mode === 'run') return { ok: false, why: 'Agent pracuje - poczekaj, aż skończy turę.' };
    return { ok: true, why: '' };
  }

  const api = { extract, copyables, copyAll, looksLikeCmd, danger, bashLine, steps, allowed, clean, langOf, MAX, BANG_DELAY, ENTER_DELAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentCmds = api;
})(typeof window === 'undefined' ? globalThis : window);
