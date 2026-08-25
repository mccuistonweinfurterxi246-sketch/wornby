import { useCallback, useEffect, useState } from 'react';
import { RobloxGroupMembership } from '../types/roblox';

export interface CopiedGroupEntry extends RobloxGroupMembership {
  copiedAt: number;
  sourceUserName?: string;
  sourceUserId?: number;
  memberCountAtCopy: number;
}

const STORAGE_KEY = 'wornby_copied_groups_folder_v1';
const LEGACY_KEY = 'wornby_copied_groups';

function load(): CopiedGroupEntry[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as CopiedGroupEntry[];
    }
  } catch {}
  return [];
}

function save(entries: CopiedGroupEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    localStorage.setItem(LEGACY_KEY, JSON.stringify(entries.map(e=>e.id)));
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

  const add = useCallback((group: RobloxGroupMembership, source?: { name: string; id: number }) => {
    setEntries(prev => {
      if (prev.some(e => e.id === group.id)) return prev;
      const entry: CopiedGroupEntry = {
        ...group,
        copiedAt: Date.now(),
        sourceUserName: source?.name,
        sourceUserId: source?.id,
        memberCountAtCopy: group.memberCount,
      };
      const next = [entry, ...prev].slice(0, 100);
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
      localStorage.removeItem(LEGACY_KEY);
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
              fetch(`/api/roblox/group/${entry.id}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
              fetch(`/api/roblox/group/${entry.id}/new-items?limit=5`).then(r => (r.ok ? r.json() : null)).catch(() => null),
            ]);

            const currentMembers = typeof grpRes?.memberCount === 'number' ? grpRes.memberCount : entry.memberCount;
            const delta = currentMembers - (entry.memberCountAtCopy || entry.memberCount);

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
