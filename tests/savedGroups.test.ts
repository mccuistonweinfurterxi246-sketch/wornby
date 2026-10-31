import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CopiedGroupEntry, addGroupEntry, mergeLegacyIds, writeSavedGroups } from '../src/lib/savedGroups';

const saved = { id: 7, name: 'Shop', memberCount: 10, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null, copiedAt: 1, memberCountAtCopy: 10 } as CopiedGroupEntry;

test('keeps folder entries and adds legacy-only ids as placeholders', () => {
  const merged = mergeLegacyIds([saved], [7, 8, '9', 8, -1, 'x', 0], 5);
  assert.deepEqual(merged.map((e) => e.id), [7, 8, 9]);
  assert.equal(merged[0], saved);
  assert.deepEqual(merged[1], { id: 8, name: 'Group #8', memberCount: 0, hasVerifiedBadge: false, roleName: '', roleRank: 0, iconUrl: null, copiedAt: 5, memberCountAtCopy: 0, needsDetails: true });
});

test('ignores a legacy value that is not a list', () => {
  const entries = [saved];
  assert.equal(mergeLegacyIds(entries, null), entries);
  assert.equal(mergeLegacyIds(entries, { 1: 2 }), entries);
});

const group = (id: number) => ({ id, name: `Group ${id}`, memberCount: id, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null });

test('saving keeps every existing group, with no 100-group limit', () => {
  const entries = Array.from({ length: 150 }, (_, i) => ({ ...group(i + 1), copiedAt: i, memberCountAtCopy: i + 1 }) as CopiedGroupEntry);
  const next = addGroupEntry(entries, group(999), { name: 'Alpha', id: 1 }, 7);
  assert.equal(next.length, 151);
  assert.equal(next[0].id, 999);
  assert.deepEqual(next.slice(1), entries);
  assert.equal(addGroupEntry(next, group(5)), next, 'an already saved group is not duplicated');
});

test('legacy migration keeps all ids beyond 100', () => {
  const legacy = Array.from({ length: 130 }, (_, i) => i + 1);
  assert.equal(mergeLegacyIds([saved], legacy).length, 130); // id 7 is already in the folder
});

test('a failed write reports false and leaves the stored folder untouched', () => {
  const store = new Map([['k', '[{"id":1}]']]);
  const full = { setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
  assert.equal(writeSavedGroups(full, 'k', [saved]), false);
  assert.equal(store.get('k'), '[{"id":1}]');
  const working = { setItem: (key: string, value: string) => { store.set(key, value); } };
  assert.equal(writeSavedGroups(working, 'k', [saved]), true);
  assert.equal(JSON.parse(store.get('k')!)[0].id, 7);
});
