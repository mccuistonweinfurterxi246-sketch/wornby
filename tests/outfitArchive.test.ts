import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyCheck, counts, emptyArchive, itemKind, lookYears, mergeCurrentLook, mergeLive, mergeSnapshot, needsCheck, visibleOutfits,
} from '../src/lib/outfitArchive';

const all = { status: 'all' as const, query: '' };
const listRef = { kind: 'outfits' as const, ts: '20221106000000', url: 'https://avatar.roblox.com/v2/avatar/users/1/outfits' };

test('live outfits, archived lists and rechecks merge into one record per outfit', () => {
  let s = mergeLive(emptyArchive(), [{ id: 10, name: 'Street', thumbnailUrl: 'img' }], true, '2026-11-14');
  s = mergeSnapshot(s, listRef, { kind: 'outfits', date: '2022-11-06', outfits: [{ id: 10, name: 'Street' }, { id: 5, name: 'maidy' }, { id: 6, name: 'neko' }] });
  // The same snapshot twice changes nothing (resumed or repeated loads).
  assert.equal(mergeSnapshot(s, listRef, { kind: 'outfits', date: '2022-11-06', outfits: [{ id: 7, name: 'x' }] }), s);
  assert.equal(s.outfits[10].status, 'available');
  assert.equal(s.outfits[10].archivedSince, '2022-11-06');
  assert.deepEqual(s.outfits[10].sources, ['roblox', 'wayback']);
  assert.deepEqual(needsCheck(s).sort(), [5, 6]);

  s = applyCheck(s, 5, { exists: false, archived: { assets: [{ id: 1, name: 'Shirt', kind: 'clothing' }] } });
  s = applyCheck(s, 6, { exists: false, archived: null });
  assert.equal(s.outfits[5].status, 'deleted');
  assert.equal(s.outfits[6].status, 'partial');
  assert.deepEqual(counts(s, true), { available: 1, recovered: 0, deleted: 1, partial: 1, checking: 0, looks: 0 });
  assert.deepEqual(visibleOutfits(s, all, true).map((o) => o.id), [10, 6, 5]);
});

test('an outfit that drops out of a complete live list is rechecked, then labelled recovered if it still exists', () => {
  let s = mergeLive(emptyArchive(), [{ id: 10, name: 'A', thumbnailUrl: null }, { id: 11, name: 'B', thumbnailUrl: null }], true, '2026-11-01');
  s = mergeLive(s, [{ id: 10, name: 'A', thumbnailUrl: null }], true, '2026-11-14');
  assert.equal(s.outfits[11].status, 'checking');
  assert.equal(mergeLive(s, [], false, '2026-11-15').outfits[10].status, 'available', 'an incomplete list proves nothing');
  s = applyCheck(s, 11, { exists: true, thumbnailUrl: 'img' });
  assert.equal(s.outfits[11].status, 'recovered');
  assert.equal(s.outfits[11].firstSeen, '2026-11-01');
});

test('private inventories hide every outfit, worn looks stay', () => {
  let s = mergeLive(emptyArchive(), [{ id: 10, name: 'A', thumbnailUrl: null }], true, '2026-11-14');
  s = mergeCurrentLook(s, [{ id: 3 }, { id: 1 }], 'render', '2026-11-14');
  assert.deepEqual(visibleOutfits(s, all, false), []);
  assert.equal(counts(s, false).available, 0);
  assert.equal(lookYears(s, all)[0][1].length, 1);
});

test('worn looks dedupe by their item set, keep names, dates and the archived render', () => {
  let s = mergeSnapshot(emptyArchive(), { kind: 'wearing', ts: '20210822000000', url: 'w1' }, { kind: 'wearing', date: '2021-08-22', look: { assetIds: [2, 1], items: [], renderUrl: null } });
  s = mergeSnapshot(s, { kind: 'avatar', ts: '20230101000000', url: 'a1' }, { kind: 'avatar', date: '2023-01-01', look: { assetIds: [1, 2], items: [{ id: 1, name: 'Hat', assetTypeName: 'Hat' }], renderUrl: null } });
  s = mergeSnapshot(s, { kind: 'profile', ts: '20160103000000', url: 'p1' }, { kind: 'profile', date: '2016-01-03', look: { assetIds: [9], items: [{ id: 9, name: 'Epic Face' }], renderUrl: 'https://web.archive.org/x' } });
  const looks = Object.values(s.looks);
  assert.equal(looks.length, 2);
  const both = s.looks['1,2'];
  assert.deepEqual([both.firstSeen, both.lastSeen, both.sightings], ['2021-08-22', '2023-01-01', 2]);
  assert.deepEqual(both.items[0], { id: 1, name: 'Hat', assetTypeName: 'Hat', kind: 'accessory' });
  assert.deepEqual(lookYears(s, all).map(([year]) => year), ['2023', '2016']);
  assert.equal(lookYears(s, { status: 'all', query: 'epic' })[0][1][0].renderUrl, 'https://web.archive.org/x');
  // The profile's current look is counted once per day.
  const once = mergeCurrentLook(s, [{ id: 1 }, { id: 2 }], null, '2026-11-14');
  assert.equal(mergeCurrentLook(once, [{ id: 1 }, { id: 2 }], null, '2026-11-14'), once);
});

test('asset type names map to the copy groups', () => {
  assert.deepEqual(['Shirt', 'T-Shirt', 'SweaterAccessory', 'Hat', 'Face Accessory', 'Gear', 'Torso', undefined].map(itemKind),
    ['clothing', 'clothing', 'clothing', 'accessory', 'accessory', 'gear', undefined, undefined]);
});
