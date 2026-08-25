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
    // migrate legacy IDs if present but no folder
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const ids: number[] = JSON.parse(legacy);
      if (Array.isArray(ids) && ids.length > 0) {
        // will be hydrated later when groups are available
      }
    }
  } catch {}
  return [];
}

function save(entries: CopiedGroupEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    // keep legacy in sync for old isCopiedPersistent checks
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

  useEffect(() => {
    if (entries.length === 0) return;
    const robloxUsername = localStorage.getItem('wornby_last_roblox_username') || undefined;
    // bulk — один запрос на 31 группу, чтобы не упереться в 60/мин rate-limit и не терять куки
    const ids = entries.map(e=>e.id);
    fetch('/api/folder/sync-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include' as RequestCredentials,
      body: JSON.stringify({ groupIds: ids, robloxUsername }),
    }).then(async r=>{
      if (!r.ok) {
        // fallback per-entry если bulk не поддержан (старый деплой)
        const legacyToken = (()=>{ try { return localStorage.getItem('wornby_discord_token')?.trim() || undefined; } catch { return undefined; } })();
        for (const entry of entries) {
          fetch('/api/folder/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include' as RequestCredentials,
            body: JSON.stringify({ groupId: entry.id, groupName: entry.name, robloxUsername, ...(legacyToken ? { discordToken: legacyToken } : {}) }),
          }).catch(()=>{});
        }
      }
    }).catch(()=>{
      const legacyToken = (()=>{ try { return localStorage.getItem('wornby_discord_token')?.trim() || undefined; } catch { return undefined; } })();
      for (const entry of entries) {
        fetch('/api/folder/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include' as RequestCredentials,
          body: JSON.stringify({ groupId: entry.id, groupName: entry.name, robloxUsername, ...(legacyToken ? { discordToken: legacyToken } : {}) }),
        }).catch(()=>{});
      }
    });
  }, [entries]);

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
      // авто-синк с Discord — сайт понимает и запоминает для будущих уведомлений (bot DM)
      // токен теперь в HttpOnly куке, в body не кладем чтобы не светить в логах
      try {
        const robloxUsername = source?.name || localStorage.getItem('wornby_last_roblox_username') || undefined;
        if (robloxUsername) try { localStorage.setItem('wornby_last_roblox_username', robloxUsername); } catch {}
        const legacyToken = (()=>{ try { return localStorage.getItem('wornby_discord_token')?.trim() || undefined; } catch { return undefined; } })();
        fetch('/api/folder/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include' as RequestCredentials,
          body: JSON.stringify({ groupId: group.id, groupName: group.name, robloxUsername, ...(legacyToken ? { discordToken: legacyToken } : {}) }),
        }).catch(()=>{});
      } catch {}
      return next;
    });
  }, []);

  const remove = useCallback((groupId: number) => {
    setEntries(prev => {
      const next = prev.filter(e => e.id !== groupId);
      save(next);
      setUpdates(u => { const { [groupId]: _, ...rest } = u; return rest; });
      try {
        const legacyToken = (()=>{ try { return localStorage.getItem('wornby_discord_token')?.trim() || undefined; } catch { return undefined; } })();
        const robloxUsername = localStorage.getItem('wornby_last_roblox_username') || undefined;
        fetch('/api/folder/unsync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include' as RequestCredentials,
          body: JSON.stringify({ groupId, ...(legacyToken ? { discordToken: legacyToken } : {}), robloxUsername }),
        }).catch(()=>{});
      } catch {}
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    const prevIds = entries.map(e=>e.id);
    setEntries([]);
    setUpdates({});
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_KEY);
      const legacyToken = (()=>{ try { return localStorage.getItem('wornby_discord_token')?.trim() || undefined; } catch { return undefined; } })();
      const robloxUsername = localStorage.getItem('wornby_last_roblox_username') || undefined;
      for (const gid of prevIds) {
        fetch('/api/folder/unsync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include' as RequestCredentials,
          body: JSON.stringify({ groupId: gid, ...(legacyToken ? { discordToken: legacyToken } : {}), robloxUsername }),
        }).catch(()=>{});
      }
    } catch {}
  }, [entries]);

  const checkForUpdates = useCallback(async () => {
    if (entries.length === 0) return;
    setChecking(true);
    const nextUpdates: Record<number, { memberDelta: number; hasNewItem?: boolean; latestItemName?: string }> = {};
    // concurrent fetch with limit 4
    const queue = [...entries];
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) break;
        try {
          // параллельно тянем группу и новинки
          const [groupRes, itemsRes] = await Promise.allSettled([
            fetch(`/api/group/${entry.id}`).then(r=> r.ok ? r.json() : null),
            fetch(`/api/group/${entry.id}/new-items?limit=1`).then(r=> r.ok ? r.json() : null),
          ]);
          const groupData = groupRes.status==='fulfilled' ? groupRes.value : null;
          const itemsData = itemsRes.status==='fulfilled' ? itemsRes.value : null;
          const currentMembers = groupData?.memberCount ?? groupData?.memberCount ?? null;
          const memberDelta = currentMembers != null ? currentMembers - entry.memberCountAtCopy : 0;
          const latestItem = itemsData?.items?.[0];
          const hasNewItem = latestItem ? (new Date(latestItem.updated || latestItem.created).getTime() > entry.copiedAt) : false;
          nextUpdates[entry.id] = { memberDelta, hasNewItem, latestItemName: latestItem?.name };
        } catch {
          // ignore
        }
      }
    });
    await Promise.all(workers);
    setUpdates(nextUpdates);
    setChecking(false);
  }, [entries]);

  return { entries, add, remove, clear, checking, checkForUpdates, updates };
}
