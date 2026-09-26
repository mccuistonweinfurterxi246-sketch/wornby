export interface SavedOutfit {
  id: number;
  name: string;
  thumbnailUrl: string | null;
}

export interface SavedOutfitAsset {
  id: number;
  name: string;
  assetTypeName: string;
  kind: 'clothing' | 'accessory' | 'gear';
  thumbnailUrl: string | null;
}

const CLOTHING_TYPES = new Set([2, 11, 12, 64, 65, 66, 67, 68, 69, 70, 71, 72]);
const ACCESSORY_TYPES = new Set([8, 41, 42, 43, 44, 45, 46, 47, 76, 77]);

export function normalizeSavedOutfitAssets(data: unknown): SavedOutfitAsset[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<number>();
  return data.flatMap((entry) => {
    const id = Number(entry?.id);
    const typeId = Number(entry?.assetType?.id);
    const kind = CLOTHING_TYPES.has(typeId) ? 'clothing'
      : ACCESSORY_TYPES.has(typeId) ? 'accessory'
      : typeId === 19 ? 'gear' : null;
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !kind) return [];
    seen.add(id);
    return [{
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `Item #${id}`,
      assetTypeName: typeof entry.assetType?.name === 'string' ? entry.assetType.name : '',
      kind,
      thumbnailUrl: null,
    }];
  });
}

export function normalizeSavedOutfits(data: unknown): SavedOutfit[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<number>();
  return data.flatMap((entry) => {
    const id = Number(entry?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return [];
    if (entry.isEditable !== true || (entry.outfitType && entry.outfitType !== 'Avatar')) return [];
    seen.add(id);
    return [{
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `Fit #${id}`,
      thumbnailUrl: null,
    }];
  });
}
