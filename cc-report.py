#!/usr/bin/env python3
"""cc-report: co kilkanaście sekund wysyła do cc-panel listę działających sesji Claude Code
(rejestr ~/.claude/sessions) i Codex (procesy z otwartym plikiem rollout) z tej maszyny.
Tylko biblioteka standardowa.

Konfiguracja w ~/.config/cc-report/config (klucz=wartość):
  url=https://panel.example.com/report   (tylko HTTPS: token idzie w nagłówku)
  token=<zawartość ~/.config/cc-panel/report-token z kontenera coding>
  host=fedora             (opcjonalnie, domyślnie nazwa hosta; musi być w machines.json panelu)
  interval=20             (opcjonalnie, sekundy)
"""
import json, os, re, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

CFG = Path.home() / '.config' / 'cc-report' / 'config'
SESSIONS = Path.home() / '.claude' / 'sessions'
FIELDS = ('pid', 'sessionId', 'name', 'nameSource', 'cwd', 'version', 'status', 'startedAt', 'updatedAt', 'statusUpdatedAt', 'bridgeSessionId')


def load_config():
    cfg = {}
    for line in CFG.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1)
            cfg[k.strip()] = v.strip()
    return cfg


def proc_start(pid):
    """Czas startu procesu w formacie, jaki Claude Code zapisuje jako procStart."""
    if sys.platform.startswith('linux'):
        try:
            stat = Path(f'/proc/{pid}/stat').read_text()
            return stat[stat.rindex(')') + 2:].split(' ')[19]
        except (OSError, ValueError, IndexError):
            return None
    try:
        out = subprocess.run(['ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True, text=True, timeout=5,
                             env={**os.environ, 'TZ': 'UTC', 'LC_ALL': 'C'})  # Claude zapisuje procStart w UTC
        return ' '.join(out.stdout.split()) or None
    except (OSError, subprocess.SubprocessError):
        return None


def alive_sessions():
    out = []
    for f in SESSIONS.glob('*.json'):
        try:
            j = json.loads(f.read_text())
            pid = int(j['pid'])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        start = proc_start(pid)
        if start is None:
            continue
        want = j.get('procStart')
        if want and ' '.join(str(want).split()) != start:
            continue  # PID przejęty przez inny proces
        out.append({k: j[k] for k in FIELDS if k in j})
    return out


# ---------- Codex: sesja = proces codex z otwartym plikiem rollout ----------
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
ROLLOUT_RE = re.compile(r'/\.codex/sessions/.*rollout-.*?(' + UUID + r')\.jsonl$')
CWD_RE = re.compile(r'"cwd":"((?:[^"\\]|\\.)*)"')


def read_chunk(path, from_end, size):
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            total = f.tell()
            n = min(size, total)
            f.seek(total - n if from_end else 0)
            return f.read(n).decode('utf-8', 'replace')
    except OSError:
        return ''


def codex_thread_names():
    names = {}
    for line in read_chunk(Path.home() / '.codex' / 'session_index.jsonl', True, 1 << 20).splitlines():
        try:
            j = json.loads(line)
            if j.get('id') and j.get('thread_name'):
                names[j['id']] = j['thread_name']
        except ValueError:
            pass
    return names


def is_app_server(pid):
    """Serwer zdalnego sterowania Codexa (codex app-server) trzyma kilka wątków naraz."""
    try:
        if sys.platform.startswith('linux'):
            return b'app-server' in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        out = subprocess.run(['ps', '-o', 'args=', '-p', str(pid)], capture_output=True, text=True, timeout=5).stdout
        return ' app-server' in out
    except (OSError, subprocess.SubprocessError):
        return False


def codex_rollouts():
    """[(pid, ścieżka rollout, app_server)] dla działających procesów codex."""
    per_pid = {}
    if sys.platform.startswith('linux'):
        for pid in filter(str.isdigit, os.listdir('/proc')):
            try:
                if Path(f'/proc/{pid}/comm').read_text().strip() != 'codex':
                    continue
                for fd in os.listdir(f'/proc/{pid}/fd'):
                    target = os.readlink(f'/proc/{pid}/fd/{fd}')
                    if ROLLOUT_RE.search(target):
                        per_pid.setdefault(int(pid), []).append(target)
            except OSError:
                continue
    else:
        try:
            out = subprocess.run(['lsof', '-n', '-w', '-Fpn', '-c', 'codex'], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        pid = None
        for line in out.splitlines():
            if line.startswith('p'):
                pid = int(line[1:])
            elif line.startswith('n') and ROLLOUT_RE.search(line[1:]):
                per_pid.setdefault(pid, []).append(line[1:])
    found = []
    for pid, paths in per_pid.items():
        app = is_app_server(pid)
        for path in dict.fromkeys(paths) if app else paths[:1]:
            found.append((pid, path, app))
    return found


def codex_status(path):
    first, phase = '', ''
    for line in reversed(read_chunk(path, True, 65536).splitlines()):
        try:
            j = json.loads(line)
        except ValueError:
            continue
        t = (j.get('payload') or {}).get('type') or j.get('type') or ''
        if t == 'token_count' or j.get('type') == 'token_usage_record':
            continue
        first = first or t
        if t in ('task_started', 'task_complete', 'turn_aborted'):
            phase = t
            break
    if 'approval_request' in first:
        return 'approval'
    if phase == 'task_started':
        return 'working'
    if phase:
        return 'idle'
    try:
        return 'working' if time.time() - os.path.getmtime(path) < 10 else 'idle'
    except OSError:
        return 'idle'


def codex_sessions():
    names = codex_thread_names()
    out = []
    for pid, path, app in codex_rollouts():
        sid = ROLLOUT_RE.search(path).group(1)
        head = read_chunk(path, False, 32768)
        m = CWD_RE.search(head)
        meta = {}
        for line in head.splitlines():
            try:
                record = json.loads(line)
                if record.get('type') == 'session_meta':
                    meta = record.get('payload') or {}
                    break
            except ValueError:
                pass
        source = meta.get('source')
        subagent = bool(meta.get('parent_thread_id') or (isinstance(source, dict) and source.get('subagent')))
        try:
            cwd = json.loads('"' + m.group(1) + '"') if m else ''
            updated = os.path.getmtime(path)
        except (ValueError, OSError):
            cwd, updated = '', 0
        out.append({'pid': pid, 'id': sid, 'title': names.get(sid, ''), 'cwd': cwd,
                    'status': codex_status(path), 'updated': updated, 'appServer': app, 'subagent': subagent, 'parentThreadId': meta.get('parent_thread_id', '')})
    return out


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Przekierowanie mogłoby przenieść POST z nagłówkiem Authorization na HTTP albo obcy host - odrzucamy każde."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f'przekierowanie odrzucone: {newurl}', headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)


def main():
    cfg = load_config()
    if not cfg.get('url', '').startswith('https://'):
        sys.exit('cc-report: url musi zaczynać się od https:// (token nie może iść otwartym tekstem)')
    host = cfg.get('host') or socket.gethostname().split('.')[0]
    interval = int(cfg.get('interval', 20))
    once = '--once' in sys.argv
    while True:
        try:
            body = json.dumps({'host': host, 'sessions': alive_sessions(), 'codex': codex_sessions()}).encode()
            req = urllib.request.Request(cfg['url'], data=body, method='POST', headers={
                'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg['token']})
            with OPENER.open(req, timeout=10) as r:
                if once:
                    print(r.status, r.read().decode())
        except Exception as e:  # sieć/serwer chwilowo niedostępne: próbuj dalej
            print(f'cc-report: {e}', file=sys.stderr, flush=True)
            if once:
                sys.exit(1)
        if once:
            return
        time.sleep(interval)


if __name__ == '__main__':
    main()
