import React, { useCallback, useEffect, useState } from 'react';
import { Box } from 'lucide-react';
import { RobloxApiClient } from '../../services/api';
import type { Creator, CreatorAsset, CreatorAssetType } from '../../types/roblox';
import { FeedFooter, useFeed } from './useFeed';

// Avatar-adjacent Creator Store types only (audio and plugins are not offered).
const TYPES: [CreatorAssetType, string][] = [['model', 'MODELS'], ['decal', 'DECALS'], ['mesh', 'MESHES']];

type Counts = Record<CreatorAssetType, number>;
const countsCache = new Map<string, Counts>();

export const CreatorAssetGrid: React.FC<{ creator: Creator }> = ({ creator }) => {
  const key = `${creator.kind}:${creator.id}`;
  const [counts, setCounts] = useState<Counts | null>(countsCache.get(key) ?? null);
  const [countsFailed, setCountsFailed] = useState(false);
  const [type, setType] = useState<CreatorAssetType>('model');
  // Exact counts first: only types this creator actually has are offered.
  useEffect(() => {
    const hit = countsCache.get(key);
    const pick = (c: Counts) => setType(TYPES.find(([t]) => c[t] > 0)?.[0] ?? 'model');
    if (hit) { setCounts(hit); pick(hit); return; }
    const ac = new AbortController();
    setCounts(null);
    setCountsFailed(false);
    RobloxApiClient.fetchAssetsSummary(creator, ac.signal)
      .then((c) => { countsCache.set(key, c); setCounts(c); pick(c); })
      .catch(() => { if (!ac.signal.aborted) setCountsFailed(true); });
    return () => ac.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async (cursor: string, signal: AbortSignal) => {
    const page = await RobloxApiClient.fetchCreatorAssets(creator, type, cursor, signal);
    return { items: page.assets, next: page.nextPageCursor };
  }, [creator.kind, creator.id, type]); // eslint-disable-line react-hooks/exhaustive-deps
  const available = counts ? TYPES.filter(([t]) => counts[t] > 0) : [];
  const feed = useFeed<CreatorAsset>(`assets:${creator.kind}:${creator.id}:${type}`, load, available.some(([t]) => t === type));

  if (countsFailed) return <p className="py-10 text-center text-xs font-mono text-white/55">Roblox is busy right now.</p>;
  if (!counts) return <p className="py-8 text-center text-xs font-mono text-white/40" role="status">LOADING…</p>;
  if (!available.length) return <p className="py-10 text-center text-xs font-mono text-white/40">No Creator Store assets published.</p>;

  return (
    <div>
      <div className="mb-3 flex gap-1.5 overflow-x-auto no-scrollbar">
        {available.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={type === value}
            onClick={() => setType(value)}
            className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[10px] font-mono transition-colors ${type === value ? 'border-white/30 bg-white/15 text-white' : 'border-white/10 bg-white/[0.03] text-white/55 hover:text-white'}`}
          >
            {label} <span className="tabular-nums opacity-60">{counts[value].toLocaleString()}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {feed.items.map((a) => (
          <a
            key={a.id}
            href={`https://create.roblox.com/store/asset/${a.id}`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-2 transition-colors hover:border-white/25 hover:bg-white/[0.07]"
          >
            <span className="mb-2 flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-black/40">
              {a.thumbnailUrl ? <img src={a.thumbnailUrl} alt="" className="h-full w-full object-contain" loading="lazy" /> : <Box className="h-6 w-6 text-white/20" />}
            </span>
            <span className="block truncate text-xs text-white/85">{a.name}</span>
            <span className="block text-[10px] font-mono text-white/35">#{a.id}</span>
          </a>
        ))}
      </div>
      <FeedFooter feed={feed} empty="No public assets of this type." />
    </div>
  );
};
