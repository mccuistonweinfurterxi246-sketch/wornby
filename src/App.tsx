import React, { useState, useEffect, useCallback } from 'react';
import { RobloxUserProfileFull } from './types/roblox';
import { RobloxApiClient } from './services/api';
import { Stage1Hero } from './components/Stage1Hero';
import { NoiseOverlay } from './components/NoiseOverlay';
import { Toaster } from './components/ui/sonner';
import { AudioHaptics } from './components/AudioHaptics';
import { usePlayerHistory } from './hooks/usePlayerHistory';
import { ViewedGroupsDrawer } from './components/ViewedGroupsDrawer';

const DEFAULT_TITLE = document.title;

const Stage2Inspector = React.lazy(() => import('./components/Stage2Inspector').then((module) => ({ default: module.Stage2Inspector })));

export const App: React.FC = () => {
  const [profileData, setProfileData] = useState<RobloxUserProfileFull | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [streamingValuation, setStreamingValuation] = useState<{ totalValueRobux: number; pricedCount: number; seen: number; total: number } | null>(null);
  const { recordPlayer } = usePlayerHistory();
  // race protection
  const searchSeqRef = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const profileRef = React.useRef(profileData);
  profileRef.current = profileData;
  const loadingQueryRef = React.useRef<string | null>(null);

  const handleSearch = useCallback(async (query: string, fresh = false, historyMode: 'push' | 'replace' | 'none' = 'push') => {
    const seq = ++searchSeqRef.current;
    // abort previous
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    loadingQueryRef.current = query;
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

      // Update URL search query without page reload
      const url = new URL(window.location.href);
      // an open-store link belongs to the previous player (the tab carries over, like the view does)
      if (historyMode === 'push' && url.searchParams.get('u')?.toLowerCase() !== data.user.name.toLowerCase()) {
        url.searchParams.delete('store');
      }
      url.searchParams.set('u', data.user.name);
      if (historyMode === 'push') window.history.pushState({}, '', url.toString());
      else if (historyMode === 'replace') window.history.replaceState({}, '', url.toString());
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
      if (seq === searchSeqRef.current) { loadingQueryRef.current = null; setIsLoading(false); setStreamingValuation(null); }
    }
  }, [recordPlayer]);

  const handleBackToHero = useCallback(() => {
    searchSeqRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    loadingQueryRef.current = null;
    setIsLoading(false);
    setStreamingValuation(null);
    setProfileData(null);
    setErrorMessage(null);
    const url = new URL(window.location.href);
    ['u', 'tab', 'store'].forEach((key) => url.searchParams.delete(key));
    window.history.pushState({}, '', url.toString());
  }, []);

  // Initial check for ?u=username URL param + back/forward handling
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // only a link opens a profile; a bare visit shows the start page with recent players
    const initialUser = params.get('u');
    if (initialUser && initialUser.trim()) {
      handleSearch(initialUser.trim(), false, 'replace');
    }
    const onPopState = () => {
      const u = new URLSearchParams(window.location.search).get('u')?.trim();
      const shown = profileRef.current?.user;
      const isShown = (q: string) => !!shown && (q.toLowerCase() === shown.name.toLowerCase() || q === String(shown.id));
      if (u && isShown(u)) {
        // same player, only the tab or store changed (the inspector restores those): drop a load of another player
        const loading = loadingQueryRef.current;
        if (loading && !isShown(loading)) {
          searchSeqRef.current++;
          abortRef.current?.abort();
          abortRef.current = null;
          loadingQueryRef.current = null;
          setIsLoading(false);
          setStreamingValuation(null);
        }
      } else if (u) handleSearch(u, false, 'none');
      else {
        searchSeqRef.current++;
        abortRef.current?.abort();
        abortRef.current = null;
        loadingQueryRef.current = null;
        setIsLoading(false);
        setStreamingValuation(null);
        setProfileData(null);
        setErrorMessage(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => { window.removeEventListener('popstate', onPopState); abortRef.current?.abort(); };
  }, [handleSearch]);

  useEffect(() => {
    document.title = profileData ? `${profileData.user.displayName} (@${profileData.user.name}) · Syntax3` : DEFAULT_TITLE;
  }, [profileData]);

  return (
    <div className="relative min-h-screen font-sans">
      {/* Global Grain Noise Texture */}
      <NoiseOverlay />

      {/* Loading overlay when profile exists but new search in flight — shows streaming valuation */}
      {isLoading && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none" aria-live="polite" aria-busy="true">
          <div className="px-4 py-2 rounded-xl bg-black/80 backdrop-blur-md border border-white/10 text-xs font-mono text-white/80 flex items-center gap-3 shadow-xl">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>{streamingValuation ? `VALUING ${streamingValuation.seen}/${streamingValuation.total} • ${streamingValuation.totalValueRobux.toLocaleString()} R$` : 'LOADING PROFILE…'}</span>
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
        <React.Suspense fallback={<div className="p-6 text-center text-sm font-mono text-white/70" role="status">Loading inspector...</div>}>
          <Stage2Inspector
            data={profileData}
            onNewSearch={handleSearch}
            onBackToHero={handleBackToHero}
            isLoading={isLoading}
          />
        </React.Suspense>
      )}
      <ViewedGroupsDrawer />
      <Toaster />
    </div>
  );
};

export default App;
