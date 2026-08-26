import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Heart } from 'lucide-react';
import Balatro from './ui/Balatro';
import { useFavorites } from '../hooks/useFavorites';
import { FavoritesDrawer } from './FavoritesDrawer';
import { GroupStoreModal } from './GroupStoreModal';
import { PlayerSearch } from './PlayerSearch';

interface Stage1HeroProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
  errorMessage: string | null;
}

export const Stage1Hero: React.FC<Stage1HeroProps> = ({ onSearch, isLoading, errorMessage }) => {
  const [isFavoritesOpen, setIsFavoritesOpen] = useState(false);
  const [storeModalGroup, setStoreModalGroup] = useState<{ id: number; name: string } | null>(null);
  const { favoritesCount } = useFavorites();

  return (
    <div className="relative min-h-[100dvh] w-full flex flex-col items-center justify-center overflow-hidden px-4 sm:px-6">
      {/* Top Floating Action: Wishlist Trigger */}
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6 z-20">
        <button
          type="button"
          onClick={() => setIsFavoritesOpen(true)}
          className="px-3.5 py-2 rounded-2xl bg-black/40 hover:bg-black/60 backdrop-blur-xl border border-white/10 hover:border-white/20 text-xs font-mono text-white/80 hover:text-white flex items-center gap-2 transition-all active:scale-95 shadow-xl"
          title="Open Favorites & Wishlist"
        >
          <Heart className={`w-3.5 h-3.5 ${favoritesCount > 0 ? 'fill-rose-400 text-rose-400' : 'text-rose-400/70'}`} />
          <span className="font-medium">WISHLIST</span>
          {favoritesCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-none">
              {favoritesCount}
            </span>
          )}
        </button>
      </div>
      {/* Balatro Background */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <Balatro
          spinRotation={-4}
          spinSpeed={20}
          color1="#ffffff"
          color2="#7f8182"
          color3="#000000"
          contrast={5.5}
          lighting={0.5}
          spinAmount={0.15}
          pixelFilter={800}
        />
        {/* Vignette Overlay */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(0,0,0,0.6)_100%)]" />
      </div>

      {/* Floating Center Search Station (Zero Clutter / Richard Sancho Aesthetic) */}
      <div className="relative z-10 w-full max-w-xl flex flex-col items-center">
        {/* Syntax3 Logo */}
        <motion.div 
          className="mb-6 sm:mb-8 flex items-center justify-center w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-black/40 backdrop-blur-xl shadow-2xl border border-white/10 pointer-events-none select-none relative overflow-hidden"
          initial={{ opacity: 0, scale: 0.8, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="text-white font-mono font-bold text-3xl sm:text-4xl tracking-tighter ml-1">
            {'>:#3'}
          </span>
        </motion.div>

        <PlayerSearch onSearch={onSearch} isLoading={isLoading} />

        {/* Error Notification Pill */}
        {errorMessage && (
          <div role="alert" aria-live="polite" className="mt-4 px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono flex items-center gap-2 motion-safe:animate-bounce">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 motion-safe:animate-ping" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      {/* Favorites & Wishlist Drawer */}
      <FavoritesDrawer
        isOpen={isFavoritesOpen}
        onClose={() => setIsFavoritesOpen(false)}
        onOpenGroupStore={(gid, gname) => {
          setIsFavoritesOpen(false);
          setStoreModalGroup({ id: gid, name: gname });
        }}
      />

      {/* Group Catalog Store Modal (if opened from favorites) */}
      <GroupStoreModal
        isOpen={!!storeModalGroup}
        onClose={() => setStoreModalGroup(null)}
        group={storeModalGroup}
      />
    </div>
  );
};
