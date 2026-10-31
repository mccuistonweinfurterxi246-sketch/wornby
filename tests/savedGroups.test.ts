import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CopiedGroupEntry, mergeLegacyIds } from '../src/lib/savedGroups';

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
