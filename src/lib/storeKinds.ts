import type { RobloxAssetItem, StoreSection } from '../types/roblox';

// Item types inside a section, by Roblox asset type (classic and layered versions together) or bundle type.
export const SECTION_KINDS: Partial<Record<StoreSection, [key: string, label: string, match: (asset: number, bundle?: number) => boolean][]>> = {
  clothing: [
    ['shirts', 'Shirts', (a) => a === 11 || a === 65],
    ['tshirts', 'T-Shirts', (a) => a === 2 || a === 64],
    ['pants', 'Pants', (a) => a === 12 || a === 66],
    ['jackets', 'Jackets', (a) => a === 67],
    ['sweaters', 'Sweaters', (a) => a === 68],
    ['shorts', 'Shorts', (a) => a === 69],
    ['dresses', 'Dresses & Skirts', (a) => a === 72],
    ['shoes', 'Shoes', (a, b) => a === 70 || a === 71 || b === 3],
  ],
  accessories: [
    ['hats', 'Hats', (a) => a === 8],
    ['face', 'Face', (a) => a === 42],
    ['neck', 'Neck', (a) => a === 43],
    ['shoulder', 'Shoulder', (a) => a === 44],
    ['front', 'Front', (a) => a === 45],
    ['back', 'Back', (a) => a === 46],
    ['waist', 'Waist', (a) => a === 47],
    ['ears', 'Ears', (a) => a === 57],
    ['eyes', 'Eyes', (a) => a === 58],
  ],
  animations: [
    ['emotes', 'Emotes', (a) => a === 61],
    ['packs', 'Animation Packs', (_a, b) => b === 2],
    ['animations', 'Animations', (a) => (a >= 48 && a <= 56) || a === 78],
  ],
};
/** Which type chip an item belongs to in a section ('other' when none fits). */
export function itemKindKey(section: StoreSection | null, item: Pick<RobloxAssetItem, 'assetType' | 'bundleType'>): string {
  const kinds = section ? SECTION_KINDS[section] : undefined;
  return kinds?.find(([, , match]) => match(Number(item.assetType), item.bundleType))?.[0] ?? 'other';
}
