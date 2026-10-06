const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/../src-tauri/src/panel.js', 'utf8');
function setup({ origin = 'https://panel.example.com', draft = '', inactive = '', pending = false } = {}) {
  const handlers = {}, nodes = {}, assigned = [], tabs = Array.from({ length: 3 }, (_, i) => ({ click() { state.tab = i; } }));
  const state = { reloads: 0, tab: -1, shell: false };
  const element = () => ({ style: {}, setAttribute() {}, prepend() {}, replaceChildren() {}, append(e) { this.button = e; } });
  const document = {
    head: element(), body: { append(e) { nodes[e.id] = e; } },
    createElement: element, createTextNode: s => s,
    getElementById: id => nodes[id],
    querySelector: () => null,
    querySelectorAll: sel => sel.startsWith('#mozg-tabs') ? tabs : [{ value: draft }],
    addEventListener(name, fn) { handlers[name] = fn; }
  };
  nodes['v-mozg'] = { hidden: false };
  nodes['mozg-shell'] = { getAttribute: () => state.shell ? 'true' : 'false', click() { state.shell = true; } };
  const location = { origin, hash: '#/mozg/project', reload() { state.reloads++; }, assign(url) { assigned.push(url); } };
  const window = {}; window.top = window;
  const context = { window, document, location, MutationObserver: class { observe() {} disconnect() {} },
    mozgDrafts: new Map([['other', inactive]]), mozgPendingByThread: new Map(pending ? [['t', {}]] : []) };
  vm.runInNewContext(source, context);
  const key = (target = { closest: () => null }) => handlers.keydown({ metaKey: true, key: '2', target, preventDefault() { state.prevented = true; } });
  return { window, state, assigned, location, nodes, handlers, key };
}
test('reload reconnects WebSockets when there is no draft', () => {
  const s = setup(); s.window.CCPDesktop.reconnect(s.location.origin); assert.equal(s.state.reloads, 1);
});
test('failover preserves route and never propagates query/token', () => {
  const s = setup(); s.location.search = '?token=private'; s.window.CCPDesktop.reconnect('https://panel.your-tailnet.ts.net');
  assert.deepEqual(s.assigned, ['https://panel.your-tailnet.ts.net/#/mozg/project']);
});
for (const options of [{ draft: 'tekst' }, { inactive: 'inny projekt' }, { pending: true }]) {
  test('reconnect preserves draft or in-flight send ' + JSON.stringify(options), () => {
    const s = setup(options); s.window.CCPDesktop.reconnect('https://panel.your-tailnet.ts.net');
    assert.equal(s.assigned.length, 0); assert.ok(s.nodes['ccp-desktop-status'].button);
  });
}
test('rejects origins outside exact allowlist', () => {
  const s = setup(); s.window.CCPDesktop.reconnect('https://panel.example.com.evil.example'); assert.equal(s.assigned.length, 0);
  assert.equal(setup({ origin: 'https://evil.example' }).window.CCPDesktop, undefined);
});
test('Cmd+2 selects existing tab, ignores terminal and editing fields', () => {
  const s = setup(); s.key({ closest: () => ({}) }); assert.equal(s.state.tab, -1);
  s.key(); assert.equal(s.state.tab, 1); assert.equal(s.state.prevented, true);
});
test('show shell opens existing dock without toggling an already open dock closed', () => {
  const s = setup(); s.window.CCPDesktop.show(true); assert.equal(s.state.shell, true);
  s.window.CCPDesktop.show(true); assert.equal(s.state.shell, true);
});
test('no fixed connection footer on load (it covered the input field)', () => {
  const s = setup({ origin: 'https://panel.your-tailnet.ts.net' });
  s.handlers.DOMContentLoaded();
  assert.equal(s.nodes['ccp-desktop-status'], undefined);
});
test('nav delegates to the page (NavKeys) with focus as toggle', () => {
  const s = setup(); const calls = [];
  s.window.NavKeys = { go: (t, o) => calls.push([t, o.toggle]) };
  s.window.CCPDesktop.nav('terminal', true); s.window.CCPDesktop.nav('dysp', false); s.window.CCPDesktop.nav('evil', true);
  assert.deepEqual(calls, [['terminal', true], ['dysp', false]]);
});
test('nav without NavKeys falls back to hash and show()', () => {
  const s = setup(); s.location.hash = '#/s/x';
  s.window.CCPDesktop.nav('sessions'); assert.equal(s.location.hash, '#/sesje');
  s.window.CCPDesktop.nav('terminal'); assert.equal(s.location.hash, '#/mozg'); assert.equal(s.state.shell, true);
});
