'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { createAttachments, attachmentsConfig, downloadName, sniff, validList, readRaw, MAX_BYTES } = require('../lib/attachments');
const { plan, isImage, imagesLabel, saveMode, viewSize, triage, skippedText, MAX_FILES } = require('../public/mozg-images');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]);

function tmpStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-att-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createAttachments(path.join(root, 'state', 'attachments'));
}

test('sniff rozpoznaje typ po sygnaturze, nie po nazwie', () => {
  assert.equal(sniff(JPEG), 'image/jpeg');
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(WEBP), 'image/webp');
  assert.equal(sniff(HEIC), 'image/heic');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('save: plik 0600 w katalogu 0700, id + sha256, find zwraca ścieżkę', (t) => {
  const store = tmpStore(t);
  const meta = store.save(JPEG);
  assert.match(meta.id, /^[0-9a-f]{32}$/);
  assert.equal(meta.sha256, crypto.createHash('sha256').update(JPEG).digest('hex'));
  assert.deepEqual([meta.mime, meta.size], ['image/jpeg', JPEG.length]);
  const file = path.join(store.dir, meta.id + '.jpg');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
  assert.deepEqual(store.find(meta.id), { file, mime: 'image/jpeg' });
  assert.equal(store.find('../../etc/passwd'), null);
  assert.equal(store.find('a'.repeat(32)), null);
});

test('save odrzuca HEIC, nie-obrazy, pusty i za duży plik', (t) => {
  const store = tmpStore(t);
  assert.throws(() => store.save(HEIC), (e) => e.code === 415 && /HEIC/.test(e.message));
  assert.throws(() => store.save(Buffer.from('#!/bin/sh\nrm -rf /')), (e) => e.code === 415);
  assert.throws(() => store.save(Buffer.alloc(0)), (e) => e.code === 400);
  assert.throws(() => store.save(Buffer.concat([JPEG, Buffer.alloc(MAX_BYTES)])), (e) => e.code === 413);
});

test('cleanup usuwa tylko pliki załączników starsze niż 30 dni', (t) => {
  const store = tmpStore(t);
  const old = store.save(JPEG), fresh = store.save(PNG);
  const past = new Date(Date.now() - 31 * 86400000);
  fs.utimesSync(path.join(store.dir, old.id + '.jpg'), past, past);
  fs.writeFileSync(path.join(store.dir, 'notatka.txt'), 'x');
  fs.utimesSync(path.join(store.dir, 'notatka.txt'), past, past);
  assert.equal(store.cleanup(), 1);
  assert.equal(store.find(old.id), null);
  assert.ok(store.find(fresh.id));
  assert.ok(fs.existsSync(path.join(store.dir, 'notatka.txt')));
});

test('validList: kształt listy z wiadomości', () => {
  const ok = { id: 'a'.repeat(32), mime: 'image/png', sha256: 'b'.repeat(64) };
  assert.equal(validList([]), true);
  assert.equal(validList([ok]), true);
  assert.equal(validList(Array(7).fill(ok)), false);
  assert.equal(validList([{ ...ok, path: '/etc/passwd' }]), false);
  assert.equal(validList([{ ...ok, mime: 'image/heic' }]), false);
  assert.equal(validList([{ ...ok, id: '../x' }]), false);
  assert.equal(validList('x'), false);
});

test('readRaw: limit rozmiaru', async () => {
  assert.deepEqual(await readRaw(Readable.from([Buffer.from('ab'), Buffer.from('c')]), 10), Buffer.from('abc'));
  await assert.rejects(readRaw(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10), (e) => e.code === 413);
});

test('plan: małe JPEG/PNG bez zmian, duże i HEIC do JPEG z dłuższym bokiem 2048', () => {
  assert.deepEqual(plan('image/png', 900000, 1179, 1800), { reencode: false, width: 1179, height: 1800 });
  assert.deepEqual(plan('image/png', 900000, 1179, 2556), { reencode: true, width: 945, height: 2048 });
  assert.deepEqual(plan('image/heic', 900000, 4032, 3024), { reencode: true, width: 2048, height: 1536 });
  assert.deepEqual(plan('image/jpeg', 4e6, 1600, 1200), { reencode: true, width: 1600, height: 1200 });
  assert.equal(isImage({ type: '', name: 'IMG_0001.HEIC' }), true);
  assert.equal(isImage({ type: 'application/pdf', name: 'a.pdf' }), false);
});

test('attachmentsConfig: katalog i retencja z konfiguracji mozgd, złe wartości = domyślne', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-cfg-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(attachmentsConfig(home), { dir: path.join(home, '.local/state/mozg/attachments'), retentionDays: 30 });
  fs.mkdirSync(path.join(home, '.config/mozg'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/mozg/config.json'), JSON.stringify({ attachments_dir: '/x/att', attachments_retention_days: 14 }));
  assert.deepEqual(attachmentsConfig(home), { dir: '/x/att', retentionDays: 14 });
  fs.writeFileSync(path.join(home, '.config/mozg/config.json'), JSON.stringify({ attachments_dir: 'wzgledny', attachments_retention_days: 0 }));
  assert.deepEqual(attachmentsConfig(home), { dir: path.join(home, '.local/state/mozg/attachments'), retentionDays: 30 });
});

test('cleanup i markExpired używają retencji z konfiguracji', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-ret-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createAttachments(path.join(root, 'att'), 7);
  const old = store.save(JPEG), fresh = store.save(PNG);
  const past = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(path.join(store.dir, old.id + '.jpg'), past, past);
  assert.equal(store.cleanup(), 1);
  const thread = store.markExpired({ messages: [{ attachments: [{ id: old.id }, { id: fresh.id }] }, { text: 'bez obrazów' }] });
  assert.equal(thread.retention_days, 7);
  assert.deepEqual(thread.messages[0].attachments.map(a => !!a.expired), [true, false]);
});

test('downloadName: bez ścieżek i znaków sterujących, rozszerzenie z typu', () => {
  assert.equal(downloadName('01-desktop-tydzień.png', 'a'.repeat(32), 'image/png'), '01-desktop-tydzień.png');
  assert.equal(downloadName('../../etc/passwd', 'a'.repeat(32), 'image/jpeg'), 'passwd.jpg');
  assert.equal(downloadName('wykres.png', 'a'.repeat(32), 'image/jpeg'), 'wykres.jpg');
  assert.equal(downloadName('', 'abcdef1234', 'image/webp'), 'obraz-abcdef12.webp');
  assert.equal(downloadName('a"b\r\n.png', 'x', 'image/png'), 'a_b__.png');
  assert.equal(downloadName('.htaccess', 'abcdef1234', 'image/png'), 'htaccess.png');
});

test('imagesLabel: odmiana jak w mozgd', () => {
  assert.deepEqual([1, 2, 4, 5, 6, 12, 22, 25].map(imagesLabel),
    ['1 obraz', '2 obrazy', '4 obrazy', '5 obrazów', '6 obrazów', '12 obrazów', '22 obrazy', '25 obrazów']);
});

test('saveMode: iPhone/PWA arkusz udostępniania, desktop pobranie, iOS bez share nigdy link do pliku', () => {
  const env = (o) => ({ canShareFiles: false, standalone: false, touch: false, ios: false, ...o });
  assert.equal(saveMode(env({ canShareFiles: true, standalone: true, touch: true, ios: true })), 'share');
  assert.equal(saveMode(env({ canShareFiles: true, touch: true })), 'share');
  assert.equal(saveMode(env({ canShareFiles: true })), 'download'); // desktop Safari/Chrome z Web Share: i tak pobranie
  assert.equal(saveMode(env({ standalone: true, ios: true })), 'hold');
  assert.equal(saveMode(env({ touch: true, ios: true })), 'hold');
  assert.equal(saveMode(env({})), 'download');
  assert.equal(saveMode(env({ standalone: true })), 'download'); // desktopowa PWA (Chrome) pobiera normalnie
});

test('viewSize: długa infografika na szerokość ekranu, zwykły obraz cały na ekranie', () => {
  const tall = viewSize(1170, 4000, 390, 740); // iPhone 13, 1170x4000
  assert.equal(tall.long, true);
  assert.equal(tall.start, 390);
  assert.equal(tall.wide.h, Math.round(4000 * 390 / 1170));
  assert.ok(tall.fit.h <= 740 && tall.fit.w < 390);
  const photo = viewSize(4000, 3000, 390, 740); // poziome zdjęcie
  assert.equal(photo.long, false);
  assert.deepEqual(photo.fit, { w: 390, h: 293 });
  assert.equal(photo.start, 390);
  const small = viewSize(200, 100, 1440, 800); // mały obraz: bez powiększania
  assert.deepEqual(small.fit, { w: 200, h: 100 });
  assert.equal(small.start, 200);
  const desk = viewSize(1170, 4000, 1440, 830); // desktop: naturalna szerokość, przewijanie w pionie
  assert.equal(desk.long, true);
  assert.equal(desk.start, 1170);
  assert.ok(desk.maxW > desk.start);
});

test('przeciągnięte pliki: obrazy do limitu, reszta pominięta z nazwą i powodem', () => {
  const f = (name, type) => ({ name, type });
  const { take, skipped } = triage([f('a.png', 'image/png'), f('skan.pdf', 'application/pdf'), f('fala.mp3', 'audio/mpeg'), f('b.heic', ''), f('Projekty', '')], 0);
  assert.deepEqual(take.map(x => x.name), ['a.png', 'b.heic']);
  assert.deepEqual(skipped, [{ name: 'skan.pdf', why: 'type' }, { name: 'fala.mp3', why: 'type' }, { name: 'Projekty', why: 'type' }]);
  assert.match(skippedText(skipped), /^Pominąłem „skan\.pdf”, „fala\.mp3”, „Projekty” - Dyspozytor przyjmuje tylko obrazy/);
  // limit liczony razem z obrazami już dołączonymi do wiadomości
  const many = Array.from({ length: 4 }, (_, i) => f(`z${i}.jpg`, 'image/jpeg'));
  const r = triage(many, MAX_FILES - 2);
  assert.deepEqual(r.take.map(x => x.name), ['z0.jpg', 'z1.jpg']);
  assert.equal(skippedText(r.skipped), `Limit ${MAX_FILES} obrazów w jednej wiadomości - pominąłem „z2.jpg”, „z3.jpg”.`);
  assert.match(skippedText(Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.pdf`, why: 'type' }))), /„p2\.pdf” i 2 inne -/);
  assert.equal(skippedText([]), '');
});
