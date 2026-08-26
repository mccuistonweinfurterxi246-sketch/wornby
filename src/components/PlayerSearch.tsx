import React, { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Clock3, LoaderCircle, Search, Trash2, UserRound, X } from 'lucide-react';
import { RobloxApiClient, RobloxUserSearchResult } from '../services/api';
import { normalizePlayerQuery, RecentPlayer, usePlayerHistory } from '../hooks/usePlayerHistory';
import { SearchButton } from './SearchButton';

interface PlayerSearchProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
  variant?: 'hero' | 'compact';
}

type PlayerRowData = RobloxUserSearchResult | RecentPlayer;

export const PlayerSearch: React.FC<PlayerSearchProps> = ({ onSearch, isLoading, variant = 'hero' }) => {
  const [query, setQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<RobloxUserSearchResult[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimerRef = useRef<number | null>(null);
  const { recentPlayers, removePlayer, clearHistory } = usePlayerHistory();
  const isCompact = variant === 'compact';

  useEffect(() => {
    const keyword = normalizePlayerQuery(query);
    if (keyword.length < 2 || /^\d+$/.test(keyword) || query.includes('roblox.com/')) {
      setSuggestions([]);
      setIsSuggesting(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsSuggesting(true);
      try {
        setSuggestions(await RobloxApiClient.searchUsers(keyword, controller.signal));
      } catch {
        if (!controller.signal.aborted) setSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setIsSuggesting(false);
      }
    }, 260);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => () => {
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFocused(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  const submit = (value = query) => {
    const normalized = normalizePlayerQuery(value);
    if (!normalized || isLoading) return;
    onSearch(normalized);
    setIsFocused(false);
    setSuggestions([]);
  };

  const choosePlayer = (player: PlayerRowData) => {
    setQuery(player.name);
    submit(player.name);
  };

  const suggestionIds = new Set(suggestions.map((player) => player.id));
  const visibleRecentPlayers = recentPlayers.filter((player) => !suggestionIds.has(player.id)).slice(0, 8);

  const showPanel = isFocused && (suggestions.length > 0 || isSuggesting || recentPlayers.length > 0);

  return (
    <div className="relative w-full">
      <form onSubmit={(event) => { event.preventDefault(); submit(); }} className={`relative flex items-center gap-2 ${isCompact ? 'rounded-xl' : 'rounded-2xl p-2 sm:p-2.5 bg-black/35 backdrop-blur-xl border border-white/[0.06] shadow-2xl'}`}>
        <div className="relative flex-1 flex items-center min-w-0">
          <Search className="absolute left-3.5 w-4 h-4 text-white/35 pointer-events-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => {
              if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
              setIsFocused(true);
            }}
            onBlur={() => {
              blurTimerRef.current = window.setTimeout(() => setIsFocused(false), 150);
            }}
            placeholder={isCompact ? 'inspect another user...' : 'username, Roblox ID, or profile link'}
            aria-label="Roblox username, user ID, or profile link"
            autoComplete="off"
            spellCheck="false"
            disabled={isLoading}
            className={`w-full bg-white/[0.04] text-white placeholder:text-white/30 focus:outline-none font-mono ${isCompact ? 'text-xs pl-10 pr-32 py-2.5 rounded-xl border border-white/[0.06] focus:border-white/30' : 'h-11 text-sm sm:text-lg px-10 rounded-xl border border-white/[0.06] focus:border-white/20'}`}
          />
          {query && <button type="button" onClick={() => { setQuery(''); inputRef.current?.focus(); }} aria-label="Clear player search" className={`absolute ${isCompact ? 'right-[5.75rem]' : 'right-3'} rounded-md p-1 text-white/40 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60`}><X className="w-4 h-4" /></button>}
        </div>
        {isCompact ? (
          <button type="submit" disabled={isLoading || !query.trim()} className="absolute right-1.5 flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white font-mono text-xs px-3 py-1.5 transition-colors disabled:opacity-30">
            {isLoading ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            <span>{isLoading ? 'LOADING' : 'FIND'}</span>
          </button>
        ) : (
          <div className="w-full sm:w-auto flex-shrink-0 relative z-20">
            <SearchButton isLoading={isLoading} disabled={isLoading || !query.trim()} />
          </div>
        )}
      </form>

      {showPanel && <div className="absolute left-0 right-0 z-40 mt-2 max-h-[min(70vh,32rem)] overflow-y-auto fancy-scroll rounded-2xl border border-white/[0.12] bg-neutral-950/95 p-1.5 backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.55)]">
        {isSuggesting && <div className="flex items-center gap-2 px-3 py-2.5 text-xs font-mono text-white/45"><LoaderCircle className="w-3.5 h-3.5 animate-spin" /> Searching Roblox users...</div>}
        {suggestions.length > 0 && <div className="border-b border-white/[0.08] pb-1.5">
          <div className="px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] font-mono text-white/30">Player matches</div>
          {suggestions.map((player) => <PlayerRow key={player.id} player={player} onClick={() => choosePlayer(player)} />)}
        </div>}
        {recentPlayers.length > 0 && <div className="pt-1">
          <div className="flex items-center justify-between px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] font-mono text-white/35">
            <span className="flex items-center gap-1.5"><Clock3 className="w-3 h-3" /> Recent players</span>
            <button type="button" onClick={clearHistory} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-white/35 hover:bg-white/[0.06] hover:text-rose-300"><Trash2 className="w-3 h-3" /> Clear</button>
          </div>
          {visibleRecentPlayers.map((player) => <PlayerRow key={player.id} player={player} onClick={() => choosePlayer(player)} onRemove={() => removePlayer(player.id)} />)}
        </div>}
      </div>}
    </div>
  );
};

const PlayerRow: React.FC<{ player: PlayerRowData; onClick: () => void; onRemove?: () => void }> = ({ player, onClick, onRemove }) => (
  <div className="group flex min-h-14 items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-white/[0.07] transition-colors">
    <button type="button" onClick={onClick} className="flex items-center gap-3 min-w-0 flex-1 text-left">
      {player.headshotUrl ? <img src={player.headshotUrl} alt="" className="h-10 w-10 rounded-full object-cover bg-white/5 ring-1 ring-white/10" /> : <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.08] text-white/50 ring-1 ring-white/10"><UserRound className="w-4 h-4" /></div>}
      <span className="min-w-0 flex-1"><span className="flex items-center gap-1 truncate text-sm text-white/90"><span className="truncate">{player.displayName}</span>{'hasVerifiedBadge' in player && player.hasVerifiedBadge && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-label="Verified player" />}</span><span className="block truncate text-[11px] font-mono text-cyan-300/70">@{player.name}</span></span>
    </button>
    {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${player.name} from recent players`} className="p-2 text-white/35 hover:text-rose-300 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"><X className="w-3.5 h-3.5" /></button>}
  </div>
);
