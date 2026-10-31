import { useCallback, useEffect, useState } from 'react';
import { RobloxGroupMembership } from '../types/roblox';
import { API_BASE } from '../services/api';
import { CopiedGroupEntry, mergeLegacyIds } from '../lib/savedGroups';

export type { CopiedGroupEntry };

const STORAGE_KEY = 'wornby_copied_groups_folder_v1';
// Old ID-only list kept by the profile view; migrated into the folder on first load.
const LEGACY_KEY = 'wornby_copied_groups';

function load(): CopiedGroupEntry[] {
  try {
    if (typeof window === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const entries = Array.isArray(parsed) ? parsed as CopiedGroupEntry[] : [];
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw === null) return entries;
    // one-time migration: the folder becomes the only store of saved groups
    let legacyIds: unknown = null;
    try { legacyIds = JSON.parse(legacyRaw); } catch {}
    const merged = mergeLegacyIds(entries, legacyIds);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      localStorage.removeItem(LEGACY_KEY); // only once the merged folder is safely written
    } catch {}
    return merged;
  } catch {}
  return [];
}

function save(entries: CopiedGroupEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

export function useCopiedGroupsFolder() {
  const [entries, setEntries] = useState<CopiedGroupEntry[]>(() => load());
  const [checking, setChecking] = useState(false);
  const [updates, setUpdates] = useState<Record<number, { memberDelta: number; hasNewItem?: boolean; latestItemName?: string }>>({});

  useEffect(() => {
    const onStorage = () => setEntries(load());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Fill in names and member counts for groups migrated from the old ID-only list.
  useEffect(() => {
    const pending = entries.filter((e) => e.needsDetails).slice(0, 20);
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(pending.map((e) => fetch(`${API_BASE}/group/${e.id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null))).then((infos) => {
      if (cancelled) return;
      const byId = new Map(infos.filter((info) => info?.id).map((info) => [info.id as number, info]));
      if (byId.size === 0) return;
      setEntries((prev) => {
        const next = prev.map((e) => {
          const info = byId.get(e.id);
          if (!e.needsDetails || !info) return e;
          const memberCount = typeof info.memberCount === 'number' ? info.memberCount : 0;
          return { ...e, name: info.name || e.name, memberCount, memberCountAtCopy: memberCount, needsDetails: undefined };
        });
        save(next);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [entries]);

  const add = useCallback((group: RobloxGroupMembership, source?: { name: string; id: number }) => {
    setEntries(prev => {
      const existing = prev.find(e => e.id === group.id);
      if (existing && !existing.needsDetails) return prev;
      const entry: CopiedGroupEntry = {
        ...group,
        copiedAt: Date.now(),
        sourceUserName: source?.name,
        sourceUserId: source?.id,
        memberCountAtCopy: group.memberCount,
      };
      const next = [entry, ...prev.filter(e => e.id !== group.id)].slice(0, 100);
      save(next);
      return next;
    });
  }, []);

  const remove = useCallback((groupId: number) => {
    setEntries(prev => {
      const next = prev.filter(e => e.id !== groupId);
      save(next);
      setUpdates(u => { const { [groupId]: _, ...rest } = u; return rest; });
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    setUpdates({});
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

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
