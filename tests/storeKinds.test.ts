import test from 'node:test';
import assert from 'node:assert/strict';
import { itemKindKey } from '../src/lib/storeKinds';

test('clothing types group classic and layered versions', () => {
  assert.equal(itemKindKey('clothing', { assetType: 11 }), 'shirts');
  assert.equal(itemKindKey('clothing', { assetType: 65 }), 'shirts');
  assert.equal(itemKindKey('clothing', { assetType: 2 }), 'tshirts');
  assert.equal(itemKindKey('clothing', { assetType: '12' }), 'pants');
  assert.equal(itemKindKey('clothing', { assetType: 67 }), 'jackets');
  assert.equal(itemKindKey('clothing', { assetType: 68 }), 'sweaters');
  assert.equal(itemKindKey('clothing', { bundleType: 3 }), 'shoes');
});

test('accessories and animations by slot or bundle; unknown types are other', () => {
  assert.equal(itemKindKey('accessories', { assetType: 8 }), 'hats');
  assert.equal(itemKindKey('accessories', { assetType: 46 }), 'back');
  assert.equal(itemKindKey('animations', { bundleType: 2 }), 'packs');
  assert.equal(itemKindKey('animations', { assetType: 61 }), 'emotes');
  assert.equal(itemKindKey('accessories', { assetType: 999 }), 'other');
  assert.equal(itemKindKey('hair', { assetType: 41 }), 'other');
});
