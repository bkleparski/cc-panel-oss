const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attention, excluded, summary } = require('../lib/attention');
test('attention includes approvals for workers and brain, only ordinary idle sessions, and open decisions', () => {
  const items = [
    { key: 'normal', status: 'idle', name: 'Agent' },
    { key: 'worker', status: 'idle', workspace: 'workers' },
    { key: 'brain', status: 'idle', tabLabel: 'mozg-g2' },
    { key: 'approval', status: 'approval', workspace: 'workers' },
    { key: 'brain-approval', status: 'blocked', tabLabel: 'mozg-g2' },
    { key: 'done', status: 'done' }, { key: 'working', status: 'working' }
  ];
  assert.deepEqual(attention(items, [{ id: 'open', text: 'x'.repeat(120) }], 'workers').map(x => x.id), ['approval', 'brain-approval', 'normal', 'decision:open']);
  assert.equal(attention([], [], 'workers').length, 0);
  assert.equal(attention([], [{id: 'x', text: 'x'.repeat(120)}], '')[0].body.length, 100);
  assert.equal(excluded(items[1], 'workers'), true);
  assert.equal(excluded(items[2], 'workers'), true);
  assert.equal(excluded(items[0], 'workers'), false);
});

test('summary counts agent sessions without brain panes, working ones and attention without decisions', () => {
  const items = [
    { key: 'a', status: 'idle', name: 'A' }, { key: 'w', status: 'working' },
    { key: 'worker', status: 'idle', workspace: 'workers' }, { key: 'brain', status: 'working', tabLabel: 'mozg-g1' },
    { key: 'p', status: 'approval' }
  ];
  assert.deepEqual(summary(items, 'workers'), { sessions: 4, working: 1, attention: 2 });
  assert.deepEqual(summary([], ''), { sessions: 0, working: 0, attention: 0 });
});

test('attention: opis „o co prosi” tylko przy zgodzie', () => {
  const ask = { text: 'Bash: $ git push', short: 'Bash' };
  const out = attention([{ key: 'a', status: 'approval', name: 'A', ask }, { key: 'i', status: 'idle', name: 'I', ask }, { key: 'b', status: 'approval', name: 'B', ask: null }], [], '');
  assert.equal(out.find(x => x.id === 'a').body, 'Bash: $ git push');
  assert.equal(out.find(x => x.id === 'i').body, undefined);
  assert.equal(out.find(x => x.id === 'b').body, undefined);
});
