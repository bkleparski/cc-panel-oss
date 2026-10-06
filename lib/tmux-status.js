'use strict';
// Status sesji tmux z panelu: proces na pierwszym planie + ostatnie linie ekranu.
// herdr na pierwszym planie to tylko klient multipleksera (jego panele panel listuje osobno w sekcji herdr),
// a nie agent czekający na użytkownika - bez tego shell z otwartym herdr świecił „czeka na Ciebie” (05.10).
const APPROVAL_RE = /Do you want to (proceed|make this edit|create|run)|Would you like to run|Allow (this|command)|Yes, proceed|❯\s*1\.\s*Yes|\(y\/n\)|\[y\/N\]|Approve\?/i;
const NOT_AGENT_RE = /^(bash|zsh|sh|fish|herdr)$/;

function tmuxStatus(cmd, lines, idleSec) {
  if (NOT_AGENT_RE.test(cmd || '')) return 'shell';
  if (APPROVAL_RE.test(lines.slice(-15).join('\n'))) return 'approval';
  return idleSec < 4 ? 'working' : 'idle';
}

module.exports = { APPROVAL_RE, tmuxStatus };
