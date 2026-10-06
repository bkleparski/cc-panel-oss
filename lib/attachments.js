'use strict';
// Załączniki czatu mózgu: obrazy od użytkownika dla workerów i od workerów (kopie robi mozgd) do użytkownika - jeden katalog.
// Poza ~/Projekty i Syncthing, katalog 0700, pliki 0600.
// mozgd wylicza ścieżkę z id sam (<dir>/<id>.<ext>) i sprawdza sha256 - panel podaje tylko id, typ i hash.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PER_MESSAGE = 6;
const RETENTION_DAYS = 30;
const ID_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FILE_RE = /^[0-9a-f]{32}\.(jpg|png|webp)$/;

// Typ z sygnatury pliku, nie z nagłówka klienta.
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(buf.toString('latin1', 8, 12))) return 'image/heic';
  return null;
}

// Katalog i retencja ze wspólnej konfiguracji mozgd (~/.config/mozg/config.json), żeby panel i daemon patrzyły w to samo miejsce.
function attachmentsConfig(home = os.homedir()) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, '.config/mozg/config.json'), 'utf8')); } catch { /* brak = domyślne */ }
  const days = Number(cfg.attachments_retention_days);
  return { dir: typeof cfg.attachments_dir === 'string' && path.isAbsolute(cfg.attachments_dir) ? cfg.attachments_dir : path.join(home, '.local/state/mozg/attachments'),
    retentionDays: Number.isInteger(days) && days >= 1 ? days : RETENTION_DAYS };
}

// Nazwa pobieranego pliku: nazwa od workera bez znaków sterujących i ścieżek, rozszerzenie zgodne z typem.
function downloadName(name, id, mime) {
  const ext = EXT[mime] || 'bin';
  let base = String(name || '').split(/[\\/]/).pop().normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[.\s]+/, '').slice(0, 100).trim();
  base = base.replace(/\.(jpe?g|png|webp)$/i, '');
  return `${base || 'obraz-' + String(id).slice(0, 8)}.${ext}`;
}
function contentDisposition(filename) {
  const ascii = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function createAttachments(dir = path.join(os.homedir(), '.local/state/mozg/attachments'), retentionDays = RETENTION_DAYS) {
  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  function save(buf) {
    if (!buf.length) throw Object.assign(new Error('Pusty plik'), { code: 400 });
    if (buf.length > MAX_BYTES) throw Object.assign(new Error('Plik większy niż 10 MB'), { code: 413 });
    const mime = sniff(buf);
    if (mime === 'image/heic') throw Object.assign(new Error('HEIC nieobsługiwany - wyślij jako JPEG (Safari na iPhonie konwertuje sam)'), { code: 415 });
    if (!EXT[mime]) throw Object.assign(new Error('Dozwolone tylko obrazy JPEG, PNG i WebP'), { code: 415 });
    ensureDir();
    const id = crypto.randomBytes(16).toString('hex');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(path.join(dir, `${id}.${EXT[mime]}`), buf, { flag: 'wx', mode: 0o600 });
    return { id, mime, size: buf.length, sha256 };
  }
  function find(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    for (const [mime, ext] of Object.entries(EXT)) {
      const file = path.join(dir, `${id}.${ext}`);
      try { if (fs.lstatSync(file).isFile()) return { file, mime }; } catch { /* brak w tym formacie */ }
    }
    return null;
  }
  function cleanup(now = Date.now(), days = retentionDays) {
    let removed = 0;
    let names;
    try { names = fs.readdirSync(dir); } catch { return 0; }
    for (const name of names) {
      if (!FILE_RE.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.lstatSync(file);
        if (st.isFile() && now - st.mtimeMs > days * 86400000) { fs.unlinkSync(file); removed++; }
      } catch { /* zniknął w międzyczasie */ }
    }
    return removed;
  }
  // Historia czatu: obraz usunięty przez retencję oznaczony, zamiast zepsutej miniatury.
  function markExpired(thread) {
    for (const m of thread?.messages || []) for (const a of m.attachments || []) if (!find(a.id)) a.expired = true;
    return { ...thread, retention_days: retentionDays };
  }
  // GET /api/mozg/attachment/<id>[?download=1&name=]: podgląd w <img> albo oryginał do zapisania.
  function serve(res, id, query) {
    const found = find(id);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: `Brak załącznika (retencja ${retentionDays} dni)` }));
    }
    const headers = { 'Content-Type': found.mime, 'Cache-Control': 'private, max-age=2592000, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Length': fs.statSync(found.file).size };
    if (query?.get('download') === '1') headers['Content-Disposition'] = contentDisposition(downloadName(query.get('name'), id, found.mime));
    res.writeHead(200, headers);
    return fs.createReadStream(found.file).pipe(res);
  }
  return { dir, retentionDays, save, find, cleanup, markExpired, serve };
}

// Lista z wiadomości: [{id, mime, sha256}] - kształt sprawdza panel, plik i hash sprawdza mozgd.
function validList(list) {
  return Array.isArray(list) && list.length <= MAX_PER_MESSAGE && list.every((a) => a && typeof a === 'object' &&
    Object.keys(a).every((k) => ['id', 'mime', 'sha256'].includes(k)) &&
    ID_RE.test(a.id) && EXT[a.mime] && typeof a.sha256 === 'string' && SHA_RE.test(a.sha256));
}

function readRaw(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // bez destroy: odpowiedź 413 ma dojść do klienta, reszta strumienia jest tylko odrzucana
      if (size > limit) { chunks.length = 0; reject(Object.assign(new Error('Plik większy niż 10 MB'), { code: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { createAttachments, attachmentsConfig, downloadName, contentDisposition, sniff, validList, readRaw, MAX_BYTES, MAX_PER_MESSAGE, RETENTION_DAYS };
