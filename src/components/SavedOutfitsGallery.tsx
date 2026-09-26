import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, RefreshCw, Shirt, X } from 'lucide-react';
import { RobloxSavedOutfit, RobloxSavedOutfitDetails } from '../types/roblox';
import { RobloxApiClient } from '../services/api';
import { useClipboard } from '../hooks/useClipboard';

export const SavedOutfitsGallery: React.FC<{ userId: number }> = ({ userId }) => {
  const [outfits, setOutfits] = useState<RobloxSavedOutfit[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<RobloxSavedOutfit | null>(null);
  const [details, setDetails] = useState<RobloxSavedOutfitDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState(false);
  const [detailsRetryKey, setDetailsRetryKey] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const { copied, copy } = useClipboard();

  const loadPage = useCallback(async (token = '') => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(false);
    try {
      const result = await RobloxApiClient.fetchSavedOutfits(userId, token, controller.signal);
      if (controller.signal.aborted) return;
      setOutfits((current) => {
        if (!token) return result.outfits;
        const existing = new Set(current.map((outfit) => outfit.id));
        return [...current, ...result.outfits.filter((outfit) => !existing.has(outfit.id))];
      });
      setNextPageToken(result.nextPageToken && result.nextPageToken !== token ? result.nextPageToken : null);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPage(), 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [loadPage]);

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  useEffect(() => {
    if (!selected) { setDetails(null); return; }
    const controller = new AbortController();
    setDetails(null);
    setDetailsError(false);
    setDetailsLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await RobloxApiClient.fetchSavedOutfitDetails(selected.id, controller.signal);
        if (!controller.signal.aborted) setDetails(result);
      } catch {
        if (!controller.signal.aborted) setDetailsError(true);
      } finally {
        if (!controller.signal.aborted) setDetailsLoading(false);
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [selected?.id, detailsRetryKey]);

  const copyAssetIds = async (ids: number[], key: string) => {
    if (ids.length > 0) await copy(ids.join(', '), key);
  };

  return (
    <section aria-label="Saved fits" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/40 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Saved fits</h3>
          <p className="mt-0.5 text-xs text-white/45">Outfits saved by this player · {outfits.length} loaded</p>
        </div>
        <button type="button" onClick={() => void loadPage()} disabled={loading} aria-label="Refresh saved fits" className="rounded-lg border border-white/10 p-2 text-white/55 hover:border-white/25 hover:text-white disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>

      {loading && outfits.length === 0 && <p role="status" className="rounded-xl border border-white/10 bg-black/30 px-5 py-12 text-center text-sm text-white/60">Loading saved fits…</p>}
      {error && outfits.length === 0 && <div className="rounded-xl border border-white/10 bg-black/30 px-5 py-12 text-center"><p className="text-sm text-white/65">Saved fits are unavailable right now.</p><button type="button" onClick={() => void loadPage()} className="mt-4 rounded-lg border border-white/20 px-4 py-2 text-xs text-white hover:bg-white/10">Try again</button></div>}
      {!loading && !error && outfits.length === 0 && <div className="rounded-xl border border-white/10 bg-black/30 px-5 py-12 text-center"><Shirt className="mx-auto mb-3 h-7 w-7 text-white/30" /><p className="text-sm text-white/65">No public saved fits were returned for this player.</p></div>}

      {outfits.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {outfits.map((outfit) => (
            <button key={outfit.id} type="button" onClick={() => setSelected(outfit)} aria-label={`View fit ${outfit.name}`} className="group overflow-hidden rounded-xl border border-white/10 bg-black/50 text-left transition-colors hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
              <span className="flex aspect-square items-center justify-center bg-white/[0.035]">
                {outfit.thumbnailUrl ? <img src={outfit.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" /> : <Shirt className="h-9 w-9 text-white/20" />}
              </span>
              <span className="block truncate px-3 pt-2.5 text-xs font-medium text-white" title={outfit.name}>{outfit.name}</span>
              <span className="block px-3 pb-3 pt-1 font-mono text-[10px] text-white/40">FIT #{outfit.id}</span>
            </button>
          ))}
        </div>
      )}

      {error && outfits.length > 0 && <p role="status" className="text-center text-xs text-amber-300">More fits could not be loaded. Try again.</p>}
      {nextPageToken && <div className="flex justify-center"><button type="button" disabled={loading} onClick={() => void loadPage(nextPageToken)} className="rounded-xl border border-white/20 bg-white/[0.05] px-5 py-2.5 text-xs font-mono text-white hover:bg-white/10 disabled:opacity-40">{loading ? 'LOADING…' : 'LOAD MORE FITS'}</button></div>}

      {selected && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`Fit ${selected.name}`}>
          <button type="button" className="absolute inset-0 bg-black/85" onClick={() => setSelected(null)} aria-label="Close fit preview" />
          <div className="relative max-h-[calc(100dvh-2rem)] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/20 bg-neutral-950 shadow-2xl fancy-scroll">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-neutral-950 px-4 py-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-white">{selected.name}</h3><p className="font-mono text-[10px] text-white/40">FIT #{selected.id}</p></div><button type="button" onClick={() => setSelected(null)} aria-label="Close fit preview" className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"><X className="h-5 w-5" /></button></div>
            <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              <div className="flex aspect-square max-h-80 items-center justify-center bg-white/[0.025] md:max-h-none">{selected.thumbnailUrl ? <img src={selected.thumbnailUrl} alt={`Full view of ${selected.name}`} className="h-full w-full object-contain" /> : <div className="text-center"><Shirt className="mx-auto h-12 w-12 text-white/20" /><p className="mt-3 text-xs text-white/45">Roblox has no preview for this fit.</p></div>}</div>
              <div className="min-w-0 border-t border-white/10 p-4 md:border-l md:border-t-0">
                <div className="mb-3 flex items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-white">Worn items</h4><p className="text-[11px] text-white/45">Clothing, accessories and gear</p></div><span className="font-mono text-xs text-white/40">{details?.assets.length ?? '—'}</span></div>
                {detailsLoading && <p role="status" className="py-8 text-center text-xs text-white/50">Loading outfit items…</p>}
                {detailsError && <div className="py-8 text-center"><p className="text-xs text-white/55">Could not load this fit's items.</p><button type="button" onClick={() => setDetailsRetryKey((value) => value + 1)} className="mt-3 rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white hover:bg-white/10">Try again</button></div>}
                {details && details.assets.length === 0 && <p className="py-8 text-center text-xs text-white/50">This fit has no clothing, accessories or gear to copy.</p>}
                {details && details.assets.length > 0 && (
                  <>
                    <div className="mb-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => void copyAssetIds(details.assets.map((asset) => asset.id), 'all-fit-ids')} className="rounded-lg border border-white/20 bg-white/[0.06] px-3 py-2 text-[11px] font-mono text-white hover:bg-white/10"><Copy className="mr-1.5 inline h-3 w-3" />{copied === 'all-fit-ids' ? 'Copied all IDs' : 'Copy all IDs'}</button>
                      {details.assets.some((asset) => asset.kind === 'clothing') && <button type="button" onClick={() => void copyAssetIds(details.assets.filter((asset) => asset.kind === 'clothing').map((asset) => asset.id), 'clothing-fit-ids')} className="rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-[11px] font-mono text-cyan-200 hover:bg-cyan-400/15"><Copy className="mr-1.5 inline h-3 w-3" />{copied === 'clothing-fit-ids' ? 'Copied clothing IDs' : 'Copy clothing IDs'}</button>}
                    </div>
                    <div className="space-y-2">
                      {details.assets.map((asset) => (
                        <div key={asset.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-2">
                          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-black/50">{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" className="h-full w-full rounded-lg object-contain" /> : <Shirt className="h-5 w-5 text-white/25" />}</span>
                          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-white" title={asset.name}>{asset.name}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-white/45">{asset.assetTypeName || asset.kind} · #{asset.id}</span></span>
                          <button type="button" onClick={() => void copyAssetIds([asset.id], `fit-item-${asset.id}`)} aria-label={`Copy ID ${asset.id}`} className="shrink-0 rounded-lg border border-white/10 p-2 text-white/55 hover:border-white/25 hover:text-white">{copied === `fit-item-${asset.id}` ? <span className="text-[10px]">Copied</span> : <Copy className="h-4 w-4" />}</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>, document.body
      )}
    </section>
  );
};
