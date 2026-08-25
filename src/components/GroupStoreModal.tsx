import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RobloxAssetItem, RobloxGroupMembership } from '../types/roblox';
import { RobloxApiClient } from '../services/api';
import { useFavorites } from '../hooks/useFavorites';
import { QuickCopyStation } from './QuickCopyStation';
import { Tooltip, TooltipMono } from './ui/tooltip';
import { FALLBACK_GROUP_SVG } from '../lib/fallbacks';
import { toast } from 'sonner';
import {
  X,
  Store,
  Search,
  Tag,
  Sparkles,
  Users,
  ExternalLink,
  Heart,
  RefreshCw,
  BadgeCheck,
  Package,
  ArrowUpDown,
  Zap,
} from 'lucide-react';

interface GroupStoreModalProps {
  isOpen: boolean;
  onClose: () => void;
  group: RobloxGroupMembership | { id: number; name: string; memberCount?: number; iconUrl?: string | null; hasVerifiedBadge?: boolean } | null;
}

type FilterCategory = 'all' | 'on_sale' | 'free' | 'off_sale';
type SortOption = 'RecentlyCreated' | 'PriceAsc' | 'PriceDesc';

export const GroupStoreModal: React.FC<GroupStoreModalProps> = ({
  isOpen,
  onClose,
  group,
}) => {
  const [items, setItems] = useState<RobloxAssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<FilterCategory>('all');
  const [sortOption, setSortOption] = useState<SortOption>('RecentlyCreated');

  const { isFavorite, toggleFavorite } = useFavorites();

  const fetchItems = useCallback(
    async (isInitial = true, cursor = '') => {
      if (!group) return;
      if (isInitial) {
        setLoading(true);
        setHasError(false);
      } else {
        setLoadingMore(true);
      }

      try {
        const sortOrder = sortOption === 'PriceAsc' ? 'Asc' : 'Desc';
        const res = await RobloxApiClient.fetchGroupStore(
          group.id,
          cursor,
          100,
          sortOption,
          sortOrder
        );
        if (isInitial) {
          setItems(res.items);
        } else {
          setItems((prev) => {
            const existingIds = new Set(prev.map((i) => i.id));
            const newItems = res.items.filter((i) => !existingIds.has(i.id));
            return [...prev, ...newItems];
          });
        }
        setNextCursor(res.nextPageCursor);
        setHasError(false);
      } catch {
        toast.error('Failed to load group catalog items');
        if (isInitial) setHasError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [group, sortOption]
  );

  const loadAllRemaining = async () => {
    if (!group || !nextCursor || loadingAll || loadingMore) return;
    setLoadingAll(true);
    let cur: string | null = nextCursor;
    let pageCount = 0;
    try {
      const sortOrder = sortOption === 'PriceAsc' ? 'Asc' : 'Desc';
      while (cur) {
        pageCount++;
        const res = await RobloxApiClient.fetchGroupStore(
          group.id,
          cur,
          100,
          sortOption,
          sortOrder
        );
        setItems((prev) => {
          const existingIds = new Set(prev.map((i) => i.id));
          const newItems = res.items.filter((i) => !existingIds.has(i.id));
          return [...prev, ...newItems];
        });
        cur = res.nextPageCursor;
        setNextCursor(cur);
        if (!cur) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      toast.success('Loaded all items from group catalog!');
    } catch {
      toast.error('Partially loaded; click again to continue fetching.');
    } finally {
      setLoadingAll(false);
    }
  };

  useEffect(() => {
    if (isOpen && group) {
      setItems([]);
      setNextCursor(null);
      setSearchQuery('');
      setFilterCategory('all');
      setHasError(false);
      fetchItems(true, '');
    }
  }, [isOpen, group?.id, sortOption]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      // Category filter
      if (filterCategory === 'on_sale' && (!item.isForSale || item.isFree)) return false;
      if (filterCategory === 'free' && !item.isFree) return false;
      if (filterCategory === 'off_sale' && item.isForSale) return false;

      // Text search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          item.name.toLowerCase().includes(q) ||
          (item.assetTypeName && item.assetTypeName.toLowerCase().includes(q)) ||
          item.id.toString().includes(q)
        );
      }
      return true;
    });
  }, [items, filterCategory, searchQuery]);

  const onSaleCount = useMemo(() => items.filter((i) => i.isForSale && !i.isFree).length, [items]);
  const freeCount = useMemo(() => items.filter((i) => i.isFree).length, [items]);
  const offSaleCount = useMemo(() => items.filter((i) => !i.isForSale).length, [items]);

  if (!isOpen || !group) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 overflow-hidden">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/80 backdrop-blur-xl -z-10"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 16 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="relative w-full max-w-6xl max-h-[92vh] sm:max-h-[88vh] flex flex-col rounded-2xl sm:rounded-3xl bg-neutral-950/95 border border-white/10 shadow-[0_24px_64px_rgba(0,0,0,0.8)] overflow-hidden m-2 sm:m-4"
        >
          {/* Header Bar */}
          <div className="p-3.5 sm:p-5 border-b border-white/[0.08] bg-black/40 backdrop-blur-md flex items-center justify-between gap-3 shrink-0">
            {/* Group Identity */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl bg-black/60 border border-white/15 overflow-hidden shrink-0 flex items-center justify-center shadow-md">
                {group.iconUrl ? (
                  <img
                    src={group.iconUrl}
                    alt={group.name}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.currentTarget.src = FALLBACK_GROUP_SVG;
                    }}
                  />
                ) : (
                  <Store className="w-5 h-5 text-white/40" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-base sm:text-xl font-bold tracking-tight text-white truncate">
                    {group.name}
                  </h2>
                  {group.hasVerifiedBadge && (
                    <BadgeCheck className="w-4 h-4 text-cyan-400 shrink-0" />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] sm:text-xs font-mono text-white/40 mt-0.5">
                  <span className="flex items-center gap-1">
                    <Store className="w-3 h-3 text-cyan-400/80" /> Group Store
                  </span>
                  {typeof group.memberCount === 'number' && (
                    <>
                      <span>•</span>
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3 text-white/30" />
                        {group.memberCount.toLocaleString()} members
                      </span>
                    </>
                  )}
                  <span>•</span>
                  <a
                    href={`https://www.roblox.com/groups/${group.id}/store`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-white/60 hover:text-cyan-300 transition-colors"
                  >
                    <span>Roblox Store</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>

            {/* Header Actions */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button
                onClick={() => fetchItems(true, '')}
                disabled={loading}
                aria-label="Refresh Store"
                title="Refresh Store"
                className="p-2 sm:p-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 text-white/60 hover:text-white transition-all active:scale-95 disabled:opacity-40"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>

              {/* Close Button */}
              <button
                onClick={onClose}
                aria-label="Close Store Modal"
                className="p-2 sm:p-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 text-white/60 hover:text-white transition-all active:scale-95"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Search, Filters & Sorting Bar */}
          <div className="p-3 sm:p-4 border-b border-white/[0.06] bg-black/20 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 sm:gap-3 shrink-0">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-white/30 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search items in group..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-8 py-2 rounded-xl bg-white/[0.03] border border-white/10 text-xs font-mono text-white placeholder:text-white/30 focus:outline-none focus:border-cyan-500/50 focus:bg-white/[0.05] transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Filter Pills & Sort Row */}
            <div className="flex items-center justify-between sm:justify-end gap-2 overflow-x-auto no-scrollbar py-0.5">
              {/* Category Pills */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => setFilterCategory('all')}
                  className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-mono transition-all flex items-center gap-1.5 ${
                    filterCategory === 'all'
                      ? 'bg-white/15 text-white font-semibold border border-white/20 shadow-sm'
                      : 'bg-white/[0.03] text-white/50 hover:text-white border border-white/[0.06]'
                  }`}
                >
                  <span>All</span>
                  <span className="text-[10px] opacity-60">({items.length})</span>
                </button>

                <button
                  onClick={() => setFilterCategory('on_sale')}
                  className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-mono transition-all flex items-center gap-1.5 ${
                    filterCategory === 'on_sale'
                      ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30 shadow-sm'
                      : 'bg-white/[0.03] text-white/50 hover:text-white border border-white/[0.06]'
                  }`}
                >
                  <Tag className="w-3 h-3 text-emerald-400" />
                  <span>On Sale</span>
                  <span className="text-[10px] opacity-60">({onSaleCount})</span>
                </button>

                {freeCount > 0 && (
                  <button
                    onClick={() => setFilterCategory('free')}
                    className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-mono transition-all flex items-center gap-1.5 ${
                      filterCategory === 'free'
                        ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30 shadow-sm'
                        : 'bg-white/[0.03] text-white/50 hover:text-white border border-white/[0.06]'
                    }`}
                  >
                    <Sparkles className="w-3 h-3 text-cyan-400" />
                    <span>Free</span>
                    <span className="text-[10px] opacity-60">({freeCount})</span>
                  </button>
                )}

                <button
                  onClick={() => setFilterCategory('off_sale')}
                  className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-mono transition-all flex items-center gap-1.5 ${
                    filterCategory === 'off_sale'
                      ? 'bg-amber-500/20 text-amber-300 font-semibold border border-amber-500/30 shadow-sm'
                      : 'bg-white/[0.03] text-white/50 hover:text-white border border-white/[0.06]'
                  }`}
                >
                  <span>Off-Sale</span>
                  <span className="text-[10px] opacity-60">({offSaleCount})</span>
                </button>
              </div>

              {/* Sort Dropdown */}
              <div className="flex items-center gap-1.5 shrink-0 bg-black/60 border border-white/10 rounded-xl px-2.5 py-1.5">
                <ArrowUpDown className="w-3.5 h-3.5 text-white/40 shrink-0" />
                <select
                  value={sortOption}
                  onChange={(e) => setSortOption(e.target.value as SortOption)}
                  className="bg-transparent text-xs font-mono text-white/80 focus:outline-none cursor-pointer pr-1"
                >
                  <option value="RecentlyCreated" className="bg-neutral-900 text-white">Newest</option>
                  <option value="PriceAsc" className="bg-neutral-900 text-white">Price: Low to High</option>
                  <option value="PriceDesc" className="bg-neutral-900 text-white">Price: High to Low</option>
                </select>
              </div>
            </div>
          </div>

          {/* Items Content Scroll Area */}
          <div className="flex-1 overflow-y-auto p-3 sm:p-5 fancy-scroll overscroll-contain">
            {loading && items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 space-y-3">
                <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin" />
                <p className="text-xs font-mono text-white/40">FETCHING GROUP CATALOG…</p>
              </div>
            ) : hasError && items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
                <Package className="w-12 h-12 text-rose-400/40 mb-1" />
                <h3 className="text-base font-semibold text-white/80">Failed to load catalog</h3>
                <p className="text-xs font-mono text-white/40 max-w-sm">
                  Roblox API was throttled or took too long to respond. Please try again.
                </p>
                <button
                  onClick={() => fetchItems(true, '')}
                  className="mt-2 px-5 py-2 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-mono font-medium flex items-center gap-2 transition-all active:scale-95 shadow-sm"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry</span>
                </button>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <Package className="w-12 h-12 text-white/15 mb-3" />
                <h3 className="text-base font-semibold text-white/70">No items found</h3>
                <p className="text-xs font-mono text-white/40 mt-1 max-w-sm">
                  {searchQuery
                    ? `No items matching "${searchQuery}" in this category.`
                    : 'This group does not have any items matching the selected filter.'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3.5">
                {filteredItems.map((item) => {
                  const wishlisted = isFavorite(item.id);
                  return (
                    <StoreItemCard
                      key={item.id}
                      item={item}
                      isWishlisted={wishlisted}
                      onToggleWishlist={() => toggleFavorite(item, { id: group.id, name: group.name })}
                    />
                  );
                })}
              </div>
            )}

            {/* Load More & Load All Buttons */}
            {nextCursor && !loading && (
              <div className="flex flex-wrap items-center justify-center gap-3 pt-6 pb-2">
                <button
                  onClick={() => fetchItems(false, nextCursor)}
                  disabled={loadingMore || loadingAll}
                  className="px-5 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs font-mono font-medium text-white flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingMore ? 'animate-spin' : ''}`} />
                  <span>{loadingMore ? 'LOADING NEXT…' : 'LOAD NEXT 100 ITEMS'}</span>
                </button>

                <button
                  onClick={loadAllRemaining}
                  disabled={loadingMore || loadingAll}
                  className="px-5 py-2.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-xs font-mono font-medium text-cyan-300 flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50 shadow-sm"
                >
                  <Zap className={`w-3.5 h-3.5 ${loadingAll ? 'animate-spin text-cyan-400' : 'text-cyan-400'}`} />
                  <span>{loadingAll ? 'FETCHING ALL ITEMS…' : 'LOAD ALL STORE ITEMS'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Footer Bar */}
          <div className="px-4 sm:px-6 py-2.5 sm:py-3 border-t border-white/[0.06] bg-black/40 backdrop-blur-md flex items-center justify-between text-[11px] sm:text-xs font-mono text-white/40 shrink-0">
            <span>
              Showing {filteredItems.length} of {items.length} loaded items
            </span>
            <span className="hidden sm:inline text-[11px]">
              Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 border border-white/10 text-white/70">ESC</kbd> to close
            </span>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

interface StoreItemCardProps {
  item: RobloxAssetItem;
  isWishlisted: boolean;
  onToggleWishlist: () => void;
}

const StoreItemCard: React.FC<StoreItemCardProps> = ({ item, isWishlisted, onToggleWishlist }) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  return (
    <div className="group relative flex flex-col justify-between rounded-xl sm:rounded-2xl bg-black/40 hover:bg-black/60 border border-white/[0.07] hover:border-white/20 p-2.5 sm:p-3 transition-all duration-200 shadow-sm h-full">
      {/* Top Bar: Type Badge & Favorite Heart Button */}
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider bg-white/[0.04] text-white/60 border border-white/[0.06] truncate max-w-[80px] sm:max-w-[90px]">
          {item.assetTypeName || 'Wearable'}
        </span>

        {/* 1-Click Wishlist Heart Button */}
        <Tooltip content={<TooltipMono label={isWishlisted ? 'Saved in Favorites' : 'Add to Favorites'} hint={item.name.slice(0, 20)} />} side="top">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleWishlist();
            }}
            aria-label={isWishlisted ? 'Remove from favorites' : 'Add to favorites'}
            className={`p-1.5 rounded-lg transition-all active:scale-80 ${
              isWishlisted
                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40 shadow-[0_0_10px_rgba(244,63,94,0.3)]'
                : 'bg-white/[0.03] hover:bg-white/[0.08] text-white/40 hover:text-rose-300 border border-white/[0.06]'
            }`}
          >
            <Heart className={`w-3.5 h-3.5 ${isWishlisted ? 'fill-rose-400 text-rose-400' : ''}`} />
          </button>
        </Tooltip>
      </div>

      {/* Thumbnail Canvas */}
      <div className="relative aspect-square w-full rounded-lg sm:rounded-xl bg-black/40 border border-white/[0.04] overflow-hidden flex items-center justify-center p-1.5 sm:p-2 mb-1.5 group-hover:border-white/[0.12] transition-colors">
        {item.thumbnailUrl && !imageError ? (
          <img
            src={item.thumbnailUrl}
            alt={item.name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageError(true)}
            className={`w-full h-full object-contain filter drop-shadow-[0_4px_10px_rgba(0,0,0,0.5)] transition-all duration-300 transform group-hover:scale-105 ${
              imageLoaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ) : (
          <div className="text-center p-2">
            <span className="text-[9px] font-mono text-white/30 uppercase block">
              #{item.id.toString().slice(-4)}
            </span>
          </div>
        )}

        {/* Price Tag Overlay on bottom of thumbnail */}
        <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between pointer-events-none">
          {item.isForSale && item.price !== null && item.price > 1 ? (
            <span className="px-1.5 sm:px-2 py-0.5 rounded-md bg-emerald-950/90 backdrop-blur-md border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold shadow-sm">
              {item.price.toLocaleString()} R$
            </span>
          ) : item.isFree ? (
            <span className="px-1.5 sm:px-2 py-0.5 rounded-md bg-emerald-950/90 backdrop-blur-md border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold shadow-sm">
              FREE
            </span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-black/80 backdrop-blur-md border border-white/10 text-amber-300/80 font-mono text-[9px] font-medium">
              OFF-SALE
            </span>
          )}
        </div>
      </div>

      {/* Item Title */}
      <Tooltip content={<TooltipMono label={item.name} hint={`ID: ${item.id}`} />} side="top" align="start">
        <h4 className="text-xs font-medium text-white/90 line-clamp-2 h-8 leading-tight group-hover:text-white transition-colors cursor-default my-1 flex items-center">
          {item.name}
        </h4>
      </Tooltip>

      {/* Quick Actions (Copy ID & Roblox Link) */}
      <QuickCopyStation
        assetId={item.id}
        studioLuaCommand={item.studioLuaCommand}
        catalogUrl={item.catalogUrl}
        assetName={item.name}
        variant="compact"
      />
    </div>
  );
};
