import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useFavorites, FavoriteItem } from '../hooks/useFavorites';
import { QuickCopyStation } from './QuickCopyStation';
import { Tooltip, TooltipMono } from './ui/tooltip';
import {
  X,
  Heart,
  Tag,
  Trash2,
  Copy,
  Search,
  Store,
  Check,
  PackageOpen,
} from 'lucide-react';

interface FavoritesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenGroupStore?: (groupId: number, groupName: string) => void;
}

export const FavoritesDrawer: React.FC<FavoritesDrawerProps> = ({
  isOpen,
  onClose,
  onOpenGroupStore,
}) => {
  const {
    favorites,
    favoritesCount,
    removeFavorite,
    clearFavorites,
    totalRobuxValue,
    onSaleCount,
    copyAllIds,
  } = useFavorites();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [copiedAll, setCopiedAll] = useState(false);

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

  // Extract unique asset types
  const assetTypes = useMemo(() => {
    const types = new Set<string>();
    favorites.forEach((f) => {
      if (f.assetTypeName) types.add(f.assetTypeName);
    });
    return Array.from(types);
  }, [favorites]);

  const filteredFavorites = useMemo(() => {
    return favorites.filter((item) => {
      if (selectedType !== 'all' && item.assetTypeName !== selectedType) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          item.name.toLowerCase().includes(q) ||
          (item.groupName && item.groupName.toLowerCase().includes(q)) ||
          item.creatorName.toLowerCase().includes(q) ||
          item.id.toString().includes(q)
        );
      }
      return true;
    });
  }, [favorites, selectedType, searchQuery]);

  const handleCopyAll = async () => {
    const ok = await copyAllIds();
    if (ok) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
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
          <div className="p-3.5 sm:p-5 border-b border-white/[0.08] bg-black/40 backdrop-blur-md flex flex-wrap items-center justify-between gap-3 shrink-0">
            {/* Title & Stats */}
            <div className="flex items-center gap-3.5">
              <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 shrink-0 shadow-[0_0_15px_rgba(244,63,94,0.15)]">
                <Heart className="w-6 h-6 fill-rose-400" />
              </div>
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                    Favorites & Wishlist
                  </h2>
                  <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] border border-white/10 text-xs font-mono text-white/80">
                    {favoritesCount} {favoritesCount === 1 ? 'item' : 'items'}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono text-white/40 mt-1">
                  <span className="text-emerald-400 font-semibold flex items-center gap-1">
                    <Tag className="w-3 h-3 text-emerald-400" />
                    Total: {totalRobuxValue.toLocaleString()} R$
                  </span>
                  <span>•</span>
                  <span>{onSaleCount} on sale</span>
                </div>
              </div>
            </div>

            {/* Header Actions */}
            <div className="flex items-center gap-2">
              {favoritesCount > 0 && (
                <>
                  <button
                    onClick={handleCopyAll}
                    className="px-3 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-xs font-mono text-white/80 hover:text-white flex items-center gap-1.5 transition-all active:scale-95"
                  >
                    {copiedAll ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedAll ? 'COPIED ALL' : 'Copy All IDs'}</span>
                  </button>

                  <Tooltip content={<TooltipMono label="Clear all favorites" hint={`${favoritesCount} items`} />} side="top">
                    <button
                      onClick={clearFavorites}
                      className="p-2 rounded-xl bg-white/[0.03] hover:bg-red-500/10 border border-white/10 hover:border-red-500/20 text-white/40 hover:text-red-300 transition-colors"
                      aria-label="Clear all favorites"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </Tooltip>
                </>
              )}

              <button
                onClick={onClose}
                aria-label="Close Favorites"
                className="p-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 text-white/60 hover:text-white transition-all active:scale-95 shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Filter and Search Bar */}
          {favoritesCount > 0 && (
            <div className="p-4 border-b border-white/[0.06] bg-black/20 flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="w-4 h-4 text-white/30 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filter favorites by name, group, or creator..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-8 py-2 rounded-xl bg-white/[0.03] border border-white/10 text-xs font-mono text-white placeholder:text-white/30 focus:outline-none focus:border-rose-500/50 focus:bg-white/[0.05] transition-all"
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

              {assetTypes.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto fancy-scroll py-0.5">
                  <button
                    onClick={() => setSelectedType('all')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                      selectedType === 'all'
                        ? 'bg-rose-500/20 text-rose-300 font-semibold border border-rose-500/30'
                        : 'bg-white/[0.03] text-white/50 hover:text-white border border-white/[0.06]'
                    }`}
                  >
                    All Types
                  </button>
                  {assetTypes.map((type) => (
                    <button
                      key={type}
                      onClick={() => setSelectedType(type)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                        selectedType === type
                          ? 'bg-rose-500/20 text-rose-300 font-semibold border border-rose-500/30'
                          : 'bg-white/[0.03] text-white/50 hover:text-white border border-white/[0.06]'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Items Content Scroll Area */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 fancy-scroll overscroll-contain">
            {favoritesCount === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="p-4 rounded-3xl bg-rose-500/10 border border-rose-500/20 text-rose-400/60 mb-4">
                  <Heart className="w-12 h-12" />
                </div>
                <h3 className="text-lg font-semibold text-white/80">Your Wishlist is empty</h3>
                <p className="text-xs font-mono text-white/40 mt-1.5 max-w-md">
                  Click the <Heart className="w-3.5 h-3.5 inline fill-rose-400 text-rose-400 mx-1 align-text-bottom" /> heart button on any item in group stores or player avatar outfits to save your favorite pieces here!
                </p>
              </div>
            ) : filteredFavorites.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <PackageOpen className="w-10 h-10 text-white/20 mb-3" />
                <h3 className="text-sm font-semibold text-white/70">No matching favorites</h3>
                <p className="text-xs font-mono text-white/40 mt-1">
                  Try clearing your search query or type filter.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3.5">
                {filteredFavorites.map((item) => (
                  <FavoriteItemCard
                    key={item.id}
                    item={item}
                    onRemove={() => removeFavorite(item.id)}
                    onOpenGroupStore={onOpenGroupStore}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Footer Bar */}
          <div className="px-4 sm:px-6 py-3 border-t border-white/[0.06] bg-black/40 backdrop-blur-md flex items-center justify-between text-xs font-mono text-white/40 shrink-0">
            <span>
              Showing {filteredFavorites.length} of {favoritesCount} saved items
            </span>
            <span className="hidden sm:inline text-[11px]">
              Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 border border-white/10 text-white/70">ESC</kbd> to close
            </span>
          </div>
        </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

interface FavoriteItemCardProps {
  item: FavoriteItem;
  onRemove: () => void;
  onOpenGroupStore?: (groupId: number, groupName: string) => void;
}

const FavoriteItemCard: React.FC<FavoriteItemCardProps> = ({ item, onRemove, onOpenGroupStore }) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  return (
    <div className="group relative rounded-xl sm:rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.06] hover:border-white/[0.15] p-2 sm:p-2.5 flex flex-col justify-between transition-all duration-200 shadow-sm hover:shadow-md hover:-translate-y-0.5">
      {/* Top Bar: Asset Type Badge & Remove Heart */}
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <span className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-[9px] font-mono font-medium text-white/60 uppercase truncate max-w-[90px]">
          {item.assetTypeName || 'Wearable'}
        </span>

        {/* Remove Button */}
        <Tooltip content={<TooltipMono label="Remove from Wishlist" hint={item.name.slice(0, 20)} />} side="top">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            aria-label="Remove from favorites"
            className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/30 transition-all active:scale-80 shadow-sm"
          >
            <Heart className="w-3.5 h-3.5 fill-rose-400 text-rose-400" />
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

      {/* Item Title & Creator / Group Attribution */}
      <div className="mb-1.5">
        <Tooltip content={<TooltipMono label={item.name} hint={`ID: ${item.id}`} />} side="top" align="start">
          <h4 className="text-xs font-medium text-white/90 line-clamp-2 h-8 leading-tight group-hover:text-white transition-colors cursor-default my-1 flex items-center">
            {item.name}
          </h4>
        </Tooltip>

        {item.groupId && item.groupName ? (
          <div
            role="button"
            onClick={() => onOpenGroupStore?.(item.groupId!, item.groupName!)}
            className="flex items-center gap-1 text-[10px] font-mono text-cyan-400/80 hover:text-cyan-300 transition-colors cursor-pointer truncate"
            title={`Open Store of ${item.groupName}`}
          >
            <Store className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate">{item.groupName}</span>
          </div>
        ) : (
          <div className="text-[10px] font-mono text-white/40 truncate">
            By {item.creatorName}
          </div>
        )}
      </div>

      {/* Quick Actions (Copy ID & Roblox Link) */}
      <QuickCopyStation
        assetId={item.id}
        studioLuaCommand={item.studioLuaCommand || `game:GetService("InsertService"):LoadAsset(${item.id}).Parent = workspace`}
        catalogUrl={item.catalogUrl}
        assetName={item.name}
        variant="compact"
      />
    </div>
  );
};
