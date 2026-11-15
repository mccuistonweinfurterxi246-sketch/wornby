import React, { useCallback, useState } from 'react';
import { BadgeCheck, User } from 'lucide-react';
import { RobloxApiClient } from '../../services/api';
import type { GroupMember } from '../../types/roblox';
import { FeedFooter, useFeed } from './useFeed';

interface MemberGridProps {
  groupId: number;
  onOpenPlayer: (m: GroupMember) => void;
}

type Owner = { id: number; name: string; displayName: string } | null;
// Groups whose member list Roblox hides (kept per group so Back shows the same answer from cache).
const hiddenLists = new Map<number, Owner>();

export const MemberGrid: React.FC<MemberGridProps> = ({ groupId, onOpenPlayer }) => {
  const [, rerender] = useState(0);
  const load = useCallback(async (cursor: string, signal: AbortSignal) => {
    const page = await RobloxApiClient.fetchGroupMembers(groupId, cursor, signal);
    if (page.hidden) { hiddenLists.set(groupId, page.owner ?? null); rerender((n) => n + 1); }
    return { items: page.members, next: page.nextPageCursor };
  }, [groupId]);
  const feed = useFeed<GroupMember>(`members:${groupId}`, load, true);

  if (hiddenLists.has(groupId)) {
    const owner = hiddenLists.get(groupId);
    const asMember = owner && { ...owner, verified: false, role: { name: 'Owner', rank: 255 }, headshotUrl: null };
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-xs font-mono text-white/55">Roblox doesn't show this group's member list publicly.</p>
        {asMember && (
          <button type="button" onClick={() => onOpenPlayer(asMember)} aria-label={`Open @${asMember.name}`} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/85 hover:border-white/25 hover:bg-white/[0.07]">
            <User className="h-3.5 w-3.5 text-white/40" /> Owner: {asMember.displayName} <span className="font-mono text-[10px] text-white/45">@{asMember.name}</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {feed.items.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onOpenPlayer(m)}
            aria-label={`Open @${m.name}`}
            className="flex min-w-0 items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-2 text-left transition-colors hover:border-white/25 hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/50">
              {m.headshotUrl ? <img src={m.headshotUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <User className="h-4 w-4 text-white/30" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 truncate text-xs font-medium text-white/90">
                <span className="truncate">{m.displayName}</span>
                {m.verified && <BadgeCheck className="h-3 w-3 shrink-0 text-white" />}
              </span>
              <span className="block truncate text-[10px] font-mono text-white/45">@{m.name} · {m.role.name}</span>
            </span>
          </button>
        ))}
      </div>
      <FeedFooter feed={feed} empty="No public members found." />
    </div>
  );
};
