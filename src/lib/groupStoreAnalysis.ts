import { RobloxAssetItem } from '../types/roblox';

export type GroupStoreCategory = 'unknown' | 'clothing' | 'items' | 'mixed' | 'empty';
export interface GroupStoreTag { label: string; count: number }

type ItemKind = 'clothing' | 'items' | 'unknown';
type ItemTag = 'Classic clothing' | 'Layered clothing' | 'Accessories' | 'Body & face' | 'Gear' | 'Animations' | 'Backgrounds' | 'Unclassified';

const CLASSIC_CLOTHING = new Set([2, 11, 12]);
const LAYERED_CLOTHING = new Set([64, 65, 66, 67, 68, 69, 70, 71, 72]);
const ACCESSORIES = new Set([8, 41, 42, 43, 44, 45, 46, 47, 76, 77]);
const BODY_AND_FACE = new Set([17, 18, 27, 28, 29, 30, 31, 79, 88, 89, 90]);
const ANIMATIONS = new Set([48, 49, 50, 51, 52, 53, 54, 55, 56, 61, 78]);

// Asset IDs follow Roblox AvatarAssetType. A missing or unfamiliar type stays unclassified.
export function classifyGroupItem(item: Pick<RobloxAssetItem, 'assetType' | 'assetTypeName'>): { kind: ItemKind; tag: ItemTag } {
  const typeId = Number(item.assetType);
  if (CLASSIC_CLOTHING.has(typeId)) return { kind: 'clothing', tag: 'Classic clothing' };
  if (LAYERED_CLOTHING.has(typeId)) return { kind: 'clothing', tag: 'Layered clothing' };
  if (ACCESSORIES.has(typeId)) return { kind: 'items', tag: 'Accessories' };
  if (BODY_AND_FACE.has(typeId)) return { kind: 'items', tag: 'Body & face' };
  if (typeId === 19) return { kind: 'items', tag: 'Gear' };
  if (ANIMATIONS.has(typeId)) return { kind: 'items', tag: 'Animations' };
  if (typeId === 92) return { kind: 'items', tag: 'Backgrounds' };

  const name = (item.assetTypeName || '').trim().toLowerCase();
  if (/^(t-shirt|shirt|pants)$/.test(name)) return { kind: 'clothing', tag: 'Classic clothing' };
  if (/^(t-shirt|shirt|pants|jacket|sweater|shorts|left shoe|right shoe|dress skirt) accessory$/.test(name)) return { kind: 'clothing', tag: 'Layered clothing' };
  if (/^(hat|hair|face|neck|shoulder|front|back|waist|eyebrow|eyelash) accessory$/.test(name)) return { kind: 'items', tag: 'Accessories' };
  if (/^(head|face|torso|right arm|left arm|right leg|left leg|dynamic head|face makeup|lip makeup|eye makeup)$/.test(name)) return { kind: 'items', tag: 'Body & face' };
  if (name === 'gear') return { kind: 'items', tag: 'Gear' };
  if (name.endsWith(' animation')) return { kind: 'items', tag: 'Animations' };
  if (name === 'avatar background') return { kind: 'items', tag: 'Backgrounds' };
  return { kind: 'unknown', tag: 'Unclassified' };
}

export function analyzeGroupItems(items: RobloxAssetItem[], complete: boolean) {
  const counts = new Map<ItemTag, number>();
  let clothingCount = 0;
  let itemCount = 0;
  let unknownCount = 0;
  for (const item of items) {
    const { kind, tag } = classifyGroupItem(item);
    counts.set(tag, (counts.get(tag) || 0) + 1);
    if (kind === 'clothing') clothingCount++;
    else if (kind === 'items') itemCount++;
    else unknownCount++;
  }
  // Once both kinds are present, later pages cannot change a mixed store.
  const category: GroupStoreCategory = clothingCount > 0 && itemCount > 0
    ? 'mixed'
    : !complete || unknownCount > 0 ? 'unknown'
    : items.length === 0 ? 'empty'
    : clothingCount > 0 ? 'clothing' : 'items';
  const tags = Array.from(counts, ([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  return { category, clothingCount, itemCount, unknownCount, totalCount: items.length, complete, tags };
}
