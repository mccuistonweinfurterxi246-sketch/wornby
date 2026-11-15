import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, Layers, Lock, RefreshCw, Search, Shirt } from 'lucide-react';
import { RobloxApiClient } from '../services/api';
import { useOutfitArchive } from '../hooks/useOutfitArchive';
import { OutfitPreviewDialog, OutfitPreviewProps } from './OutfitPreviewDialog';
import { SourceChip } from './explore/SourceChip';
import {
  ArchiveFilter, ArchiveItem, ArchiveLook, ArchiveOutfit, OutfitStatus, counts, lookYears, visibleOutfits,
} from '../lib/outfitArchive';

const PAGE = 60;
const STATUS: Record<OutfitStatus, { label: string; tone: string; hint: string }> = {
  available: { label: 'Available', tone: 'text-emerald-300 border-emerald-400/25 bg-emerald-400/10', hint: 'Saved on the player’s account now' },
  recovered: { label: 'Recovered', tone: 'text-cyan-200 border-cyan-400/25 bg-cyan-400/10', hint: 'No longer listed, but still exists on Roblox' },
  deleted: { label: 'Deleted', tone: 'text-rose-300 border-rose-400/25 bg-rose-400/10', hint: 'Removed from Roblox; items recovered from an archived copy' },
  partial: { label: 'Name only', tone: 'text-amber-300 border-amber-400/25 bg-amber-400/10', hint: 'Removed from Roblox; only the name was archived' },
  checking: { label: 'Checking', tone: 'text-white/50 border-white/15 bg-white/[0.04]', hint: 'Checking whether Roblox still has it' },
};
const FILTERS: { value: ArchiveFilter['status']; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'available', label: 'Available' }, { value: 'recovered', label: 'Recovered' },
  { value: 'deleted', label: 'Deleted' }, { value: 'partial', label: 'Name only' }, { value: 'looks', label: 'Worn looks' },
];
const monthOf = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

type Preview = Omit<OutfitPreviewProps, 'onClose'>;

export const OutfitArchive: React.FC<{ userId: number; currentLook: { items: ArchiveItem[]; renderUrl: string | null } }> = ({ userId, currentLook }) => {
  const { state, inventory, liveStatus, progress, reload } = useOutfitArchive(userId, currentLook);
  const [filter, setFilter] = useState<ArchiveFilter>({ status: 'all', query: '' });
  const [shownOutfits, setShownOutfits] = useState(PAGE);
  const [shownLooks, setShownLooks] = useState(PAGE);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [lookThumbs, setLookThumbs] = useState<Record<number, string>>({});
  const requestedThumbs = useRef(new Set<number>());

  const isPublic = inventory !== 'private';
  const total = counts(state, isPublic);
  const outfits = useMemo(() => visibleOutfits(state, filter, isPublic), [state, filter, isPublic]);
  const years = useMemo(() => lookYears(state, filter), [state, filter]);
  const looksShown = useMemo(() => {
    let left = shownLooks;
    return years.map(([year, looks]) => { const part = looks.slice(0, Math.max(0, left)); left -= part.length; return [year, part] as const; }).filter(([, l]) => l.length);
  }, [years, shownLooks]);
  const lookCount = years.reduce((n, [, l]) => n + l.length, 0);
  const currentKey = useMemo(() => [...new Set(currentLook.items.map((i) => i.id))].sort((a, b) => a - b).join(','), [currentLook.items]);

  // Item images for the look cards on screen (looks rarely have an archived render).
  useEffect(() => {
    const ids = [...new Set(looksShown.flatMap(([, looks]) => looks.filter((l) => !l.renderUrl).flatMap((l) => l.assetIds.slice(0, 4))))]
      .filter((id) => !requestedThumbs.current.has(id)).slice(0, 120);
    if (ids.length === 0) return;
    // Asked once per id: items without an image are not requested again.
    ids.forEach((id) => requestedThumbs.current.add(id));
    RobloxApiClient.fetchAssetThumbnails(ids).then((t) => setLookThumbs((m) => ({ ...m, ...t })))
      .catch(() => ids.forEach((id) => requestedThumbs.current.delete(id)));
  }, [looksShown]);

  const withThumbs = useCallback(async (items: ArchiveItem[]) => {
    const map = await RobloxApiClient.fetchAssetThumbnails(items.map((i) => i.id).slice(0, 120)).catch(() => ({} as Record<number, string>));
    return items.map((i) => ({ ...i, thumbnailUrl: map[i.id] ?? null }));
  }, []);

  const openOutfit = useCallback((o: ArchiveOutfit) => {
    const base: Preview = {
      label: `Fit ${o.name}`, title: o.name, subtitle: `FIT #${o.id} · ${STATUS[o.status].label.toUpperCase()}${o.archivedSince ? ` · ARCHIVED ${o.archivedSince}` : ''}`,
      imageUrl: o.thumbnailUrl, noImageText: o.status === 'deleted' || o.status === 'partial' ? 'Roblox removed this fit, so there is no preview.' : 'Roblox has no preview for this fit.',
      assets: null, loading: true, error: false,
    };
    if (o.status === 'partial') { setPreview({ ...base, loading: false, assets: [], notice: 'Only this fit’s name was archived before Roblox removed it; its items are unknown.' }); return; }
    if (o.status === 'deleted') {
      setPreview({ ...base, notice: 'Items recovered from an archived copy of this fit on the Wayback Machine.' });
      void withThumbs(o.assets ?? []).then((assets) => setPreview((p) => (p?.title === o.name ? { ...p, assets, loading: false } : p)));
      return;
    }
    const load = () => {
      setPreview({ ...base, onRetry: load });
      RobloxApiClient.fetchSavedOutfitDetails(o.id)
        .then((d) => setPreview((p) => (p?.label === base.label ? { ...p, assets: d.assets, loading: false } : p)))
        .catch(() => setPreview((p) => (p?.label === base.label ? { ...p, loading: false, error: true } : p)));
    };
    load();
  }, [withThumbs]);

  const openLook = useCallback((l: ArchiveLook) => {
    const label = `Look worn ${l.firstSeen === l.lastSeen ? monthOf(l.lastSeen) : `${monthOf(l.firstSeen)} – ${monthOf(l.lastSeen)}`}`;
    setPreview({
      label, title: l.key === currentKey ? 'Current look' : label,
      subtitle: `${l.assetIds.length} ITEMS · SEEN ${l.sightings}× · ${l.sources.includes('wayback') ? 'WAYBACK MACHINE' : 'ROBLOX'}`,
      imageUrl: l.renderUrl, noImageText: 'No picture of this look was archived.', assets: null, loading: true, error: false,
      notice: l.items.some((i) => !i.name) ? 'Some items were archived by ID only.' : undefined,
    });
    void withThumbs(l.items).then((assets) => setPreview((p) => (p?.label === label ? { ...p, assets, loading: false } : p)));
  }, [currentKey, withThumbs]);

  const busy = liveStatus === 'loading' || progress.searching > 0 || progress.done < progress.total || progress.checking > 0;
  const statusLine = liveStatus === 'loading' ? 'Loading saved outfits…'
    : progress.searching > 0 ? `Searching the Wayback Machine… ${progress.done}/${progress.total} snapshots`
      : progress.done < progress.total ? `Recovering history… ${progress.done}/${progress.total} snapshots`
        : progress.checking > 0 ? `Checking ${progress.checking} archived outfits on Roblox…`
          : progress.failed > 0 ? `${progress.failed} archive requests failed; they are retried on your next visit.` : null;

  return (
    <section aria-label="Outfit archive" className="space-y-4">
      <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">Outfit archive</h3>
            <p className="mt-0.5 text-xs text-white/45">
              {isPublic && <>{total.available} available · {total.recovered} recovered · {total.deleted} deleted · {total.partial} name only · </>}{total.looks} worn looks
            </p>
          </div>
          <button type="button" onClick={reload} disabled={busy} aria-label="Refresh archive" className="rounded-lg border border-white/10 p-2 text-white/55 hover:border-white/25 hover:text-white disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /></button>
        </div>
        {statusLine && (
          <div className="mt-3" role="status">
            <p className="font-mono text-[10px] uppercase tracking-wider text-white/45">{statusLine}</p>
            {progress.total > 0 && progress.done < progress.total && <div className="mt-1.5 h-0.5 overflow-hidden rounded bg-white/10"><div className="h-full bg-cyan-400/70 transition-[width]" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></div>}
          </div>
        )}
      </div>

      {inventory === 'private' && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-100/80">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p>This player’s inventory is private, so Roblox hides their saved outfits and Wornby does too. Their worn looks are public and shown below.</p>
        </div>
      )}
      {liveStatus === 'error' && <p role="status" className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-xs text-white/60">Saved outfits could not be loaded right now. Archived history still loads; use refresh to try again.</p>}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto" role="group" aria-label="Filter archive">
          {FILTERS.filter((f) => isPublic || f.value === 'all' || f.value === 'looks').map((f) => {
            const n = f.value === 'all' ? null : f.value === 'looks' ? total.looks : total[f.value];
            return (
              <button key={f.value} type="button" aria-pressed={filter.status === f.value} onClick={() => { setFilter((x) => ({ ...x, status: f.value })); setShownOutfits(PAGE); setShownLooks(PAGE); }}
                className={`shrink-0 rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors ${filter.status === f.value ? 'border-white bg-white text-black' : 'border-white/10 bg-white/[0.03] text-white/65 hover:border-white/25 hover:text-white'}`}>
                {f.label}{n !== null && <span className={filter.status === f.value ? 'text-black/50' : 'text-white/35'}> {n}</span>}
              </button>
            );
          })}
        </div>
        <label className="relative sm:ml-auto sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
          <input value={filter.query} onChange={(e) => setFilter((x) => ({ ...x, query: e.target.value }))} placeholder="Search outfits or item IDs" aria-label="Search outfits or item IDs"
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2 pl-8 pr-3 font-mono text-xs text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none" />
        </label>
      </div>

      {outfits.length > 0 && (
        <div className="space-y-3">
          <h4 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-white/45"><Shirt className="h-3.5 w-3.5" />Saved outfits · newest first<SourceChip kind="saved" /></h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {outfits.slice(0, shownOutfits).map((o) => (
              <button key={o.id} type="button" onClick={() => openOutfit(o)} aria-label={`View fit ${o.name}`} title={STATUS[o.status].hint}
                className="group overflow-hidden rounded-xl border border-white/10 bg-black/50 text-left transition-colors hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <span className="relative flex aspect-square items-center justify-center bg-white/[0.035]">
                  {o.thumbnailUrl ? <img src={o.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" /> : <Shirt className="h-9 w-9 text-white/20" />}
                  <span className={`absolute left-2 top-2 rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${STATUS[o.status].tone}`}>{STATUS[o.status].label}</span>
                </span>
                <span className="block truncate px-3 pt-2.5 text-xs font-medium text-white" title={o.name}>{o.name}</span>
                <span className="block truncate px-3 pb-3 pt-1 font-mono text-[10px] text-white/40">FIT #{o.id}{o.archivedSince ? ` · ${monthOf(o.archivedSince)}` : ''}</span>
              </button>
            ))}
          </div>
          {outfits.length > shownOutfits && <div className="flex justify-center"><button type="button" onClick={() => setShownOutfits((n) => n + PAGE)} className="rounded-xl border border-white/20 bg-white/[0.05] px-5 py-2.5 font-mono text-xs text-white hover:bg-white/10">SHOW {Math.min(PAGE, outfits.length - shownOutfits)} MORE FITS</button></div>}
        </div>
      )}

      {looksShown.length > 0 && (
        <div className="space-y-3">
          <h4 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-white/45"><History className="h-3.5 w-3.5" />Worn looks · timeline<SourceChip kind="worn" /></h4>
          {looksShown.map(([year, looks]) => (
            <div key={year} className="grid gap-3 sm:grid-cols-[4rem_minmax(0,1fr)]">
              <p className="font-mono text-sm font-semibold text-white/70 sm:pt-2">{year}</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {looks.map((l) => (
                  <button key={l.key} type="button" onClick={() => openLook(l)} aria-label={`View look worn ${monthOf(l.lastSeen)}`}
                    className="group overflow-hidden rounded-xl border border-white/10 bg-black/50 text-left transition-colors hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    <span className="relative flex aspect-square items-center justify-center bg-white/[0.035]">
                      {l.renderUrl ? <><History className="absolute h-6 w-6 text-white/10" aria-hidden="true" /><img src={l.renderUrl} alt="" loading="lazy" className="relative h-full w-full object-contain" /></>
                        : <span className="grid h-full w-full grid-cols-2 gap-px p-2">{l.assetIds.slice(0, 4).map((id) => <span key={id} className="flex items-center justify-center rounded-md bg-black/40">{lookThumbs[id] ? <img src={lookThumbs[id]} alt="" loading="lazy" className="h-full w-full object-contain" /> : <Layers className="h-4 w-4 text-white/15" />}</span>)}</span>}
                      {l.key === currentKey && <span className="absolute left-2 top-2 rounded-md border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-emerald-300">Wearing now</span>}
                    </span>
                    <span className="block px-3 pt-2.5 text-xs font-medium text-white">{l.firstSeen === l.lastSeen ? monthOf(l.lastSeen) : `${monthOf(l.firstSeen)} – ${monthOf(l.lastSeen)}`}</span>
                    <span className="block px-3 pb-3 pt-1 font-mono text-[10px] text-white/40">{l.assetIds.length} ITEMS · SEEN {l.sightings}×</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {lookCount > shownLooks && <div className="flex justify-center"><button type="button" onClick={() => setShownLooks((n) => n + PAGE)} className="rounded-xl border border-white/20 bg-white/[0.05] px-5 py-2.5 font-mono text-xs text-white hover:bg-white/10">SHOW {Math.min(PAGE, lookCount - shownLooks)} MORE LOOKS</button></div>}
        </div>
      )}

      {!busy && outfits.length === 0 && looksShown.length === 0 && (
        <div className="rounded-xl border border-white/10 bg-black/30 px-5 py-12 text-center">
          <Shirt className="mx-auto mb-3 h-7 w-7 text-white/30" />
          <p className="text-sm text-white/65">{filter.query || filter.status !== 'all' ? 'Nothing in the archive matches this filter.' : 'No outfits or archived looks were found for this player.'}</p>
        </div>
      )}

      {preview && <OutfitPreviewDialog {...preview} onClose={() => setPreview(null)} />}
    </section>
  );
};
