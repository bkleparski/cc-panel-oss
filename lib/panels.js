'use strict';
// Podpięte panele Herdr (mozgd panel_*): walidacja żądań z UI i błędy mozgd po polsku.
const SELECTOR_MAX = 200;
const quote = s => '„' + s + '”';

// błąd mozgd (ASCII, angielski albo bez znaków) -> komunikat dla użytkownika; titles: id wątku -> nazwa zakładki
function plError(message, titles = {}) {
  const m = String(message || '');
  const tab = id => titles[id] ? quote(titles[id]) : id;
  let r;
  if ((r = m.match(/^panel (\S+) jest juz podpiety do watku (\S+);/))) return `Panel ${r[1]} jest już podpięty do zakładki ${tab(r[2])} - najpierw go odepnij.`;
  if ((r = m.match(/^niejednoznaczna etykieta '(.*)': (.*) - podaj id panelu$/))) return `Etykieta ${quote(r[1])} pasuje do kilku paneli (${r[2]}) - wybierz panel po id.`;
  if ((r = m.match(/^nie znaleziono panelu '(.*)'$/))) return `Nie znalazłem panelu ${quote(r[1])} w Herdr - odśwież listę.`;
  if ((r = m.match(/^panel (\S+) nie istnieje$/))) return `Panel ${r[1]} nie istnieje już w Herdr - odśwież listę.`;
  if (m.startsWith('to panel mozgu')) return 'To panel mózgu (Dyspozytora) - takiego nie podpinam.';
  if (m.startsWith('to worker rotatora')) return 'To worker rotatora - nim zarządza rotator, nie da się go podpiąć.';
  if (m === 'panel nie jest podpiety') return 'Ten panel nie jest podpięty (ktoś go już odpiął?) - odśwież listę.';
  if (m === 'niejednoznaczny panel: podaj id panelu') return 'Kilka podpięć pasuje do tej nazwy - odepnij po id panelu.';
  if (m.startsWith('min_interval_min')) return 'Minimalny odstęp powiadomień: liczba minut od 1 do 1440.';
  if (m.startsWith('panel: podaj')) return 'Wybierz panel.';
  if (m === 'unknown or archived thread') return 'Zakładka nie istnieje albo jest zarchiwizowana.';
  if (m === 'register first' || m === 'invalid panel arguments') return 'Dyspozytor nie zna jeszcze podpinania z panelu - potrzebny restart mozgd.';
  if (m.startsWith('panels require')) return 'mozgd odrzucił połączenie (podpinanie tylko z konta właściciela).';
  if (m.startsWith('internal error')) return 'mozgd nie odczytał Herdr albo rotatora - spróbuj za chwilę.';
  return m;
}

// body POST /api/mozg/panels/bind -> parametry panel_bind albo { error }
function bindParams(body, threadIds) {
  if (!body || typeof body.panel !== 'string' || !body.panel.trim() || body.panel.length > SELECTOR_MAX) return { error: 'Wybierz panel.' };
  if (typeof body.thread_id !== 'string' || !threadIds.has(body.thread_id)) return { error: 'Wybierz istniejącą zakładkę.' };
  const params = { panel: body.panel, thread: body.thread_id };
  const min = body.min_interval_min;
  if (min !== undefined && min !== null && min !== '') {
    if (!Number.isInteger(min) || min < 1 || min > 1440) return { error: 'Minimalny odstęp powiadomień: liczba minut od 1 do 1440.' };
    params.min_interval_min = min;
  }
  return { params };
}

module.exports = { plError, bindParams };
