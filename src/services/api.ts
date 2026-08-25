import axios from 'axios';
import { RobloxUserProfileFull, RobloxAssetItem } from '../types/roblox';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '/api';

export type StreamEvent =
  | { event: 'user'; data: { user: RobloxUserProfileFull['user'] } }
  | { event: 'equipped'; data: { count: number; assetIds: number[] } }
  | { event: 'fingerprint'; data: { fingerprint: string; egressShards: number } }
  | { event: 'valuation'; data: { totalValueRobux: number; pricedCount: number; freeCount: number; offSaleCount: number; seen: number; total: number } }
  | { event: 'chunk'; data: { items: { id:number; name?:string; price?: number|null; isFree?: boolean }[] } }
  | { event: 'done'; data: RobloxUserProfileFull }
  | { event: 'error'; data: { error: string } };

export class RobloxApiClient {
  /**
   * Fetch full outfit and group telemetry for a user — классический JSON (fallback)
   */
  public static async fetchUserProfile(query: string, fresh = false, signal?: AbortSignal): Promise<RobloxUserProfileFull> {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
      throw new Error('Please enter a valid Roblox username or user ID.');
    }
    const response = await axios.get<RobloxUserProfileFull>(
      `${API_BASE}/user/${encodeURIComponent(cleanQuery)}`,
      {
        params: { fresh: fresh ? 'true' : undefined },
        timeout: 20000,
        signal,
      }
    );
    return response.data;
  }

  /**
   * 3️⃣ SSE Streaming — Probabilistic Early Valuation
   * TTFB ~180ms: первый чанк valuation приходит до полного catalog, клиент рисует цену инкрементально.
   * Если SSE не поддерживается / abort — fallback к fetchUserProfile.
   */
  public static async fetchUserProfileStream(
    query: string,
    onEvent?: (ev: StreamEvent) => void,
    fresh = false,
    signal?: AbortSignal
  ): Promise<RobloxUserProfileFull> {
    const cleanQuery = query.trim();
    if (!cleanQuery) throw new Error('Please enter a valid Roblox username or user ID.');

    // если нет onEvent — просто обычный fetch (совместимость)
    if (!onEvent || typeof window === 'undefined' || !window.fetch || !window.ReadableStream) {
      return this.fetchUserProfile(query, fresh, signal);
    }

    const url = `${API_BASE}/user/${encodeURIComponent(cleanQuery)}?stream=true${fresh ? '&fresh=true' : ''}`;
    let fullProfile: RobloxUserProfileFull | null = null;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'text/event-stream' },
        signal,
      });
      if (!res.ok || !res.body) {
        // fallback to JSON
        return this.fetchUserProfile(query, fresh, signal);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';
      const tryParse = (raw: string) => { try { return JSON.parse(raw); } catch { return raw; } };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // parse SSE frames (\n\n)
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split('\n');
          let event = currentEvent;
          let dataRaw = '';
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
            else if (line.startsWith(':')) { /* comment/keepalive */ }
          }
          if (!dataRaw) continue;
          const data = tryParse(dataRaw);
          if (event === 'done' && data && (data as RobloxUserProfileFull).user) {
            fullProfile = data as RobloxUserProfileFull;
            onEvent({ event: 'done', data } as StreamEvent);
          } else {
            onEvent({ event: event as StreamEvent['event'], data } as StreamEvent);
          }
          currentEvent = 'message';
        }
      }
      if (fullProfile) return fullProfile;
      // если done не пришёл — fallback
      return this.fetchUserProfile(query, fresh, signal);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err;
      // сетевой сбой SSE — fallback к JSON
      try { return await this.fetchUserProfile(query, fresh, signal); } catch { throw err; }
    }
  }

  /**
   * Check proxy status
   */
  public static async checkHealth(): Promise<boolean> {
    try {
      const res = await axios.get(`${API_BASE}/health`, { timeout: 3000 });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Fetch group store / catalog items with pagination, filters and sorting
   */
  public static async fetchGroupStore(
    groupId: number,
    cursor = '',
    limit = 100,
    sortType: 'RecentlyCreated' | 'PriceAsc' | 'PriceDesc' | 'Relevance' = 'RecentlyCreated',
    sortOrder: 'Asc' | 'Desc' = 'Desc',
    signal?: AbortSignal
  ): Promise<{ items: RobloxAssetItem[]; nextPageCursor: string | null }> {
    const response = await axios.get<{ items: RobloxAssetItem[]; nextPageCursor: string | null }>(
      `${API_BASE}/group/${groupId}/store`,
      {
        params: {
          cursor: cursor || undefined,
          limit,
          sortType,
          sortOrder,
        },
        timeout: 15000,
        signal,
      }
    );
    return response.data;
  }
}
