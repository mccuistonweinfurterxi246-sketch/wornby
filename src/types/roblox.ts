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
}

export interface RobloxGroupMembership {
  id: number;
  name: string;
  memberCount: number;
  hasVerifiedBadge: boolean;
  roleName: string;
  roleRank: number;
  iconUrl: string | null;
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
