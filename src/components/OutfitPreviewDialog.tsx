import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Shirt, X } from 'lucide-react';
import { useClipboard } from '../hooks/useClipboard';
import type { ArchiveItem } from '../lib/outfitArchive';

export interface OutfitPreviewProps {
  /** Dialog name for screen readers, e.g. "Fit Street fit". */
  label: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  noImageText: string;
  /** Shown above the item list, e.g. where the data came from. */
  notice?: string;
  assets: ArchiveItem[] | null;
  loading: boolean;
  error: boolean;
  onRetry?: () => void;
  onClose: () => void;
}

/** Whole-outfit preview with its items and copyable asset ids (saved fits, archived outfits and worn looks). */
export const OutfitPreviewDialog: React.FC<OutfitPreviewProps> = ({ label, title, subtitle, imageUrl, noImageText, notice, assets, loading, error, onRetry, onClose }) => {
  const { copied, copy } = useClipboard();
  const copyIds = async (ids: number[], key: string) => { if (ids.length > 0) await copy(ids.join(', '), key); };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" className="absolute inset-0 bg-black/85" onClick={onClose} aria-label="Close fit preview" />
      <div className="relative max-h-[calc(100dvh-2rem)] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/20 bg-neutral-950 shadow-2xl fancy-scroll">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-neutral-950 px-4 py-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-white">{title}</h3><p className="font-mono text-[10px] text-white/40">{subtitle}</p></div><button type="button" onClick={onClose} aria-label="Close fit preview" className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"><X className="h-5 w-5" /></button></div>
        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex aspect-square max-h-80 items-center justify-center bg-white/[0.025] md:max-h-none">{imageUrl ? <img src={imageUrl} alt={`Full view of ${title}`} className="h-full w-full object-contain" /> : <div className="px-6 text-center"><Shirt className="mx-auto h-12 w-12 text-white/20" /><p className="mt-3 text-xs text-white/45">{noImageText}</p></div>}</div>
          <div className="min-w-0 border-t border-white/10 p-4 md:border-l md:border-t-0">
            <div className="mb-3 flex items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-white">Worn items</h4><p className="text-[11px] text-white/45">Clothing, accessories and gear</p></div><span className="font-mono text-xs text-white/40">{assets?.length ?? '—'}</span></div>
            {notice && <p className="mb-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/55">{notice}</p>}
            {loading && <p role="status" className="py-8 text-center text-xs text-white/50">Loading outfit items…</p>}
            {error && <div className="py-8 text-center"><p className="text-xs text-white/55">Could not load this fit's items.</p>{onRetry && <button type="button" onClick={onRetry} className="mt-3 rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white hover:bg-white/10">Try again</button>}</div>}
            {assets && assets.length === 0 && <p className="py-8 text-center text-xs text-white/50">This fit has no clothing, accessories or gear to copy.</p>}
            {assets && assets.length > 0 && (
              <>
                <div className="mb-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void copyIds(assets.map((asset) => asset.id), 'all-fit-ids')} className="rounded-lg border border-white/20 bg-white/[0.06] px-3 py-2 text-[11px] font-mono text-white hover:bg-white/10"><Copy className="mr-1.5 inline h-3 w-3" />{copied === 'all-fit-ids' ? 'Copied all IDs' : 'Copy all IDs'}</button>
                  {assets.some((asset) => asset.kind === 'clothing') && <button type="button" onClick={() => void copyIds(assets.filter((asset) => asset.kind === 'clothing').map((asset) => asset.id), 'clothing-fit-ids')} className="rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-[11px] font-mono text-cyan-200 hover:bg-cyan-400/15"><Copy className="mr-1.5 inline h-3 w-3" />{copied === 'clothing-fit-ids' ? 'Copied clothing IDs' : 'Copy clothing IDs'}</button>}
                </div>
                <div className="space-y-2">
                  {assets.map((asset) => (
                    <div key={asset.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-2">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-black/50">{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" className="h-full w-full rounded-lg object-contain" /> : <Shirt className="h-5 w-5 text-white/25" />}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-white" title={asset.name}>{asset.name || `Item #${asset.id}`}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-white/45">{asset.assetTypeName || asset.kind || 'Item'} · #{asset.id}</span></span>
                      <button type="button" onClick={() => void copyIds([asset.id], `fit-item-${asset.id}`)} aria-label={`Copy ID ${asset.id}`} className="shrink-0 rounded-lg border border-white/10 p-2 text-white/55 hover:border-white/25 hover:text-white">{copied === `fit-item-${asset.id}` ? <span className="text-[10px]">Copied</span> : <Copy className="h-4 w-4" />}</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>, document.body,
  );
};
