'use strict';
// Maszyny, na których panel może uruchamiać sesje: lokalna (kontener) + zdalne przez SSH.
// Konfiguracja: ~/.config/cc-panel/machines.json, np.
//   { "fedora": { "ssh": "fedora", "python": "/usr/bin/python3" } }
// Zdalnie wywoływany jest cc-remote.py (JSON na stdin), połączenia SSH są współdzielone (ControlMaster).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REMOTE_SCRIPT = '.local/share/cc-report/cc-remote.py';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=15',
  '-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/ccp-ssh-%C', '-o', 'ControlPersist=600'];

function loadMachines(cfgDir) {
  const file = path.join(cfgDir, 'machines.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [name, m] of Object.entries(cfg)) {
      if (/^[A-Za-z0-9._-]{1,40}$/.test(name) && m?.ssh) {
        out[name] = { ssh: String(m.ssh), python: m.python || 'python3' };
      }
    }
    return out;
  } catch { return {}; }
}

function remoteCall(machine, req, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', [...SSH_OPTS, machine.ssh, machine.python, REMOTE_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { p.kill('SIGKILL'); finish(reject, new Error('Przekroczony czas połączenia z maszyną')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => finish(reject, e));
    // ssh może umrzeć, zanim przyjmie stdin (EPIPE) — nieobsłużony błąd strumienia położyłby cały panel
    p.stdin.on('error', () => {});
    p.on('close', () => {
      let j;
      try { j = JSON.parse(out); } catch { return finish(reject, new Error((err || out || 'brak odpowiedzi').trim().slice(0, 300))); }
      if (j.error) return finish(reject, new Error(j.error));
      finish(resolve, j);
    });
    p.stdin.end(JSON.stringify(req));
  });
}

// argumenty do ssh -tt dla bezpośredniego podłączenia terminala herdr
function attachArgs(machine, terminalId) {
  if (!/^term_[0-9a-f]+$/.test(terminalId)) throw new Error('Zły identyfikator terminala');
  return [...SSH_OPTS, '-tt', machine.ssh, `~/.local/bin/herdr terminal attach ${terminalId}`];
}

module.exports = { loadMachines, remoteCall, attachArgs };
