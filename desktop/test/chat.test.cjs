// Static checks of the CHAT windows in main.rs (no cargo on coding): isolation and host lists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const main = fs.readFileSync(__dirname + '/../src-tauri/src/main.rs', 'utf8');
const cap = JSON.parse(fs.readFileSync(__dirname + '/../src-tauri/capabilities/panel.json', 'utf8'));
const conf = JSON.parse(fs.readFileSync(__dirname + '/../src-tauri/tauri.conf.json', 'utf8'));
const ChatLinks = require('../../public/chat-links.js');
const PANEL = ['panel.example.com', 'panel.your-tailnet.ts.net'];
const fnBody = (name) => {
  const start = main.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, name);
  const next = main.indexOf('\nfn ', start + 1);
  return main.slice(start, next < 0 ? undefined : next);
};
const strings = (src) => [...src.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const constBlock = (name) => main.slice(main.indexOf(`const ${name}`), main.indexOf('];', main.indexOf(`const ${name}`)));

test('chat windows get no capability: only the panel window has one, with panel hosts only', () => {
  assert.deepEqual(cap.windows, ['panel']);
  assert.deepEqual(cap.permissions, []);
  assert.deepEqual(conf.app.security.capabilities, ['panel']);
  for (const u of cap.remote.urls) assert.ok(PANEL.some((h) => u.startsWith(`https://${h}/`)), u);
});

test('chat window: own data store, own navigation policy, no init script, only auth popups in-app', () => {
  const body = fnBody('open_chat');
  assert.match(body, /\.data_store_identifier\(CHAT_STORE\)/);
  assert.match(body, /\.on_navigation\(move \|url\| \{[\s\S]*?chat_navigation\(url\)\s*\}\)/);
  assert.match(body, /NewWindowResponse::Deny/);
  assert.doesNotMatch(body, /initialization_script|NewWindowResponse::Allow/);
  // The only in-app popup path: OAuth windows that answer via window.opener.
  assert.match(body, /if let Some\(window\) = auth_popup\([^)]*\) \{\s*return NewWindowResponse::Create \{ window \};/);
  assert.equal((main.match(/NewWindowResponse::Create/g) || []).length, 1);
  assert.doesNotMatch(main, /NewWindowResponse::Allow/);
});

test('auth popups: login hosts only, chat navigation policy, opener config, no init script', () => {
  const body = fnBody('auth_popup');
  assert.match(body, /AUTH_POPUP_HOSTS\.contains/);
  assert.match(body, /\.window_features\(features\)/);
  assert.match(body, /\.on_navigation\(move \|url\| \{[\s\S]*?let ok = chat_navigation\(url\);[\s\S]*?\n\s*ok\s*\}\)/);
  assert.doesNotMatch(body, /initialization_script/);
  const chatHosts = strings(constBlock('CHAT_HOSTS'));
  for (const h of strings(constBlock('AUTH_POPUP_HOSTS'))) {
    assert.ok(chatHosts.includes(h), h);
    assert.ok(!PANEL.includes(h), h);
  }
});

test('chat navigation refuses the panel before any allowlist match', () => {
  const body = fnBody('chat_navigation');
  assert.ok(body.indexOf('if allowed(url)') < body.indexOf('CHAT_HOSTS'));
  assert.match(body, /if allowed\(url\) \{\s*return false;/);
  for (const h of [...strings(constBlock('CHAT_HOSTS')), ...strings(constBlock('CHAT_SUFFIXES'))]) {
    assert.ok(!PANEL.some((p) => p === h || p.endsWith(h)), h);
  }
});

test('panel intercepts exactly the hosts the CHAT tiles link to', () => {
  const shellHosts = strings(constBlock('CHATS')).filter((s) => /\./.test(s) && !s.includes('/'));
  for (const ios of [true, false]) {
    for (const t of ChatLinks.tiles(ios)) assert.ok(shellHosts.includes(new URL(t.href).host), t.href);
  }
  const labels = strings(constBlock('CHATS')).filter((s) => s.startsWith('chat-'));
  assert.deepEqual(labels, ['chat-claude', 'chat-chatgpt']);
  assert.ok(!labels.includes('panel'));
});

test('browser escape hatch opens https only, never the panel, without a shell', () => {
  const body = fnBody('open_in_browser');
  assert.match(body, /https_host\(url\)\.is_none\(\) \|\| allowed\(url\)/);
  assert.match(main, /Command::new\("\/usr\/bin\/open"\)\.arg\(url\)/);
  assert.doesNotMatch(main, /Command::new\("(sh|bash|zsh|\/bin\/sh)"/);
});

test('"Otwórz w przeglądarce": current chat page only, never login hosts, OAuth data or the panel', () => {
  const body = fnBody('browser_url');
  // Only a page on the chat's own hosts is passed on, and only without query and fragment.
  assert.match(body, /https_host\(&url\)\.is_some_and\(\|h\| chat\.hosts\.contains\(&h\)\)/);
  assert.match(body, /!AUTH_PATHS\.iter\(\)\.any/);
  assert.match(body, /url\.set_query\(None\);\s*url\.set_fragment\(None\);/);
  assert.match(body, /chat\.home\.parse\(\)\.ok\(\)\s*\}\n/);
  const chatHosts = strings(constBlock('CHATS')).filter((s) => /\./.test(s) && !s.includes('/'));
  for (const h of strings(constBlock('CHAT_HOSTS'))) assert.ok(!chatHosts.includes(h), `login host ${h}`);
  for (const h of chatHosts) assert.ok(!PANEL.includes(h), h);
  for (const a of ['/login', '/auth', '/api/', '/magic-link', '/oauth']) {
    assert.ok(strings(constBlock('AUTH_PATHS')).includes(a), a);
  }
  // Both entry points go through browser_url and the https/panel guard of open_in_browser.
  assert.match(fnBody('chat_in_browser'), /browser_url\(idx, current\)[\s\S]*open_in_browser\(&url\)/);
  assert.match(fnBody('blocked_in_browser'), /browser_url\(idx, None\)[\s\S]*open_in_browser\(&url\)/);
  // /usr/bin/open is reached only through open_in_browser (two cfg variants of fn spawn_open).
  assert.equal(main.match(/(?<!fn )spawn_open\(/g).length, 1);
  assert.match(fnBody('open_in_browser'), /spawn_open\(/);
});

test('Google disallowed_useragent page is recognised by URL, no script injected', () => {
  const body = fnBody('google_blocked');
  assert.match(body, /Some\("accounts\.google\.com"\)/);
  assert.match(body, /\/oauth\/error/);
  const target = Buffer.from('disallowed_useragent');
  const marks = strings(constBlock('UA_BLOCKED'));
  assert.ok(marks.includes('disallowed_useragent'));
  // authError is base64 of a protobuf: whatever precedes the string, one core must match.
  for (let pre = 0; pre < 6; pre++) {
    const b64 = Buffer.concat([Buffer.alloc(pre, 7), target, Buffer.from([0x12, 3, 1, 2, 3])]).toString('base64');
    assert.ok(marks.some((m) => m !== 'disallowed_useragent' && b64.includes(m)), `prefix ${pre}`);
    assert.ok(marks.some((m) => b64.replace(/\+/g, '-').replace(/\//g, '_').includes(m)), `url-safe ${pre}`);
  }
  assert.match(fnBody('blocked_in_browser'), /< 30/);
  assert.doesNotMatch(fnBody('open_chat'), /initialization_script|\.eval\(/);
});

test('app menu: Czat submenu, Cmd+Option+O (Cmd+Shift+O is "new chat" on both sites), off until a chat has focus', () => {
  assert.match(main, /"chat-browser",\s*"Otwórz w przeglądarce",\s*false,\s*Some\("CmdOrCtrl\+Alt\+O"\)/);
  assert.doesNotMatch(main, /Some\("CmdOrCtrl\+Shift\+O"\)/);
  assert.match(main, /Menu::default\(app\.handle\(\)\)/);
  assert.match(main, /app\.set_menu\(app_menu\)/);
  assert.match(main, /"chat-browser" => chat_in_browser\(app\)/);
  const body = fnBody('open_chat');
  assert.match(body, /Focused\(true\) => \{[\s\S]*?chat_menu_enabled\(&events, true\)/);
  assert.match(body, /Focused\(false\) => \{[\s\S]*?chat_menu_enabled\(&events, focused\)/);
});

test('chat window is built on a later event-loop turn, never inside the WebKit navigation callback', () => {
  // run_on_main_thread runs inline on the main thread (tauri-runtime-wry 2.12), so it is posted from a helper thread.
  const body = fnBody('open_chat');
  assert.ok(body.indexOf('std::thread::spawn(move ||') >= 0);
  assert.ok(body.indexOf('std::thread::spawn(move ||') < body.indexOf('run_on_main_thread('));
  assert.equal(main.match(/run_on_main_thread\(/g).length, 1);
  // Every entry point goes through open_chat: panel navigation, panel popup, tray/app menu.
  assert.match(main, /open_chat\(&nav, idx, "panel, nawigacja"\)/);
  assert.match(main, /open_chat\(&popup, idx, "panel, nowe okno"\)/);
  assert.match(main, /"chat-claude" => open_chat\(app, 0, "menu"\)/);
  assert.match(main, /"chat-chatgpt" => open_chat\(app, 1, "menu"\)/);
});

test('diagnostic log: fixed path, size-capped, URLs only through log_url (no query, fragment, cookies)', () => {
  const diag = fs.readFileSync(__dirname + '/../src-tauri/src/diag.rs', 'utf8');
  assert.match(diag, /"Library\/Logs\/cc-panel-desktop\/desktop\.log"/);
  assert.match(diag, /MAX_BYTES: u64 = 256 \* 1024/);
  assert.match(diag, /with_extension\("log\.1"\)/);
  assert.match(main, /^mod diag;$/m);
  // Argument of each diag::log( ... ) call, by paren balance (calls end with ");" or "),").
  const calls = [...main.matchAll(/diag::log\(/g)].map((m) => {
    let depth = 1, i = m.index + m[0].length;
    for (; depth; i++) depth += main[i] === '(' ? 1 : main[i] === ')' ? -1 : 0;
    return main.slice(m.index + m[0].length, i - 1);
  });
  assert.ok(calls.length >= 10, String(calls.length));
  for (const c of calls) {
    assert.doesNotMatch(c, /as_str\(\)|\{url|\bquery\b|fragment|cookie|token/i, c);
    // A URL variable may appear only wrapped in log_url(...).
    for (const m of c.matchAll(/\burl\b/g)) assert.match(c.slice(Math.max(0, m.index - 9), m.index), /log_url\(&?$/, c);
  }
  const body = fnBody('log_url');
  assert.doesNotMatch(body, /query\(|fragment\(|as_str\(|username|password/);
  assert.match(body, /AUTH_PATHS\.iter\(\)\.find/);
  assert.match(body, /!allowed\(url\) && chat_index\(url\)\.is_none\(\)/);
  // The startup line and the single-instance hand-off show which build actually runs.
  assert.match(main, /"start: CC Panel \{\} \(pid \{\}, binarka z \{built\}\)"/);
  assert.match(main, /druga instancja: pokazuję okno działającego procesu/);
});
