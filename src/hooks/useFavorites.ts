import { useState, useEffect, useCallback, useMemo } from 'react';
import { RobloxAssetItem } from '../types/roblox';
import { toast } from 'sonner';
import { AudioHaptics } from '../components/AudioHaptics';

export interface FavoriteItem {
  id: number;
  name: string;
  description?: string;
  price: number | null;
  lowestPrice?: number | null;
  isForSale: boolean;
  isOffSale: boolean;
  isFree: boolean;
  thumbnailUrl: string | null;
  assetTypeName?: string;
  creatorName: string;
  creatorId?: number;
  creatorType?: string;
  groupId?: number;
  groupName?: string;
  addedAt: number;
  catalogUrl: string;
  studioLuaCommand?: string;
}

const STORAGE_KEY = 'wornby_favorites_v1';
const EVENT_KEY = 'wornby_favorites_updated';

function loadFavoritesFromStorage(): FavoriteItem[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavoritesToStorage(items: FavoriteItem[]) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent(EVENT_KEY, { detail: items }));
  } catch (e) {
    console.error('Failed to save favorites to localStorage:', e);
  }
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoriteItem[]>(loadFavoritesFromStorage);

  useEffect(() => {
    const handleUpdate = () => {
      setFavorites(loadFavoritesFromStorage());
    };
    window.addEventListener(EVENT_KEY, handleUpdate);
    window.addEventListener('storage', handleUpdate);
    return () => {
      window.removeEventListener(EVENT_KEY, handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, []);

  const favoriteIds = useMemo(() => new Set(favorites.map((f) => f.id)), [favorites]);

  const isFavorite = useCallback(
    (id: number) => favoriteIds.has(id),
    [favoriteIds]
  );

  const addFavorite = useCallback(
    (item: RobloxAssetItem, groupMeta?: { id: number; name: string }) => {
      setFavorites((prev) => {
        if (prev.some((f) => f.id === item.id)) return prev;
        const newFav: FavoriteItem = {
          id: item.id,
          name: item.name,
          description: item.description,
          price: item.price,
          lowestPrice: item.lowestPrice,
          isForSale: item.isForSale,
          isOffSale: item.isOffSale,
          isFree: item.isFree,
          thumbnailUrl: item.thumbnailUrl,
          assetTypeName: item.assetTypeName,
          creatorName: groupMeta?.name || item.creatorName,
          creatorId: groupMeta?.id || item.creatorId,
          creatorType: groupMeta ? 'Group' : item.creatorType,
          groupId: groupMeta?.id,
          groupName: groupMeta?.name,
          addedAt: Date.now(),
          catalogUrl: item.catalogUrl || `https://www.roblox.com/catalog/${item.id}`,
          studioLuaCommand: item.studioLuaCommand || `game:GetService("InsertService"):LoadAsset(${item.id}).Parent = workspace`,
        };
        const next = [newFav, ...prev];
        saveFavoritesToStorage(next);
        return next;
      });
      AudioHaptics.playCopyPunch();
      toast.success('Added to Favorites', { description: item.name });
    },
    []
  );

  const removeFavorite = useCallback((id: number) => {
    setFavorites((prev) => {
      const target = prev.find((f) => f.id === id);
      const next = prev.filter((f) => f.id !== id);
      saveFavoritesToStorage(next);
      if (target) {
        toast.info('Removed from Favorites', { description: target.name });
      }
      return next;
    });
  }, []);

  const toggleFavorite = useCallback(
    (item: RobloxAssetItem, groupMeta?: { id: number; name: string }): boolean => {
      if (favoriteIds.has(item.id)) {
        removeFavorite(item.id);
        return false;
      } else {
        addFavorite(item, groupMeta);
        return true;
      }
    },
    [favoriteIds, removeFavorite, addFavorite]
  );

  const clearFavorites = useCallback(() => {
    setFavorites([]);
    saveFavoritesToStorage([]);
    toast.info('Favorites cleared');
  }, []);

  const totalRobuxValue = useMemo(() => {
    return favorites.reduce((sum, item) => sum + (typeof item.price === 'number' && item.price > 0 ? item.price : 0), 0);
  }, [favorites]);

  const onSaleCount = useMemo(() => {
    return favorites.filter((f) => f.isForSale).length;
  }, [favorites]);

  const copyAllIds = useCallback(async () => {
    if (favorites.length === 0) return false;
    const text = favorites.map((f) => f.id).join(', ');
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      AudioHaptics.playCopyPunch();
      toast.success('All Asset IDs Copied!', { description: `${favorites.length} IDs copied (${text.slice(0, 30)}...)` });
      return true;
    } catch {
      toast.error('Failed to copy IDs');
      return false;
    }
  }, [favorites]);

  return {
    favorites,
    favoritesCount: favorites.length,
    isFavorite,
    toggleFavorite,
    addFavorite,
    removeFavorite,
    clearFavorites,
    totalRobuxValue,
    onSaleCount,
    copyAllIds,
  };
}
