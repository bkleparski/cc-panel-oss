'use strict';
// Transkrypty Claude Code (~/.claude/projects/*/<sessionId>.jsonl): odszukanie, odczyt końcówki
// i podgląd „o co prosi” sesja czekająca na zgodę = ostatni tool_use bez pasującego tool_result.
//
// pendingTool/describe wzorowane na claudash src/transcript.rs::pending_in/describe
// (https://github.com/jguajardo/claudash, autor: jguajardo, licencja MIT OR Apache-2.0).
// Różnice: tool_use sprzed nowego polecenia użytkownika odpada (przerwana tura), opis jest
// jednolinijkowy, przycięty i z zamaskowanymi sekretami; push dostaje tylko krótką formę bez argumentów.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.env.HOME, '.claude', 'projects');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAIL = 2 * 1024 * 1024;

function findTranscript(id, root = ROOT) {
  if (!ID_RE.test(id || '')) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch {}
  for (const d of dirs) {
    const f = path.join(root, d, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function readTail(file, max = TAIL) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text; // pierwsza linia urwana
  } finally { fs.closeSync(fd); }
}

// tekst JSONL -> { name, input, count } (count = ile wywołań czeka naraz) albo null
function pendingTool(text) {
  let calls = [];
  for (const line of String(text || '').split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object' || r.isSidechain === true) continue;
    const content = r.message?.content;
    if (r.type === 'user' && !r.isMeta) {
      // nowe polecenie użytkownika (bez tool_result) zamyka poprzednią turę: jej osierocone tool_use nie czekają
      const blocks = Array.isArray(content) ? content : [];
      if (typeof content === 'string' || (blocks.length && !blocks.some((b) => b?.type === 'tool_result'))) calls = [];
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use') calls.push({ id: String(b.id || ''), name: String(b.name || 'tool'), input: b.input && typeof b.input === 'object' ? b.input : {} });
      else if (b?.type === 'tool_result') calls = calls.filter((c) => c.id !== b.tool_use_id);
    }
  }
  const last = calls.pop();
  return last ? { name: last.name, input: last.input, count: calls.length + 1 } : null;
}

// ---------- maskowanie i przycinanie ----------
const MASK = '•••';
const SECRET_KEY = '(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?key|credentials?|private[_-]?key|session[_-]?key)';
const SECRET_RES = [
  // nagłówki autoryzacji
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s'"]+/gi, `$1${MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  // klucz=wartość / "klucz": "wartość" / KLUCZ: wartość (także w nazwach zmiennych: GITHUB_TOKEN=…)
  [new RegExp(`(\\b[\\w.-]*${SECRET_KEY}[\\w.-]*["']?\\s*[:=]\\s*["']?)[^\\s"'&,;}]+`, 'gi'), `$1${MASK}`],
  // flagi: --password x, --token=x, -p'x' zostawiamy w spokoju (za dużo fałszywych trafień)
  [new RegExp(`(--?[\\w-]*${SECRET_KEY}[\\w-]*(?:=|\\s+))(?!-)["']?[^\\s"']+`, 'gi'), `$1${MASK}`],
  // hasło w URL: scheme://user:hasło@host
  [/(\b[a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // znane formaty tokenów
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // długie ciągi wyglądające na klucz: hex >= 32, base64url >= 32 z cyfrą, małą i wielką literą
  // (bez „/”, żeby nie łapać ścieżek)
  [/\b[0-9a-f]{32,}\b/gi, MASK],
  [/(?<![\w/.-])(?=[\w+-]*\d)(?=[\w+-]*[a-z])(?=[\w+-]*[A-Z])[A-Za-z0-9+_-]{32,}={0,2}(?![\w/.-])/g, MASK],
];
function mask(s) {
  let out = String(s || '');
  for (const [re, rep] of SECRET_RES) out = out.replace(re, rep);
  return out;
}

// jedna linia, białe znaki zwinięte, najwyżej max znaków (punkty kodowe, nie bajty)
function clip(s, max) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : one;
}

const HOME = process.env.HOME || '';
const shortPath = (p) => (HOME && String(p).startsWith(HOME + '/') ? '~' + String(p).slice(HOME.length) : String(p || ''));
const str = (v) => (typeof v === 'string' ? v : '');

// nazwa narzędzia do wyświetlenia: mcp__serwer__narzędzie -> serwer · narzędzie
function toolLabel(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1].replace(/^(?:claude_ai_|plugin_[^_]+_)/, '')} · ${m[2]}` : name;
}

// opis do panelu (za logowaniem): nazwa + najważniejszy argument, zamaskowany i przycięty
function detail(name, input, max) {
  switch (name) {
    case 'Bash': return clip('$ ' + mask(str(input.command)), max);
    case 'Edit': case 'MultiEdit': case 'Write': case 'Read': case 'NotebookEdit':
      return clip(mask(shortPath(str(input.file_path) || str(input.notebook_path))), max);
    case 'WebFetch': return clip(mask(str(input.url).replace(/[?#].*$/, '')), max);
    case 'WebSearch': return clip(mask(str(input.query)), max);
    case 'Glob': case 'Grep': return clip(mask(str(input.pattern)), max);
    case 'Task': case 'Agent': return clip(mask(str(input.description)), max);
    case 'AskUserQuestion': return clip(mask(str(input.questions?.[0]?.question)), max);
    case 'Skill': return clip(mask(str(input.skill)), max);
  }
  // inne (np. MCP): pierwsza tekstowa wartość wejścia
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return first ? clip(mask(first), max) : '';
}

// krótka forma do pusha (idzie przez telefon i serwery push): bez surowych argumentów
function shortForm(name, input) {
  const label = toolLabel(name);
  const base = (p) => path.basename(str(p));
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'Read': case 'NotebookEdit': {
      const f = base(input.file_path || input.notebook_path);
      return f ? `${label}: ${clip(mask(f), 40)}` : label;
    }
    case 'WebFetch': {
      try { return `${label}: ${new URL(str(input.url)).hostname}`; } catch { return label; }
    }
    default: return label;
  }
}

// { name, input, count } -> { tool, text, short, count }
function describe(tool, max = 160) {
  const input = tool.input || {};
  const text = detail(tool.name, input, max);
  const label = toolLabel(tool.name);
  return { tool: tool.name, text: text ? `${label}: ${text}` : label, short: shortForm(tool.name, input), count: tool.count || 1 };
}

// podgląd dla sesji o danym id; brak transkryptu / nieznany format / nic nie czeka = null.
// Cache po rozmiarze i czasie zmiany pliku: lista sesji odświeża się co 3 s.
const cache = new Map(); // plik -> { size, mtimeMs, ask }
function pendingAsk(id, root = ROOT) {
  try {
    const file = findTranscript(id, root);
    if (!file) return null;
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.ask;
    const tool = pendingTool(readTail(file, 512 * 1024));
    const ask = tool ? describe(tool) : null;
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, ask });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return ask;
  } catch { return null; }
}

module.exports = { findTranscript, readTail, pendingTool, describe, mask, clip, pendingAsk };
