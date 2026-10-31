import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RobloxGroupMembership } from '../types/roblox';
import { API_BASE } from '../services/api';
import { CopiedGroupEntry, addGroupEntry, mergeLegacyIds, writeSavedGroups } from '../lib/savedGroups';

export type { CopiedGroupEntry };

const STORAGE_KEY = 'wornby_copied_groups_folder_v1';
// Old ID-only list kept by the profile view; migrated into the folder on first load.
const LEGACY_KEY = 'wornby_copied_groups';

/**
 * Reads the folder with any IDs from the old list merged in. Pure: it runs during render, so writing
 * (and the error toast that a failed write shows) is left to finishLegacyMigration after mount.
 */
function load(): { entries: CopiedGroupEntry[]; hasLegacy: boolean } {
  try {
    if (typeof window === 'undefined') return { entries: [], hasLegacy: false };
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const entries = Array.isArray(parsed) ? parsed as CopiedGroupEntry[] : [];
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw === null) return { entries, hasLegacy: false };
    let legacyIds: unknown = null;
    try { legacyIds = JSON.parse(legacyRaw); } catch {}
    return { entries: mergeLegacyIds(entries, legacyIds), hasLegacy: true };
  } catch {}
  return { entries: [], hasLegacy: false };
}

/** One-time migration: the old list is removed only once the merged folder is safely written. */
function finishLegacyMigration(merged: CopiedGroupEntry[]) {
  if (save(merged)) {
    try { localStorage.removeItem(LEGACY_KEY); } catch {}
  } else {
    storageFullToast('Your older saved groups are still kept but could not be merged yet.');
  }
}

function storageFullToast(description: string) {
  toast.error('Browser storage is full', { id: 'saved-groups-storage', description });
}

/** Writes the folder; on failure the stored folder is left exactly as it was. */
function save(entries: CopiedGroupEntry[]): boolean {
  return writeSavedGroups(localStorage, STORAGE_KEY, entries);
}

// Name lookups for migrated groups go out in small batches so a large old list doesn't trip the API rate limit.
const DETAILS_BATCH = 20;
const DETAILS_BATCH_GAP_MS = 30_000;

export function useCopiedGroupsFolder() {
  const [entries, setEntriesState] = useState<CopiedGroupEntry[]>(() => load().entries);
  // latest entries for synchronous add/remove, so callers learn right away whether the write worked
  const entriesRef = useRef(entries);
  const setEntries = useCallback((next: CopiedGroupEntry[]) => { entriesRef.current = next; setEntriesState(next); }, []);
  const detailsAttemptedRef = useRef(new Set<number>());
  const lastDetailsBatchRef = useRef(0);
  const unmountedRef = useRef(false);
  useEffect(() => { unmountedRef.current = false; return () => { unmountedRef.current = true; }; }, []);
  const [checking, setChecking] = useState(false);
  const [updates, setUpdates] = useState<Record<number, { memberDelta: number; hasNewItem?: boolean; latestItemName?: string }>>({});

  useEffect(() => {
    const sync = () => {
      const { entries: next, hasLegacy } = load();
      setEntries(next);
      if (hasLegacy) finishLegacyMigration(next);
    };
    // state already holds the merged list; finishing the migration only needs the write
    const initial = load();
    if (initial.hasLegacy) finishLegacyMigration(initial.entries);
    const onStorage = () => sync();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setEntries]);

  // Fill in names and member counts for groups migrated from the old ID-only list.
  useEffect(() => {
    const pending = entries.filter((e) => e.needsDetails && !detailsAttemptedRef.current.has(e.id)).slice(0, DETAILS_BATCH);
    if (pending.length === 0) return;
    const delay = Math.max(0, lastDetailsBatchRef.current + DETAILS_BATCH_GAP_MS - Date.now());
    const timer = window.setTimeout(() => {
      lastDetailsBatchRef.current = Date.now();
      pending.forEach((e) => detailsAttemptedRef.current.add(e.id));
      void Promise.all(pending.map((e) => fetch(`${API_BASE}/group/${e.id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null))).then((infos) => {
        // results apply to the latest entries, so a re-render while the lookup was running doesn't discard them
        if (unmountedRef.current) return;
        const byId = new Map(infos.filter((info) => info?.id).map((info) => [info.id as number, info]));
        if (byId.size === 0) {
          setEntriesState((prev) => [...prev]); // re-run for the next batch even when this one found nothing
          return;
        }
        const next = entriesRef.current.map((e) => {
          const info = byId.get(e.id);
          if (!e.needsDetails || !info) return e;
          const memberCount = typeof info.memberCount === 'number' ? info.memberCount : 0;
          return { ...e, name: info.name || e.name, memberCount, memberCountAtCopy: memberCount, needsDetails: undefined };
        });
        // the stored placeholders stay valid if this write fails; names are fetched again next visit
        save(next);
        setEntries(next);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [entries, setEntries]);

  /** Saves a group; returns false (and shows an error) when browser storage refuses the write. */
  const add = useCallback((group: RobloxGroupMembership, source?: { name: string; id: number }): boolean => {
    const prev = entriesRef.current;
    const next = addGroupEntry(prev, group, source);
    if (next === prev) return true;
    if (!save(next)) {
      storageFullToast(`${group.name} was not saved. Your other saved groups are untouched — remove some to make room.`);
      return false;
    }
    setEntries(next);
    return true;
  }, [setEntries]);

  const remove = useCallback((groupId: number): boolean => {
    const next = entriesRef.current.filter(e => e.id !== groupId);
    if (!save(next)) {
      storageFullToast('The group could not be removed. Nothing was changed.');
      return false;
    }
    setEntries(next);
    setUpdates(u => { const { [groupId]: _, ...rest } = u; return rest; });
    return true;
  }, [setEntries]);

  const clear = useCallback(() => {
    setEntries([]);
    setUpdates({});
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_KEY); // an unmerged old list would otherwise bring the groups back
    } catch {}
  }, [setEntries]);

  const checkForUpdates = useCallback(async () => {
    if (entries.length === 0) return;
    setChecking(true);
    const newUpdates: Record<number, { memberDelta: number; hasNewItem?: boolean; latestItemName?: string }> = {};

    try {
      const batch = entries.slice(0, 20);
      await Promise.allSettled(
        batch.map(async (entry) => {
          try {
            const [grpRes, itemsRes] = await Promise.all([
              fetch(`${API_BASE}/group/${entry.id}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
              fetch(`${API_BASE}/group/${entry.id}/new-items?limit=5`).then(r => (r.ok ? r.json() : null)).catch(() => null),
            ]);

            const currentMembers = typeof grpRes?.memberCount === 'number' ? grpRes.memberCount : entry.memberCount;
            const delta = entry.needsDetails ? 0 : currentMembers - (entry.memberCountAtCopy || entry.memberCount);

            const latestItems: { id: number; name: string; created?: string }[] = itemsRes?.items || [];
            const hasNew = latestItems.some(it => {
              if (!it.created) return false;
              const createdTs = new Date(it.created).getTime();
              return createdTs > entry.copiedAt;
            });

            newUpdates[entry.id] = {
              memberDelta: delta,
              hasNewItem: hasNew,
              latestItemName: hasNew ? latestItems[0]?.name : undefined,
            };
          } catch {}
        })
      );
      setUpdates(newUpdates);
    } finally {
      setChecking(false);
    }
  }, [entries]);

  return {
    entries,
    add,
    remove,
    clear,
    checkForUpdates,
    checking,
    updates,
  };
}
