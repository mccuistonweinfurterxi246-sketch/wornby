import React, { useCallback } from 'react';
import { ExternalLink, Gamepad2 } from 'lucide-react';
import { RobloxApiClient } from '../../services/api';
import type { Creator, Experience } from '../../types/roblox';
import { FeedFooter, useFeed } from './useFeed';

export const ExperienceList: React.FC<{ creator: Creator }> = ({ creator }) => {
  const load = useCallback(async (cursor: string, signal: AbortSignal) => {
    const page = await RobloxApiClient.fetchExperiences(creator, cursor, signal);
    return { items: page.experiences, next: page.nextPageCursor };
  }, [creator.kind, creator.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const feed = useFeed<Experience>(`experiences:${creator.kind}:${creator.id}`, load, true);

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {feed.items.map((g) => (
          <a
            key={g.universeId}
            href={`https://www.roblox.com/games/${g.placeId}`}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-2 transition-colors hover:border-white/25 hover:bg-white/[0.07]"
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/50">
              {g.iconUrl ? <img src={g.iconUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Gamepad2 className="h-5 w-5 text-white/30" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium text-white/90">{g.name}</span>
                {g.moderated && <span className="shrink-0 rounded border border-amber-300/30 px-1 text-[9px] font-mono text-amber-200/80">MODERATED</span>}
              </span>
              <span className="block truncate text-[10px] font-mono text-white/45">
                {g.visits.toLocaleString()} visits{g.updated ? ` · updated ${g.updated.slice(0, 10)}` : ''}
              </span>
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-white/30" />
          </a>
        ))}
      </div>
      <FeedFooter feed={feed} empty="No public experiences found." />
    </div>
  );
};
