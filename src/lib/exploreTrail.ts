/** Breadcrumb trail of explored players and groups. Lives in history.state so Back/Forward restore it. */
export type TrailEntry = { kind: 'user' | 'group'; id: number; name: string; imageUrl?: string | null };

export type GroupTab = 'store' | 'experiences' | 'members' | 'assets';
const GROUP_TABS: GroupTab[] = ['store', 'experiences', 'members', 'assets'];

const STORAGE_KEY = 'wornby.trail';

/** Revisiting an entry cuts the trail back to it (no endless A › G › A › G); otherwise append, keep the last `max`. */
export function nextTrail(trail: TrailEntry[], entry: TrailEntry, max = 8): TrailEntry[] {
  const at = trail.findIndex((e) => e.kind === entry.kind && e.id === entry.id);
  const base = at >= 0 ? trail.slice(0, at) : trail;
  return [...base, entry].slice(-max);
}

export function parseGroupTab(search: string): GroupTab {
  const tab = new URLSearchParams(search).get('gtab') as GroupTab | null;
  return tab && GROUP_TABS.includes(tab) ? tab : 'store';
}

export function readTrail(): TrailEntry[] {
  try {
    const fromHistory = (window.history.state as { trail?: TrailEntry[] } | null)?.trail;
    if (Array.isArray(fromHistory)) return fromHistory;
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/** Stores the trail on the current history entry (call right after the navigation's own push). */
export function writeTrail(trail: TrailEntry[]) {
  try {
    window.history.replaceState({ ...(window.history.state || {}), trail }, '', window.location.href);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail));
  } catch { /* storage blocked: the trail still lives in memory for this entry */ }
  window.dispatchEvent(new Event('wornby:trail'));
}

/** History state for a new entry that keeps the current trail (tab and store pushes). */
export const carryTrailState = () => ({ trail: (window.history.state as { trail?: TrailEntry[] } | null)?.trail });
