import { useCallback, useEffect, useState } from 'react';

export interface RecentPlayer {
  id: number;
  name: string;
  displayName: string;
  headshotUrl: string | null;
  viewedAt: number;
}

const HISTORY_KEY = 'wornby_recent_players_v1';
const LAST_KEY = 'wornby_last_roblox_player_v1';
const EVENT_KEY = 'wornby_recent_players_updated';
const MAX_HISTORY = 8;

function loadHistory(): RecentPlayer[] {
  try {
    if (typeof window === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function loadLastPlayer(): RecentPlayer | null {
  try {
    if (typeof window === 'undefined') return null;
    const parsed = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    return parsed && typeof parsed.id === 'number' ? parsed as RecentPlayer : null;
  } catch {
    return null;
  }
}

export function normalizePlayerQuery(value: string): string {
  const query = value.trim();
  const profileMatch = query.match(/roblox\.com\/users\/(\d+)/i);
  if (profileMatch) return profileMatch[1];
  return query.replace(/^@+/, '');
}

export function usePlayerHistory() {
  const [recentPlayers, setRecentPlayers] = useState<RecentPlayer[]>(() => loadHistory());
  const [lastPlayer, setLastPlayer] = useState<RecentPlayer | null>(() => loadLastPlayer());

  useEffect(() => {
    const sync = () => {
      setRecentPlayers(loadHistory());
      setLastPlayer(loadLastPlayer());
    };
    window.addEventListener(EVENT_KEY, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT_KEY, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const persist = (players: RecentPlayer[]) => {
    setRecentPlayers(players);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(players));
    window.dispatchEvent(new Event(EVENT_KEY));
  };

  const recordPlayer = useCallback((player: Omit<RecentPlayer, 'viewedAt'>) => {
    const recordedPlayer: RecentPlayer = { ...player, viewedAt: Date.now() };
    const next = [recordedPlayer, ...loadHistory().filter((item) => item.id !== player.id)].slice(0, MAX_HISTORY);
    persist(next);
    setLastPlayer(recordedPlayer);
    localStorage.setItem(LAST_KEY, JSON.stringify(recordedPlayer));
    window.dispatchEvent(new Event(EVENT_KEY));
  }, []);

  const removePlayer = useCallback((id: number) => {
    persist(loadHistory().filter((item) => item.id !== id));
    const currentLast = loadLastPlayer();
    if (currentLast?.id === id) {
      localStorage.removeItem(LAST_KEY);
      setLastPlayer(null);
      window.dispatchEvent(new Event(EVENT_KEY));
    }
  }, []);

  const clearHistory = useCallback(() => {
    persist([]);
    localStorage.removeItem(LAST_KEY);
    setLastPlayer(null);
  }, []);

  return { recentPlayers, lastPlayer, recordPlayer, removePlayer, clearHistory };
}
