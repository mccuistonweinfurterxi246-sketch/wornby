import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

type Page<T> = { items: T[]; next: string | null };
type Entry = { items: unknown[]; next: string | null; started: boolean };

// Pages already loaded per feed key: Back to a feed is instant and keeps its loaded pages.
const feedCache = new Map<string, Entry>();

function errorText(err: unknown): string {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status && status < 500 && status !== 429 ? "Couldn't load this list." : 'Roblox is busy right now.';
}

/** Paged, lazily loaded feed with a module-level page cache; aborts when the key changes. */
export function useFeed<T>(key: string, load: (cursor: string, signal: AbortSignal) => Promise<Page<T>>, enabled: boolean) {
  const cached = feedCache.get(key);
  const [items, setItems] = useState<T[]>((cached?.items as T[]) || []);
  const [next, setNext] = useState<string | null>(cached?.next ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const fetchPage = useCallback(async (cursor: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const page = await loadRef.current(cursor, ac.signal);
      if (ac.signal.aborted) return;
      const prev = cursor ? ((feedCache.get(key)?.items as T[]) || []) : [];
      const merged = [...prev, ...page.items];
      feedCache.set(key, { items: merged, next: page.next, started: true });
      setItems(merged);
      setNext(page.next);
    } catch (err) {
      if (ac.signal.aborted || (err as { name?: string })?.name === 'CanceledError') return;
      setError(errorText(err));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    const hit = feedCache.get(key);
    setItems((hit?.items as T[]) || []);
    setNext(hit?.next ?? null);
    setError(null);
    setLoading(false);
    if (enabled && !hit?.started) void fetchPage('');
    return () => abortRef.current?.abort();
  }, [key, enabled, fetchPage]);

  const loadMore = useCallback(() => { if (next && !loading) void fetchPage(next); }, [fetchPage, loading, next]);
  // Retry the page that failed: the first one, or the next one after what already loaded.
  const retry = useCallback(() => void fetchPage(items.length ? next || '' : ''), [fetchPage, items.length, next]);
  return { items, loading, error, hasMore: !!next, loadMore, retry };
}

/** Loading / error / empty / load-more row shared by every feed. */
export const FeedFooter: React.FC<{ feed: { items: unknown[]; loading: boolean; error: string | null; hasMore: boolean; loadMore: () => void; retry: () => void }; empty: string }> = ({ feed, empty }) => {
  if (feed.error) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center" role="alert">
        <p className="text-xs font-mono text-white/55">{feed.error}</p>
        <button type="button" onClick={feed.retry} className="flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-xs font-mono text-white hover:bg-white/15">
          <RefreshCw className="h-3.5 w-3.5" /> RETRY
        </button>
      </div>
    );
  }
  if (feed.loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs font-mono text-white/40" role="status">
        <RefreshCw className="h-4 w-4 animate-spin" /> LOADING…
      </div>
    );
  }
  if (!feed.items.length) return <p className="py-10 text-center text-xs font-mono text-white/40">{empty}</p>;
  if (!feed.hasMore) return null;
  return (
    <div className="flex justify-center pt-5">
      <button type="button" onClick={feed.loadMore} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-5 py-2.5 text-xs font-mono text-white hover:bg-white/[0.12]">
        LOAD MORE
      </button>
    </div>
  );
};
