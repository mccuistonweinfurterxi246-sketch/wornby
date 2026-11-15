import { API_BASE } from '../services/api';
import { carryTrailState, parseGroupTab, type GroupTab } from './exploreTrail';

/**
 * Writes a deep-link param (tab, store). 'push' makes it a back/forward step. Does nothing when the URL
 * already matches, so state restored from back/forward never rewrites the history it came from.
 */
export function setUrlParam(key: 'tab' | 'store' | 'gtab', value: string | null, mode: 'push' | 'replace' = 'push') {
  const url = new URL(window.location.href);
  if (url.searchParams.get(key) === value) return;
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  if (mode === 'push') window.history.pushState(carryTrailState(), '', url.toString());
  else window.history.replaceState(window.history.state, '', url.toString());
}

export const setStoreParam = (groupId: number | null, mode: 'push' | 'replace' = 'push') =>
  setUrlParam('store', groupId === null ? null : String(groupId), mode);

/** Closing a group: one back/forward step that drops both ?store= and ?gtab= (Back reopens the same section). */
export function clearStoreParams() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('store') && !url.searchParams.has('gtab')) return;
  url.searchParams.delete('store');
  url.searchParams.delete('gtab');
  window.history.pushState(carryTrailState(), '', url.toString());
}

export const readGroupTab = (): GroupTab => parseGroupTab(window.location.search);

export function readStoreParam(): number | null {
  const id = Number(new URLSearchParams(window.location.search).get('store'));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Group name and size for a ?store= link; falls back to a placeholder name if Roblox is unreachable. */
export async function fetchLinkedGroup(id: number): Promise<{ id: number; name: string; memberCount?: number }> {
  try {
    const res = await fetch(`${API_BASE}/group/${id}`);
    const info = res.ok ? await res.json() : null;
    if (info?.name) return { id, name: info.name, memberCount: info.memberCount };
  } catch { /* placeholder below */ }
  return { id, name: `Group #${id}` };
}
