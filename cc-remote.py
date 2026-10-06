#!/usr/bin/env python3
"""cc-remote: zdalne operacje cc-panel na tej maszynie, wywoływane przez SSH z kontenera coding.

Polecenie przychodzi jako JSON na stdin (bez cytowania w powłoce), wynik wraca jako JSON na stdout:
  {"op": "herdr", "args": [...], "timeout": 8}   -> {"code", "stdout", "stderr"}
  {"op": "dirs", "path": "rel"}                  -> {"root", "path", "dirs"}
  {"op": "search", "q": "tekst"}                 -> {"root", "dirs"}
  {"op": "mkdir", "path": "rel"}                 -> {"dir"}
  {"op": "resolve", "path": "rel"}               -> {"abs"}
Ścieżki są względne wobec ~/Projekty (albo ~, jeśli go nie ma) i nie mogą z niego wyjść.
Tylko biblioteka standardowa.
"""
import json, os, shutil, subprocess, sys, unicodedata
from pathlib import Path

HOME = Path.home()
ROOT = HOME / 'Projekty' if (HOME / 'Projekty').is_dir() else HOME
SKIP = {'node_modules', 'venv', '__pycache__', 'dist', 'build', 'target', 'vendor'}
MAX_DEPTH = 5


def herdr_bin():
    for p in (HOME / '.local' / 'bin' / 'herdr', Path('/usr/local/bin/herdr'), Path('/opt/homebrew/bin/herdr')):
        if p.exists():
            return str(p)
    return shutil.which('herdr') or 'herdr'


def parts_of(rel):
    parts = [p.strip() for p in str(rel or '').split('/') if p.strip()]
    for p in parts:
        if p in ('.', '..') or p.startswith('.') or '\\' in p or len(p) > 100 or any(ord(c) < 32 for c in p):
            raise ValueError('Niedozwolona nazwa: ' + p)
    return parts


def is_dir(p):
    try:
        return p.is_dir()
    except OSError:
        return False


def children(path):
    try:
        entries = sorted(os.scandir(path), key=lambda e: e.name.lower())
    except OSError:
        return []
    return [e.name for e in entries if not e.name.startswith('.') and e.name not in SKIP and is_dir(Path(e.path))]


def fold(s):
    s = unicodedata.normalize('NFD', s.lower().replace('ł', 'l'))
    return ''.join(c for c in s if not unicodedata.combining(c))


def index():
    out = []

    def walk(path, rel, depth):
        try:
            entries = list(os.scandir(path))
        except OSError:
            return
        repo = depth > 1 and any(e.name == '.git' for e in entries)
        for e in entries:
            if e.name.startswith('.') or e.name in SKIP or not is_dir(Path(e.path)):
                continue
            r = f'{rel}/{e.name}' if rel else e.name
            out.append(r)
            if depth < MAX_DEPTH and not repo:
                walk(e.path, r, depth + 1)
    walk(ROOT, '', 1)
    return out


def search(q):
    terms = [t for t in fold(q).replace('/', ' ').split() if t]
    dirs = index()
    if not terms:
        return sorted(d for d in dirs if '/' not in d)
    scored = []
    for d in dirs:
        fd = fold(d)
        if not all(t in fd for t in terms):
            continue
        base, last = fd.rsplit('/', 1)[-1], terms[-1]
        rank = 0 if base == last else 1 if base.startswith(last) else 2 if last in base else 3
        scored.append((rank * 1000 + d.count('/') * 50 + len(d), d))
    return [d for _, d in sorted(scored)[:40]]


def main():
    req = json.load(sys.stdin)
    op = req.get('op')
    if op == 'herdr':
        args = [str(a) for a in req.get('args', [])]
        try:
            p = subprocess.run([herdr_bin(), *args], capture_output=True, text=True, timeout=float(req.get('timeout', 8)))
            return {'code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}
        except subprocess.TimeoutExpired:
            return {'code': 124, 'stdout': '', 'stderr': 'timeout'}
    if op == 'dirs':
        parts = parts_of(req.get('path'))
        target = ROOT.joinpath(*parts)
        if not is_dir(target):
            raise ValueError('Brak katalogu: ' + '/'.join(parts))
        return {'root': str(ROOT), 'path': '/'.join(parts), 'dirs': children(target)}
    if op == 'search':
        return {'root': str(ROOT), 'dirs': search(req.get('q', ''))}
    if op == 'mkdir':
        parts = parts_of(req.get('path'))
        if not parts:
            raise ValueError('Podaj nazwę katalogu')
        ROOT.joinpath(*parts).mkdir(parents=True, exist_ok=True)
        return {'dir': '/'.join(parts)}
    if op == 'resolve':
        parts = parts_of(req.get('path'))
        target = ROOT.joinpath(*parts)
        if not is_dir(target):
            raise ValueError('Brak katalogu: ' + str(target))
        return {'abs': str(target)}
    raise ValueError('Nieznana operacja: ' + str(op))


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as e:  # błąd wraca jako JSON, żeby panel mógł go pokazać
        print(json.dumps({'error': str(e)}))
