// Polecenia „! …” z ostatnich odpowiedzi Claude, czytane z transkryptu JSONL.
// Historia terminala się nie nadaje: Claude przerysowuje ekran (herdr trzyma kilkadziesiąt linii)
// i zawija tekst do szerokości telefonu, a transkrypt ma dokładny tekst odpowiedzi.
const AgentCmds = require('../public/agent-cmds');
const { findTranscript, readTail } = require('./transcript');

function extract(md) {
  const out = [];
  // bloki kodu: każda linia zaczynająca się od „!”
  for (const block of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const l of block[1].split('\n')) if (/^\s*!\s*\S/.test(l)) out.push(l.trim());
  }
  // kod w linii: `! polecenie`
  for (const m of md.replace(/```[\s\S]*?```/g, '').matchAll(/`(!\s*[^`\n]+)`/g)) out.push(m[1].trim());
  return out;
}

// teksty ostatnich odpowiedzi Claude, najstarsza pierwsza
function lastReplies(id, maxMsgs) {
  const file = findTranscript(id);
  if (!file) return [];
  const lines = readTail(file).split('\n');
  const texts = [];
  for (let i = lines.length - 1; i >= 0 && texts.length < maxMsgs; i--) {
    let j;
    try { j = JSON.parse(lines[i]); } catch { continue; }
    if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    const text = j.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (text) texts.unshift(text);
  }
  return texts;
}

// najnowsze na końcu, bez powtórzeń
function bangCommands(id, maxMsgs = 10, max = 15) {
  const found = lastReplies(id, maxMsgs).flatMap(extract);
  const seen = new Set();
  const uniq = [];
  for (let k = found.length - 1; k >= 0; k--) {
    const c = found[k].replace(/^!\s*/, '! ');
    if (!seen.has(c)) { seen.add(c); uniq.unshift(c); }
  }
  return uniq.slice(-max);
}

// karty poleceń (linie „!”, bloki bash/sh/powershell) z ostatnich odpowiedzi: najnowsze na końcu, bez powtórzeń
function commandBlocks(id, maxMsgs = 10, max = 15) {
  const found = lastReplies(id, maxMsgs).flatMap((t) => AgentCmds.extract(t));
  const seen = new Set();
  const uniq = [];
  for (let k = found.length - 1; k >= 0; k--) {
    if (!seen.has(found[k].text)) { seen.add(found[k].text); uniq.unshift(found[k]); }
  }
  return uniq.slice(-max);
}

module.exports = { bangCommands, commandBlocks };
