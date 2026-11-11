import test from 'node:test';
import assert from 'node:assert/strict';
import { selectHistoryItem } from './navigation.js';

const rows = [
  { key: 'newest', text: 'same prompt' },
  { key: 'middle', text: 'same prompt' },
  { key: 'oldest', text: 'another prompt' },
];

test('empty and missing lists have no selection for every move', () => {
  for (const items of [undefined, null, []]) {
    for (const move of ['first', 'older', 'newer']) {
      assert.deepEqual(selectHistoryItem(items, 'missing', move), { key: null, index: -1, total: 0 });
    }
  }
});

test('older defaults to newest when nothing is selected', () => {
  assert.deepEqual(selectHistoryItem(rows, null), { key: 'newest', index: 0, total: 3 });
  assert.deepEqual(selectHistoryItem(rows), { key: 'newest', index: 0, total: 3 });
});

test('older advances toward oldest and clamps without wrapping', () => {
  assert.deepEqual(selectHistoryItem(rows, 'newest'), { key: 'middle', index: 1, total: 3 });
  assert.deepEqual(selectHistoryItem(rows, 'middle'), { key: 'oldest', index: 2, total: 3 });
  assert.deepEqual(selectHistoryItem(rows, 'oldest'), { key: 'oldest', index: 2, total: 3 });
});

test('newer advances toward newest and clamps there without clearing the row', () => {
  assert.deepEqual(selectHistoryItem(rows, 'oldest', 'newer'), { key: 'middle', index: 1, total: 3 });
  assert.deepEqual(selectHistoryItem(rows, 'middle', 'newer'), { key: 'newest', index: 0, total: 3 });
  assert.deepEqual(selectHistoryItem(rows, 'newest', 'newer'), { key: 'newest', index: 0, total: 3 });
});

test('newer starts at the first row when the old selection is absent', () => {
  for (const key of [null, undefined, 'missing']) {
    assert.deepEqual(selectHistoryItem(rows, key, 'newer'), { key: 'newest', index: 0, total: 3 });
  }
});

test('first always selects newest regardless of current key', () => {
  for (const key of [null, 'oldest', 'missing']) {
    assert.deepEqual(selectHistoryItem(rows, key, 'first'), { key: 'newest', index: 0, total: 3 });
  }
});

test('one row clamps in both directions', () => {
  const items = [rows[0]];
  assert.deepEqual(selectHistoryItem(items, 'newest'), { key: 'newest', index: 0, total: 1 });
  assert.deepEqual(selectHistoryItem(items, 'newest', 'newer'), { key: 'newest', index: 0, total: 1 });
});

test('numeric-looking keys are identities, not indexes or coerced numbers', () => {
  const items = [{ key: '10' }, { key: '02' }, { key: '0' }];
  assert.deepEqual(selectHistoryItem(items, '02'), { key: '0', index: 2, total: 3 });
  assert.deepEqual(selectHistoryItem(items, '02', 'newer'), { key: '10', index: 0, total: 3 });
  assert.deepEqual(selectHistoryItem(items, 2), { key: '10', index: 0, total: 3 });
  assert.deepEqual(selectHistoryItem(items, 2, 'newer'), { key: '10', index: 0, total: 3 });
});

test('duplicate prompt text retains distinct selection keys', () => {
  const selected = selectHistoryItem(rows, 'newest');
  assert.equal(selected.key, 'middle');
  assert.equal(rows[0].text, rows[1].text);
});

test('reordering resolves the retained key before moving', () => {
  const reordered = [rows[2], rows[0], rows[1]];
  assert.deepEqual(selectHistoryItem(reordered, 'newest'), { key: 'middle', index: 2, total: 3 });
  assert.deepEqual(selectHistoryItem(reordered, 'newest', 'newer'), { key: 'oldest', index: 0, total: 3 });
});

test('new rows do not turn the retained key into an old numeric index', () => {
  const expanded = [{ key: 'added', text: 'latest' }, ...rows];
  assert.deepEqual(selectHistoryItem(expanded, 'middle'), { key: 'oldest', index: 3, total: 4 });
  assert.deepEqual(selectHistoryItem(expanded, 'middle', 'newer'), { key: 'newest', index: 1, total: 4 });
});

test('filtering away the selected key uses the missing-key rules', () => {
  const filtered = [rows[0], rows[2]];
  assert.deepEqual(selectHistoryItem(filtered, 'middle'), { key: 'newest', index: 0, total: 2 });
  assert.deepEqual(selectHistoryItem(filtered, 'middle', 'newer'), { key: 'newest', index: 0, total: 2 });
});

test('invalid current keys do not throw or match by coercion', () => {
  for (const key of ['', false, NaN, {}, [], Symbol('missing')]) {
    assert.deepEqual(selectHistoryItem(rows, key), { key: 'newest', index: 0, total: 3 });
    assert.deepEqual(selectHistoryItem(rows, key, 'newer'), { key: 'newest', index: 0, total: 3 });
  }
});

test('repeated visual Down then Up keeps a real row selected at both list limits', () => {
  let key = rows[0].key;
  const down = [];
  for (let step = 0; step < 5; step++) { key = selectHistoryItem(rows, key, 'older').key; down.push(key); }
  assert.deepEqual(down, ['middle', 'oldest', 'oldest', 'oldest', 'oldest']);
  const up = [];
  for (let step = 0; step < 5; step++) { key = selectHistoryItem(rows, key, 'newer').key; up.push(key); }
  assert.deepEqual(up, ['middle', 'newest', 'newest', 'newest', 'newest']);
});

test('frozen inputs keep order, values, and row identities', () => {
  const first = Object.freeze({ key: 'first', text: 'one' });
  const second = Object.freeze({ key: 'second', text: 'two' });
  const items = Object.freeze([first, second]);
  for (const move of ['first', 'older', 'newer']) selectHistoryItem(items, 'first', move);
  assert.deepEqual(items, [{ key: 'first', text: 'one' }, { key: 'second', text: 'two' }]);
  assert.strictEqual(items[0], first);
  assert.strictEqual(items[1], second);
});
