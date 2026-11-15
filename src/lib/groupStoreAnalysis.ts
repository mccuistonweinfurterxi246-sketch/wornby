// Store category of a group, from the server's per-section counts (see useViewedGroups.recordStoreSummary).
export type GroupStoreCategory = 'unknown' | 'clothing' | 'items' | 'mixed' | 'empty';
export interface GroupStoreTag { label: string; count: number }
