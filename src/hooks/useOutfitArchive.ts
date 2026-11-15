import { useEffect, useRef, useState } from 'react';
import { RobloxApiClient } from '../services/api';
import {
  ArchiveItem, ArchiveState, SnapshotRef, applyCheck, emptyArchive, mergeCurrentLook, mergeLive, mergeSnapshot, needsCheck, snapshotKey,
} from '../lib/outfitArchive';

// ── This browser's copy of each player's archive (IndexedDB: survives reloads, resumes large backfills) ──
const DB_NAME = 'wornby-archive';
const STORE = 'players';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readArchive(userId: number): Promise<ArchiveState | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(userId);
      req.onsuccess = () => resolve(req.result?.version === 1 ? req.result as ArchiveState : null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function writeArchive(userId: number, state: ArchiveState) {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(state, userId);
  } catch { /* private windows may block storage; the archive still works for this visit */ }
}

const KINDS: SnapshotRef['kind'][] = ['wearing', 'avatar', 'profile', 'outfits'];
const SNAPSHOT_WORKERS = 3;
const CHECK_WORKERS = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = (e: unknown) => (e as { response?: { status?: number } })?.response?.status;

export interface ArchiveProgress { done: number; total: number; searching: number; failed: number; checking: number }

/** Loads a player's archive: stored copy first, then live outfits, then Wayback history and rechecks. */
export function useOutfitArchive(userId: number, currentLook: { items: ArchiveItem[]; renderUrl: string | null }) {
  const [state, setState] = useState<ArchiveState>(emptyArchive);
  const [inventory, setInventory] = useState<'public' | 'private' | 'unknown' | null>(null);
  const [liveStatus, setLiveStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [progress, setProgress] = useState<ArchiveProgress>({ done: 0, total: 0, searching: KINDS.length, failed: 0, checking: 0 });
  const [reloadKey, setReloadKey] = useState(0);
  const lookRef = useRef(currentLook);
  lookRef.current = currentLook;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let current = emptyArchive();
    // Never save before the stored copy is read, or a quick tab switch would overwrite it with nothing.
    let loaded = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const update = (fn: (s: ArchiveState) => ArchiveState) => {
      const next = fn(current);
      if (next === current) return;
      current = next;
      setState(next);
      clearTimeout(saveTimer);
      if (loaded) saveTimer = setTimeout(() => void writeArchive(userId, current), 600);
    };
    const bump = (patch: Partial<Record<keyof ArchiveProgress, number>>) =>
      setProgress((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v + (patch[k as keyof ArchiveProgress] ?? 0)])) as unknown as ArchiveProgress);

    setState(emptyArchive());
    setInventory(null);
    setLiveStatus('loading');
    setProgress({ done: 0, total: 0, searching: KINDS.length, failed: 0, checking: 0 });

    (async () => {
      const stored = await readArchive(userId);
      if (signal.aborted) return;
      if (stored) { current = stored; setState(stored); }
      loaded = true;
      const today = new Date().toISOString().slice(0, 10);
      const look = lookRef.current;
      if (look.items.length) update((s) => mergeCurrentLook(s, look.items, look.renderUrl, today));

      const live = RobloxApiClient.fetchArchiveLive(userId, signal).then((r) => {
        setInventory(r.inventory);
        update((s) => mergeLive(s, r.outfits, r.complete, today));
        setLiveStatus('ready');
      }).catch(() => { if (!signal.aborted) setLiveStatus('error'); });

      // Snapshot indexes arrive one kind at a time; workers start on whatever is queued.
      const queue: SnapshotRef[] = [];
      let searching = KINDS.length;
      for (const kind of KINDS) {
        RobloxApiClient.fetchArchiveIndex(userId, kind, signal).then((r) => {
          const seen = new Set(current.processed);
          const fresh = r.snapshots.filter((s) => !seen.has(snapshotKey(s))).reverse(); // newest first
          queue.push(...fresh);
          bump({ total: fresh.length });
        }).catch(() => { if (!signal.aborted) bump({ failed: 1 }); })
          .finally(() => { searching--; bump({ searching: -1 }); });
      }
      const worker = async () => {
        while (!signal.aborted) {
          const ref = queue.shift();
          if (!ref) {
            if (searching === 0) return;
            await sleep(300);
            continue;
          }
          try {
            const snap = await RobloxApiClient.fetchArchiveSnapshot(userId, ref, signal);
            update((s) => mergeSnapshot(s, ref, snap));
          } catch (e) {
            if (statusOf(e) === 429 && !signal.aborted) {
              // Rate limited: wait as told (capped) and put the snapshot back in line.
              const wait = Number((e as { response?: { data?: { retryAfterMs?: number } } }).response?.data?.retryAfterMs) || 3000;
              queue.unshift(ref);
              await sleep(Math.min(wait, 15000));
              continue;
            }
            // Not marked processed: the next visit tries this snapshot again.
            if (!signal.aborted) bump({ failed: 1 });
          }
          bump({ done: 1 });
        }
      };
      await Promise.all([live, ...Array.from({ length: SNAPSHOT_WORKERS }, worker)]);
      if (signal.aborted) return;

      // Outfits not in today's list: still on Roblox (recovered), or deleted (archived contents or name only).
      const ids = needsCheck(current);
      bump({ checking: ids.length });
      const check = async () => {
        while (!signal.aborted) {
          const id = ids.shift();
          if (id === undefined) return;
          try {
            await RobloxApiClient.fetchSavedOutfitDetails(id, signal);
            update((s) => applyCheck(s, id, { exists: true }));
          } catch (e) {
            if (statusOf(e) === 404) {
              try {
                const archived = await RobloxApiClient.fetchArchivedOutfit(id, signal);
                update((s) => applyCheck(s, id, { exists: false, archived }));
              } catch { /* Wayback unavailable: stays "checking" until the next visit */ }
            }
          }
          bump({ checking: -1 });
        }
      };
      await Promise.all(Array.from({ length: CHECK_WORKERS }, check));
    })();

    return () => {
      controller.abort();
      clearTimeout(saveTimer);
      if (loaded) void writeArchive(userId, current);
    };
  }, [userId, reloadKey]);

  return { state, inventory, liveStatus, progress, reload: () => setReloadKey((k) => k + 1) };
}
