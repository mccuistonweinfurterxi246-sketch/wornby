import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSavedOutfits, normalizeSavedOutfitAssets } from '../server/savedOutfits';

test('keeps only user-created avatar fits', () => {
  assert.deepEqual(normalizeSavedOutfits([
    { id: 10, name: 'Street fit', isEditable: true, outfitType: 'Avatar' },
    { id: 11, name: 'Purchased bundle', isEditable: false, outfitType: 'Avatar' },
    { id: 12, name: 'Dynamic head', isEditable: true, outfitType: 'DynamicHead' },
    { id: 10, name: 'Duplicate', isEditable: true, outfitType: 'Avatar' },
    { id: 13, name: '', isEditable: true, outfitType: 'Avatar' },
  ]), [
    { id: 10, name: 'Street fit', thumbnailUrl: null },
    { id: 13, name: 'Fit #13', thumbnailUrl: null },
  ]);
});

test('shows wearable clothing and accessories without body parts or animations', () => {
  assert.deepEqual(normalizeSavedOutfitAssets([
    { id: 1, name: 'Shirt', assetType: { id: 11, name: 'Shirt' } },
    { id: 2, name: 'Layered sweater', assetType: { id: 68, name: 'SweaterAccessory' } },
    { id: 3, name: 'Hat', assetType: { id: 8, name: 'Hat' } },
    { id: 4, name: 'Head', assetType: { id: 79, name: 'DynamicHead' } },
    { id: 5, name: 'Mood', assetType: { id: 78, name: 'MoodAnimation' } },
    { id: 6, name: 'Torso', assetType: { id: 27, name: 'Torso' } },
  ]).map(({ id, kind }) => ({ id, kind })), [
    { id: 1, kind: 'clothing' },
    { id: 2, kind: 'clothing' },
    { id: 3, kind: 'accessory' },
  ]);
});
