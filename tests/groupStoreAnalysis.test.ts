import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeGroupItems, classifyGroupItem } from '../src/lib/groupStoreAnalysis';
import { RobloxAssetItem } from '../src/types/roblox';

const item = (assetType?: number, assetTypeName?: string): RobloxAssetItem => ({
  id: 1, name: 'Test item', description: '',
  assetType, assetTypeName, creatorName: 'Test', price: 5, isForSale: true,
  isOffSale: false, isDeletedOrModerated: false, isFree: false, thumbnailUrl: null,
  studioLuaCommand: '', catalogUrl: '',
});

test('classifies classic and layered clothing separately from accessories', () => {
  assert.deepEqual(classifyGroupItem(item(11, 'Shirt')), { kind: 'clothing', tag: 'Classic clothing' });
  assert.deepEqual(classifyGroupItem(item(67, 'Jacket Accessory')), { kind: 'clothing', tag: 'Layered clothing' });
  assert.deepEqual(classifyGroupItem(item(41, 'Hair Accessory')), { kind: 'items', tag: 'Accessories' });
});

test('waits for the full catalog and does not guess missing asset types', () => {
  const clothing = item(11, 'Shirt');
  const accessory = item(41, 'Hair Accessory');
  assert.equal(analyzeGroupItems([clothing], false).category, 'unknown');
  assert.equal(analyzeGroupItems([clothing, accessory], false).category, 'mixed');
  assert.equal(analyzeGroupItems([clothing, accessory], true).category, 'mixed');
  assert.equal(analyzeGroupItems([clothing, item(undefined, 'Wearable')], true).category, 'unknown');
  assert.equal(analyzeGroupItems([], true).category, 'empty');
});
