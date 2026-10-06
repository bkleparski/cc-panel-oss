'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {normalize, parse, matches, ranges} = require('../public/session-search');

test('normalize: lowercase, Polish diacritics folded (incl. ł)', () => {
  assert.equal(normalize('Źródła ŁÓDŹ żółć ĘĄŚŃ'), 'zrodla lodz zolc easn');
  assert.equal(normalize(null), '');
});
test('parse: words split on whitespace, folded, deduplicated', () => {
  assert.deepEqual(parse('  Źródła  cc-PANEL źródła '), ['zrodla', 'cc-panel']);
  assert.deepEqual(parse('   '), []);
});
test('matches: every word must appear in some field (AND), both directions of diacritics', () => {
  const fields = ['cc-panel-84', 'mesa-monitoring', '2-infra/uslugi/źródła'];
  assert.ok(matches(fields, parse('zrodla')));
  assert.ok(matches(['zrodla'], parse('źródła')));
  assert.ok(matches(fields, parse('PANEL mesa')));
  assert.ok(!matches(fields, parse('panel beacon')));
  assert.ok(matches(fields, []));
  assert.ok(!matches(['ab', 'cd'], parse('bc')), 'words do not match across field boundaries');
  assert.ok(matches([null, undefined, '', 'x'], parse('x')));
});
test('ranges: positions in original text, merged and sorted', () => {
  assert.deepEqual(ranges('Źródła danych', parse('zrod')), [[0, 4]]);
  assert.deepEqual(ranges('cc-panel-cc', parse('cc')), [[0, 2], [9, 11]]);
  assert.deepEqual(ranges('mozg-mozgi', parse('mozg zgi')), [[0, 4], [5, 10]]);
  assert.deepEqual(ranges('abc', parse('abc ab')), [[0, 3]]);
  assert.deepEqual(ranges('abc', []), []);
  assert.deepEqual(ranges('', parse('a')), []);
});
