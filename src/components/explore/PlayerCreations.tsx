import React, { useCallback } from 'react';
import { Store } from 'lucide-react';
import { RobloxApiClient } from '../../services/api';
import type { RobloxAssetItem, RobloxGroupMembership } from '../../types/roblox';
import { AssetCard } from '../AssetCard';
import { CreatorAssetGrid } from './CreatorAssetGrid';
import { ExperienceList } from './ExperienceList';
import { SourceChip } from './SourceChip';
import { FeedFooter, useFeed } from './useFeed';

const Section: React.FC<{ title: string; chip?: React.ReactNode; children: React.ReactNode }> = ({ title, chip, children }) => (
  <section aria-label={title} className="space-y-3">
    <h4 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-white/45">{title}{chip}</h4>
    {children}
  </section>
);

interface PlayerCreationsProps {
  user: { id: number; name: string };
  groups: RobloxGroupMembership[];
  onOpenGroup: (group: RobloxGroupMembership) => void;
}

/** What the player made, apart from what their groups made (and from what they wear: the ARCHIVE tab). */
export const PlayerCreations: React.FC<PlayerCreationsProps> = ({ user, groups, onOpenGroup }) => {
  const load = useCallback(async (cursor: string, signal: AbortSignal) => {
    const page = await RobloxApiClient.fetchUserCreations(user.id, cursor, signal);
    return { items: page.items, next: page.nextPageCursor };
  }, [user.id]);
  const catalog = useFeed<RobloxAssetItem>(`creations:${user.id}`, load, true);
  const owned = groups.filter((g) => g.roleRank === 255);
  const creator = { kind: 'user' as const, id: user.id };

  return (
    <div className="space-y-8">
      <Section title="Clothing & accessories" chip={<SourceChip kind="player" name={user.name} />}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {catalog.items.map((item, i) => <AssetCard key={item.id} item={item} index={i} />)}
        </div>
        <FeedFooter feed={catalog} empty="No public clothing or accessories found." />
      </Section>
      <Section title="Experiences" chip={<SourceChip kind="player" name={user.name} />}>
        <ExperienceList creator={creator} />
      </Section>
      <Section title="Creator assets" chip={<SourceChip kind="player" name={user.name} />}>
        <CreatorAssetGrid creator={creator} />
      </Section>
      <Section title="From their groups">
        {owned.length === 0 ? (
          <p className="text-xs font-mono text-white/40">This player doesn’t own any public groups.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {owned.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => onOpenGroup(g)}
                className="flex min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-2 text-left transition-colors hover:border-white/25 hover:bg-white/[0.07]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/50">
                  {g.iconUrl ? <img src={g.iconUrl} alt="" className="h-full w-full object-cover" /> : <Store className="h-4 w-4 text-white/30" />}
                </span>
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block truncate text-xs font-medium text-white/90">{g.name}</span>
                  <SourceChip kind="group" name={g.name} />
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};
