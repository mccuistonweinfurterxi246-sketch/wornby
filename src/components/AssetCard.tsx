import React, { useState } from 'react';
import { RobloxAssetItem } from '../types/roblox';
import { motion } from 'framer-motion';
import { TiltCard } from './TiltCard';
import { Card, CardContent } from './ui/card';
import { QuickCopyStation } from './QuickCopyStation';
import { AlertTriangle, Tag, Layers, User, Sparkles, Heart } from 'lucide-react';
import { Tooltip, TooltipMono } from './ui/tooltip';
import { useFavorites } from '../hooks/useFavorites';

interface AssetCardProps {
  item: RobloxAssetItem;
  index: number;
}

export const AssetCard: React.FC<AssetCardProps> = ({ item, index }) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const { isFavorite, toggleFavorite } = useFavorites();
  const isFav = isFavorite(item.id);

  // float сохранён для всех — GPU-only, 60fps
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const shouldFloat = !prefersReduced;
  const floatClass = !shouldFloat ? '' : (index % 3 === 0 ? 'animate-float-slow' : index % 3 === 1 ? 'animate-float-delayed' : 'animate-float-fast');

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        opacity: { duration: 0.38, delay: Math.min(index * 0.03, 0.28), ease: [0.22, 1, 0.36, 1] },
        y: { duration: 0.42, delay: Math.min(index * 0.03, 0.28), ease: [0.22, 1, 0.36, 1] },
      }}
    >
      <div className={`${floatClass} h-full`} style={{ contain: 'layout paint' }}>
        <TiltCard maxTilt={6} scale={1.015} className="h-full">
          <Card className="h-full flex flex-col group border-none bg-transparent shadow-none">
          <CardContent className="p-4 flex-1 flex flex-col justify-between bg-black/40 backdrop-blur-md group-hover:bg-black/60 border border-white/5 group-hover:border-white/20 rounded-2xl transition-all duration-300 shadow-inner">
            {/* Top Bar: Asset Type, Price/Status Tag, & 1-Click Wishlist Heart */}
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <span className="px-2 py-0.5 rounded-md text-[10px] uppercase font-mono tracking-wider bg-white/[0.04] text-white/70 border border-white/[0.06] flex items-center gap-1 truncate">
                  <Layers className="w-2.5 h-2.5 text-white/40 shrink-0" />
                  <span className="truncate">{item.assetTypeName || 'Wearable'}</span>
                </span>
              </div>

              {/* Right: Price Tag + Heart Toggle */}
              <div className="flex items-center gap-1.5 shrink-0">
                {item.isDeletedOrModerated ? (
                  <div className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 font-mono text-xs font-semibold">
                    <AlertTriangle className="w-3 h-3 text-red-400" />
                    <span>DELETED</span>
                  </div>
                ) : item.price !== null && item.price > 0 ? (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 font-mono text-xs font-semibold shadow-sm">
                    <Tag className="w-3 h-3 text-emerald-400" />
                    <span>{item.price.toLocaleString()} R$</span>
                  </div>
                ) : item.isFree ? (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 font-mono text-xs font-semibold shadow-sm">
                    <Sparkles className="w-3 h-3 text-emerald-400" />
                    <span>FREE</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-300/80 font-mono text-xs">
                    <span>OFF-SALE</span>
                  </div>
                )}

                {/* 1-Click Heart Button */}
                <Tooltip content={<TooltipMono label={isFav ? 'Saved in Favorites' : 'Add to Favorites'} hint={item.name.slice(0, 20)} />} side="top">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(item);
                    }}
                    aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                    className={`p-1.5 rounded-lg transition-all active:scale-85 ${
                      isFav
                        ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40 shadow-[0_0_10px_rgba(244,63,94,0.3)]'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/40 hover:text-rose-300 border border-white/[0.06]'
                    }`}
                  >
                    <Heart className={`w-3.5 h-3.5 ${isFav ? 'fill-rose-400 text-rose-400' : ''}`} />
                  </button>
                </Tooltip>
              </div>
            </div>

            {/* Thumbnail Canvas View */}
            <div className="relative aspect-square w-full rounded-xl bg-black/40 border border-white/[0.04] overflow-hidden flex items-center justify-center p-3 mb-3 group-hover:border-white/[0.12] transition-colors duration-300">
              {/* Subtle background glow */}
              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/30 pointer-events-none" />
              
              {item.thumbnailUrl && !imageError ? (
                <img
                  src={item.thumbnailUrl}
                  alt={item.name}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  // crossOrigin убран — rbxcdn не отдаёт CORS для 180DAY/RightArm, иначе (null) блок
                  onLoad={() => setImageLoaded(true)}
                  onError={() => {
                    setImageError(true);
                  }}
                  className={`w-full h-full object-contain filter drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)] transition-all duration-500 transform group-hover:scale-110 ${
                    imageLoaded ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                  }`}
                />
              ) : (
                <div className="text-center p-4">
                  <div className="w-12 h-12 rounded-full bg-white/[0.04] border border-white/[0.06] flex items-center justify-center mx-auto mb-2 text-white/30 font-mono text-sm">
                    #{item.id.toString().slice(-4)}
                  </div>
                  <span className="text-[10px] font-mono text-white/40 uppercase tracking-wider block">
                    {item.isDeletedOrModerated ? 'ARCHIVED THUMBNAIL' : 'PREVIEW UNAVAILABLE'}
                  </span>
                </div>
              )}

              {/* Moderated fallback watermark */}
              {item.isDeletedOrModerated && (
                <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/80 backdrop-blur-md border border-red-500/40 text-[9px] font-mono text-red-400">
                  ARCHIVED
                </div>
              )}
            </div>

            {/* Item Title & Creator Metadata */}
            <div className="mb-3">
              <Tooltip content={<TooltipMono label={item.name.slice(0,32)} hint={item.assetTypeName || 'Wearable'} />} side="top" align="start">
                <h3 
                  className="text-sm font-semibold text-white/95 truncate group-hover:text-white transition-colors cursor-default"
                >
                  {item.name}
                </h3>
              </Tooltip>
              
              <div className="flex items-center gap-1.5 mt-1 text-xs text-white/40">
                <User className="w-3 h-3 text-white/30" />
                <span className="truncate">By {item.creatorName}</span>
              </div>
            </div>

            {/* Complete Quick-Copy Station */}
            <QuickCopyStation
              assetId={item.id}
              studioLuaCommand={item.studioLuaCommand}
              catalogUrl={item.catalogUrl}
              assetName={item.name}
              variant="compact"
            />
          </CardContent>
        </Card>
      </TiltCard>
      </div>
    </motion.div>
  );
};
