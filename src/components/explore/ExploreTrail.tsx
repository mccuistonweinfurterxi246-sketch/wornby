import React, { useEffect, useState } from 'react';
import { ChevronRight, Store, User } from 'lucide-react';
import { readTrail, type TrailEntry } from '../../lib/exploreTrail';

/** The current history entry's trail, kept fresh on navigation and back/forward. */
export function useTrail(): TrailEntry[] {
  const [trail, setTrail] = useState<TrailEntry[]>(readTrail);
  useEffect(() => {
    const sync = () => setTrail(readTrail());
    window.addEventListener('popstate', sync);
    window.addEventListener('wornby:trail', sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('wornby:trail', sync); };
  }, []);
  return trail;
}

/** One row of crumbs (players and groups); the last one is where you are. Hidden until there are two. */
export const ExploreTrail: React.FC<{ onNavigate: (entry: TrailEntry) => void; className?: string }> = ({ onNavigate, className = '' }) => {
  const trail = useTrail();
  if (trail.length < 2) return null;
  return (
    <nav aria-label="Explore trail" className={`flex min-w-0 items-center gap-1 overflow-x-auto no-scrollbar text-[11px] font-mono ${className}`}>
      {trail.map((entry, i) => {
        const current = i === trail.length - 1;
        const icon = entry.imageUrl
          ? <img src={entry.imageUrl} alt="" className={`h-4 w-4 shrink-0 object-cover ${entry.kind === 'user' ? 'rounded-full' : 'rounded'}`} />
          : entry.kind === 'user' ? <User className="h-3 w-3 shrink-0" /> : <Store className="h-3 w-3 shrink-0" />;
        return (
          <React.Fragment key={`${entry.kind}:${entry.id}`}>
            {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-white/25" />}
            {current ? (
              <span aria-current="page" className="flex shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 text-white">{icon}<span className="max-w-[10rem] truncate">{entry.name}</span></span>
            ) : (
              <button type="button" onClick={() => onNavigate(entry)} className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-white/55 hover:bg-white/[0.07] hover:text-white">
                {icon}<span className="max-w-[10rem] truncate">{entry.name}</span>
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
};
