export interface RobloxUserResolve {
  id: number;
  name: string;
  displayName: string;
  hasVerifiedBadge: boolean;
  description?: string;
  created?: string;
  isBanned?: boolean;
}

export interface RobloxAvatarThumbnails {
  fullBodyUrl: string | null;
  headshotUrl: string | null;
}

export interface RobloxAssetItem {
  id: number;
  name: string;
  description: string;
  assetType?: number | string;
  assetTypeName?: string;
  /** Bundles only: 1 body, 2 animations, 3 shoes, 4 dynamic head. */
  bundleType?: number;
  creatorName: string;
  creatorId?: number;
  creatorType?: string;
  price: number | null;
  priceStatus?: string;
  lowestPrice?: number | null;
  isForSale: boolean;
  isOffSale: boolean;
  isDeletedOrModerated: boolean;
  isFree: boolean;
  itemRestrictions?: string[];
  thumbnailUrl: string | null;
  studioLuaCommand: string;
  catalogUrl: string;
  /** The id that works in Roblox: the item itself, or a bundle's wearable head (null: a bundle without one). */
  wearAssetId?: number | null;
}

/** What to copy for an item: its wearable asset id (a bundle id is not an asset id in Roblox). */
export const copyableId = (item: Pick<RobloxAssetItem, 'id' | 'wearAssetId'>) => item.wearAssetId ?? item.id;

export interface RobloxGroupMembership {
  id: number;
  name: string;
  memberCount: number;
  hasVerifiedBadge: boolean;
  roleName: string;
  roleRank: number;
  iconUrl: string | null;
}

export interface GroupMember {
  id: number;
  name: string;
  displayName: string;
  verified: boolean;
  role: { name: string; rank: number };
  headshotUrl: string | null;
}

export interface Experience {
  universeId: number;
  placeId: number;
  name: string;
  description: string | null;
  moderated: boolean;
  visits: number;
  created: string | null;
  updated: string | null;
  iconUrl: string | null;
}

export type CreatorAssetType = 'model' | 'decal' | 'mesh';

export interface CreatorAsset {
  id: number;
  name: string;
  typeId: number;
  created: string;
  updated: string;
  thumbnailUrl: string | null;
}

export type Creator = { kind: 'user' | 'group'; id: number };

export type StoreSection = 'clothing' | 'accessories' | 'heads' | 'hair' | 'animations';
/** Exact item counts per store section (`more`: counting stopped at the cap). */
export type StoreSummary = Record<StoreSection, { count: number; more: boolean }>;

export interface RobloxSavedOutfit {
  id: number;
  name: string;
  thumbnailUrl: string | null;
}

export interface RobloxSavedOutfitAsset {
  id: number;
  name: string;
  assetTypeName: string;
  kind: 'clothing' | 'accessory' | 'gear';
  thumbnailUrl: string | null;
}

export interface RobloxSavedOutfitDetails {
  id: number;
  name: string;
  assets: RobloxSavedOutfitAsset[];
}

export interface RobloxUserProfileFull {
  user: RobloxUserResolve;
  thumbnails: RobloxAvatarThumbnails;
  outfit: {
    totalValueRobux: number;
    hasOffSaleItems: boolean;
    offSaleCount: number;
    freeCount: number;
    pricedCount: number;
    itemCount: number;
    items: RobloxAssetItem[];
  };
  groups: RobloxGroupMembership[];
  telemetry: {
    cached: boolean;
    timestamp: number;
    responseTimeMs: number;
    wearingAssetCount: number;
    fingerprint?: string;
    egressShards?: number;
  };
}
