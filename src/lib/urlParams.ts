import { API_BASE } from '../services/api';

/**
 * Writes a deep-link param (tab, store). 'push' makes it a back/forward step. Does nothing when the URL
 * already matches, so state restored from back/forward never rewrites the history it came from.
 */
export function setUrlParam(key: 'tab' | 'store', value: string | null, mode: 'push' | 'replace' = 'push') {
  const url = new URL(window.location.href);
  if (url.searchParams.get(key) === value) return;
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  if (mode === 'push') window.history.pushState({}, '', url.toString());
  else window.history.replaceState(window.history.state, '', url.toString());
}

export const setStoreParam = (groupId: number | null, mode: 'push' | 'replace' = 'push') =>
  setUrlParam('store', groupId === null ? null : String(groupId), mode);

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
