import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTrail, parseGroupTab, type TrailEntry } from '../src/lib/exploreTrail';

const A: TrailEntry = { kind: 'user', id: 1, name: 'A' };
const B: TrailEntry = { kind: 'user', id: 2, name: 'B' };
const G: TrailEntry = { kind: 'group', id: 10, name: 'G' };
const H: TrailEntry = { kind: 'group', id: 11, name: 'H' };
const ids = (t: TrailEntry[]) => t.map((e) => `${e.kind}:${e.id}`);

test('appends to an empty trail', () => {
  assert.deepEqual(nextTrail([], A), [A]);
});

test('appends a new entry at the end', () => {
  assert.deepEqual(ids(nextTrail([A, G], B)), ['user:1', 'group:10', 'user:2']);
});

test('revisiting an entry cuts the trail back to it', () => {
  assert.deepEqual(ids(nextTrail([A, G, B, H], G)), ['user:1', 'group:10']);
});

test('revisiting refreshes the entry name and image', () => {
  const renamed = { ...G, name: 'G2', imageUrl: 'x' };
  assert.deepEqual(nextTrail([A, G], renamed).at(-1), renamed);
});

test('same id with another kind is a different entry', () => {
  const g1: TrailEntry = { kind: 'group', id: 1, name: 'g1' };
  assert.deepEqual(ids(nextTrail([A], g1)), ['user:1', 'group:1']);
});

test('keeps only the last max entries', () => {
  let t: TrailEntry[] = [];
  for (let i = 1; i <= 10; i++) t = nextTrail(t, { kind: 'user', id: i, name: String(i) });
  assert.deepEqual(t.map((e) => e.id), [3, 4, 5, 6, 7, 8, 9, 10]);
});

test('group tab param falls back to store', () => {
  assert.equal(parseGroupTab('?gtab=members'), 'members');
  assert.equal(parseGroupTab('?gtab=bogus'), 'store');
  assert.equal(parseGroupTab(''), 'store');
});
