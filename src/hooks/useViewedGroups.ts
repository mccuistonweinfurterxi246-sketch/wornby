import { useCallback, useEffect, useState } from 'react';
import { RobloxGroupMembership, StoreSummary } from '../types/roblox';
import { GroupStoreCategory, GroupStoreTag } from '../lib/groupStoreAnalysis';

const STORAGE_KEY = 'wornby_viewed_group_stores_v1';
const EVENT_KEY = 'wornby_viewed_group_stores_updated';
// 3: counts come from the server's per-section summary (earlier entries mixed in unclassified bundles).
export const ANALYSIS_VERSION = 3;

export type ViewedGroupCategory = GroupStoreCategory;
export type ViewableGroup = Pick<RobloxGroupMembership, 'id' | 'name'> & Partial<RobloxGroupMembership>;

export interface ViewedGroup {
  id: number;
  name: string;
  iconUrl: string | null;
  memberCount?: number;
  hasVerifiedBadge?: boolean;
  viewedAt: number;
  checkedAt?: number;
  category: ViewedGroupCategory;
  clothingCount: number;
  itemCount: number;
  unknownCount: number;
  totalCount: number;
  complete: boolean;
  tags: GroupStoreTag[];
  analysisVersion: number;
}

function readViewedGroups(): ViewedGroup[] {
  try {
    if (typeof window === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) =>
      Number.isSafeInteger(entry?.id) && entry.id > 0 && typeof entry.name === 'string'
    ).map((entry: ViewedGroup) => entry.analysisVersion === ANALYSIS_VERSION ? {
      ...entry,
      category: entry.clothingCount > 0 && entry.itemCount > 0 ? 'mixed' as const : entry.category,
    } : {
      ...entry, category: 'unknown' as const, complete: false, tags: [], unknownCount: 0, analysisVersion: 0,
    }).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);
  } catch {
    return [];
  }
}

function writeViewedGroups(entries: ViewedGroup[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* keep the current session usable */ }
  window.dispatchEvent(new Event(EVENT_KEY));
}

export function useViewedGroups() {
  const [viewedGroups, setViewedGroups] = useState<ViewedGroup[]>(readViewedGroups);

  useEffect(() => {
    const sync = () => setViewedGroups(readViewedGroups());
    window.addEventListener(EVENT_KEY, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT_KEY, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const recordViewedGroup = useCallback((group: ViewableGroup) => {
    const entries = readViewedGroups();
    const previous = entries.find((entry) => entry.id === group.id);
    const next: ViewedGroup = {
      id: group.id,
      name: group.name || previous?.name || `Group #${group.id}`,
      iconUrl: group.iconUrl ?? previous?.iconUrl ?? null,
      memberCount: group.memberCount ?? previous?.memberCount,
      hasVerifiedBadge: group.hasVerifiedBadge ?? previous?.hasVerifiedBadge,
      viewedAt: Date.now(),
      checkedAt: previous?.checkedAt,
      category: previous?.category || 'unknown',
      clothingCount: previous?.clothingCount || 0,
      itemCount: previous?.itemCount || 0,
      unknownCount: previous?.unknownCount || 0,
      totalCount: previous?.totalCount || 0,
      complete: previous?.complete || false,
      tags: previous?.tags || [],
      analysisVersion: previous?.analysisVersion || 0,
    };
    writeViewedGroups([next, ...entries.filter((entry) => entry.id !== group.id)]);
  }, []);

  /** Store counts from the server summary: clothing vs everything else, exact per section. */
  const recordStoreSummary = useCallback((groupId: number, summary: StoreSummary) => {
    const entries = readViewedGroups();
    if (!entries.some((entry) => entry.id === groupId)) return;
    const clothingCount = summary.clothing.count;
    // hair is optional: summaries cached before the Hair section existed don't have it
    const hairCount = summary.hair?.count ?? 0;
    const itemCount = summary.accessories.count + summary.heads.count + hairCount + summary.animations.count;
    const complete = !Object.values(summary).some((s) => s.more);
    const tags = ([['Clothing', summary.clothing.count], ['Accessories', summary.accessories.count], ['Heads & faces', summary.heads.count], ['Hair', hairCount], ['Animations', summary.animations.count]] as const)
      .filter(([, count]) => count > 0).map(([label, count]) => ({ label, count }));
    const category: ViewedGroupCategory = clothingCount > 0 && itemCount > 0 ? 'mixed' : clothingCount > 0 ? 'clothing' : itemCount > 0 ? 'items' : 'empty';
    writeViewedGroups(entries.map((entry) => entry.id === groupId ? {
      ...entry, checkedAt: Date.now(), category, clothingCount, itemCount, unknownCount: 0,
      totalCount: clothingCount + itemCount, complete, tags, analysisVersion: ANALYSIS_VERSION,
    } : entry));
  }, []);

  return { viewedGroups, recordViewedGroup, recordStoreSummary };
}
