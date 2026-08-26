import React, { useState, useEffect, useCallback } from 'react';
import { RobloxUserProfileFull } from './types/roblox';
import { RobloxApiClient } from './services/api';
import { Stage1Hero } from './components/Stage1Hero';
import { Stage2Inspector } from './components/Stage2Inspector';
import { NoiseOverlay } from './components/NoiseOverlay';
import { Toaster } from './components/ui/sonner';
import { AudioHaptics } from './components/AudioHaptics';
import { usePlayerHistory } from './hooks/usePlayerHistory';

export const App: React.FC = () => {
  const [profileData, setProfileData] = useState<RobloxUserProfileFull | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [streamingValuation, setStreamingValuation] = useState<{ totalValueRobux: number; pricedCount: number; seen: number; total: number } | null>(null);
  const { lastPlayer, recordPlayer } = usePlayerHistory();
  // race protection
  const searchSeqRef = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);

  const handleSearch = useCallback(async (query: string, fresh = false) => {
    const seq = ++searchSeqRef.current;
    // abort previous
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setIsLoading(true);
    setErrorMessage(null);
    setStreamingValuation(null);

    try {
      // 3️⃣ Probabilistic Early Valuation — стримим incremental valuation (TTFB ~180ms)
      const data = await RobloxApiClient.fetchUserProfileStream(query, (ev) => {
        if (seq !== searchSeqRef.current || ac.signal.aborted) return;
        if (ev.event === 'valuation') {
          const v = ev.data as { totalValueRobux: number; pricedCount: number; seen: number; total: number };
          setStreamingValuation({ totalValueRobux: v.totalValueRobux, pricedCount: v.pricedCount, seen: v.seen, total: v.total });
        }
        if (ev.event === 'fingerprint') {
          // fingerprint skip hit — можно показать cached badge
        }
      }, fresh, ac.signal);
      if (ac.signal.aborted || seq !== searchSeqRef.current) return;
      setProfileData(data);
      recordPlayer({
        id: data.user.id,
        name: data.user.name,
        displayName: data.user.displayName,
        headshotUrl: data.thumbnails.headshotUrl,
      });
      try { localStorage.setItem('wornby_last_roblox_username', data.user.name); } catch {}

      // Update URL search query without page reload
      const url = new URL(window.location.href);
      url.searchParams.set('u', data.user.name);
      window.history.pushState({}, '', url.toString());
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError' || (err as { code?: string })?.code === 'ERR_CANCELED') return;
      if (seq !== searchSeqRef.current) return;
      const error = err as { response?: { data?: { error?: string }; status?: number }; message?: string };
      let rawMsg = error.response?.data?.error || error.message || 'Failed to retrieve Roblox profile.';
      // friendly mapping
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 429) rawMsg = 'Too many requests — please wait a moment and try again.';
      else if (status === 404) rawMsg = typeof rawMsg === 'string' ? rawMsg : 'User not found.';
      else if (typeof rawMsg === 'string' && rawMsg.toLowerCase().includes('timeout')) rawMsg = 'Request timed out — Roblox is slow, try again.';
      // sanitize
      const msg = typeof rawMsg === 'string' ? rawMsg.slice(0,300) : JSON.stringify(rawMsg).slice(0,300);
      setErrorMessage(msg);
      AudioHaptics.playErrorPulse();
    } finally {
      if (seq === searchSeqRef.current) { setIsLoading(false); setStreamingValuation(null); }
    }
  }, [recordPlayer]);

  const handleBackToHero = useCallback(() => {
    setProfileData(null);
    setErrorMessage(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('u');
    window.history.pushState({}, '', url.toString());
  }, []);

  // Initial check for ?u=username URL param + back/forward handling
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialUser = params.get('u') || lastPlayer?.name || localStorage.getItem('wornby_last_roblox_username');
    if (initialUser && initialUser.trim()) {
      handleSearch(initialUser.trim());
    }
    const onPopState = () => {
      const u = new URLSearchParams(window.location.search).get('u');
      if (u && u.trim()) handleSearch(u.trim());
      else { abortRef.current?.abort(); setProfileData(null); setErrorMessage(null); }
    };
    window.addEventListener('popstate', onPopState);
    return () => { window.removeEventListener('popstate', onPopState); abortRef.current?.abort(); };
  }, [handleSearch]);

  return (
    <div className="relative min-h-screen font-sans">
      {/* Global Grain Noise Texture */}
      <NoiseOverlay />

      {/* Loading overlay when profile exists but new search in flight — shows streaming valuation */}
      {isLoading && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none" aria-live="polite" aria-busy="true">
          <div className="px-4 py-2 rounded-xl bg-black/80 backdrop-blur-md border border-white/10 text-xs font-mono text-white/80 flex items-center gap-3 shadow-xl">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>{streamingValuation ? `VALUING ${streamingValuation.seen}/${streamingValuation.total} • ${streamingValuation.totalValueRobux.toLocaleString()} R$` : 'LOADING TELEMETRY…'}</span>
            {streamingValuation && <span className="text-white/40">({streamingValuation.pricedCount} priced)</span>}
          </div>
        </div>
      )}
      {/* Screen View Switching */}
      {!profileData ? (
        <Stage1Hero
          onSearch={handleSearch}
          isLoading={isLoading}
          errorMessage={errorMessage}
        />
      ) : (
        <Stage2Inspector
          data={profileData}
          onNewSearch={handleSearch}
          onBackToHero={handleBackToHero}
          isLoading={isLoading}
        />
      )}
      <Toaster />
    </div>
  );
};

export default App;
