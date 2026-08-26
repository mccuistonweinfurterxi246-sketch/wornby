import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { RobloxAssetItem, RobloxGroupMembership } from '../types/roblox';
import { RobloxApiClient } from '../services/api';
import { useFavorites } from '../hooks/useFavorites';
import { useClipboard } from '../hooks/useClipboard';
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
  ChevronLeft,
  ChevronRight,
  Copy,
  ListFilter,
  Undo2,
  Trash2,
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
  groups?: RobloxGroupMembership[];
}

type FilterCategory = 'all' | 'on_sale' | 'free' | 'off_sale';
type SortOption = 'RecentlyCreated' | 'PriceAsc' | 'PriceDesc';
type PriceFilter = 'all' | 'free' | 'under100' | '100plus';
type GroupStoreAvailability = 'checking' | 'has_items' | 'empty' | 'error';
type StorePage = { items: RobloxAssetItem[]; nextPageCursor: string | null };

const SELECTED_ITEMS_KEY = 'wornby_store_selected_items_v1';
const STORE_VIEW_KEY = 'wornby_store_view_state_v1';
// Roblox catalog cursors are tied to the page size that created them.
// Keep this value identical for the first and every following page.
const GROUP_STORE_PAGE_SIZE = 10;

function loadStoredItems(): RobloxAssetItem[] {
  try {
    if (typeof window === 'undefined') return [];
    const stored = JSON.parse(localStorage.getItem(SELECTED_ITEMS_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter((item): item is RobloxAssetItem => Number.isSafeInteger(item?.id) && item.id > 0) : [];
  } catch { return []; }
}

function loadStoreView(): { filters: Record<string, { searchQuery: string; filterCategory: FilterCategory; priceFilter: PriceFilter; assetType: string; scrollTop: number }> } {
  try {
    if (typeof window === 'undefined') return { filters: {} };
    const stored = JSON.parse(localStorage.getItem(STORE_VIEW_KEY) || '{"filters":{}}');
    return stored && typeof stored === 'object' && stored.filters && typeof stored.filters === 'object' ? stored : { filters: {} };
  } catch { return { filters: {} }; }
}

export const GroupStoreModal: React.FC<GroupStoreModalProps> = ({
  isOpen,
  onClose,
  group,
  groups = [],
}) => {
  const availableGroups = useMemo(
    () => groups.length > 0 ? groups : group ? [group as RobloxGroupMembership] : [],
    [groups, group]
  );
  const [activeGroup, setActiveGroup] = useState<typeof group>(group);
  const [items, setItems] = useState<RobloxAssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<FilterCategory>('all');
  const [sortOption, setSortOption] = useState<SortOption>('RecentlyCreated');
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('all');
  const [assetType, setAssetType] = useState('all');
  const [selectedItems, setSelectedItems] = useState<RobloxAssetItem[]>(loadStoredItems);
  const [selectionMode, setSelectionMode] = useState(false);
  const [isSelectionOpen, setIsSelectionOpen] = useState(false);
  const [isGroupsOpen, setIsGroupsOpen] = useState(false);
  const [copyFormat, setCopyFormat] = useState<'comma' | 'space' | 'newline'>('comma');
  const [lastSelection, setLastSelection] = useState<RobloxAssetItem[] | null>(null);
  const [loadedCounts, setLoadedCounts] = useState<Record<number, number>>({});
  const [saleCounts, setSaleCounts] = useState<Record<number, number>>({});
  const [groupAvailability, setGroupAvailability] = useState<Record<number, GroupStoreAvailability>>({});
  const [groupQuery, setGroupQuery] = useState('');
  const [newItemIds, setNewItemIds] = useState<Set<number>>(new Set());
  const [isDragOverSelection, setIsDragOverSelection] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<number, number>>({});
  const storeView = useRef(loadStoreView());
  const seenBaselinesRef = useRef<Record<number, Set<number>>>({});
  const scrollPersistTimerRef = useRef<number | null>(null);
  const requestGenerationRef = useRef(0);
  const paginationInFlightRef = useRef(false);
  const draggedItemRef = useRef<RobloxAssetItem | null>(null);
  const groupAvailabilityRef = useRef<Record<number, GroupStoreAvailability>>({});
  const storeCacheRef = useRef<Map<string, StorePage>>(new Map());
  const storePrefetchesRef = useRef<Map<number, Promise<StorePage>>>(new Map());
  const autoPrefetchBudgetRef = useRef(4);
  const autoLoadRequestRef = useRef('');
  const activeGroupIdRef = useRef<number | null>(activeGroup?.id ?? null);
  activeGroupIdRef.current = activeGroup?.id ?? null;

  const { isFavorite, toggleFavorite } = useFavorites();
  const { copy } = useClipboard();

  const updateGroupAvailability = useCallback((groupId: number, status: GroupStoreAvailability) => {
    groupAvailabilityRef.current[groupId] = status;
    setGroupAvailability((current) => current[groupId] === status ? current : { ...current, [groupId]: status });
  }, []);

  const prefetchGroupStore = useCallback((groupId: number, signal?: AbortSignal): Promise<StorePage> => {
    const cacheKey = `${groupId}:RecentlyCreated`;
    const cached = storeCacheRef.current.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    const pending = storePrefetchesRef.current.get(groupId);
    if (pending) return pending;

    const request = RobloxApiClient.fetchGroupStore(groupId, '', GROUP_STORE_PAGE_SIZE, 'RecentlyCreated', 'Desc', signal)
      .then((result) => {
        storeCacheRef.current.set(cacheKey, result);
        updateGroupAvailability(groupId, result.items.length > 0 ? 'has_items' : 'empty');
        setLoadedCounts((current) => ({ ...current, [groupId]: result.items.length }));
        setSaleCounts((current) => ({ ...current, [groupId]: result.items.filter((item) => item.isForSale && !item.isFree).length }));
        return result;
      })
      .finally(() => storePrefetchesRef.current.delete(groupId));
    storePrefetchesRef.current.set(groupId, request);
    return request;
  }, [updateGroupAvailability]);

  const fetchItems = useCallback(
    async (isInitial = true, cursor = '') => {
      if (!activeGroup) return;
      if (!isInitial && paginationInFlightRef.current) return;
      const generation = isInitial ? ++requestGenerationRef.current : requestGenerationRef.current;
      if (!isInitial) paginationInFlightRef.current = true;
      if (isInitial) {
        setLoading(true);
        setHasError(false);
      } else {
        setLoadingMore(true);
      }

      try {
        const cacheKey = `${activeGroup.id}:${sortOption}`;
        if (isInitial && sortOption === 'RecentlyCreated') {
          let cached = storeCacheRef.current.get(cacheKey);
          const pending = storePrefetchesRef.current.get(activeGroup.id);
          if (!cached && pending) {
            try { cached = await pending; } catch {}
          }
          if (generation !== requestGenerationRef.current) return;
          if (cached) {
            setItems(cached.items);
            setNextCursor(cached.nextPageCursor);
            setLoadedCounts((prev) => ({ ...prev, [activeGroup.id]: cached.items.length }));
            setSaleCounts((prev) => ({ ...prev, [activeGroup.id]: cached.items.filter((item) => item.isForSale && !item.isFree).length }));
            updateGroupAvailability(activeGroup.id, cached.items.length > 0 ? 'has_items' : 'empty');
            setHasError(false);
            return;
          }
        }

        const sortOrder = sortOption === 'PriceAsc' ? 'Asc' : 'Desc';
        const res = await RobloxApiClient.fetchGroupStore(
          activeGroup.id,
          cursor,
          GROUP_STORE_PAGE_SIZE,
          sortOption,
          sortOrder
        );
        if (generation !== requestGenerationRef.current) return;
        if (isInitial) {
          setItems(res.items);
          storeCacheRef.current.set(cacheKey, res);
        } else {
          setItems((prev) => {
            const existingIds = new Set(prev.map((i) => i.id));
            const newItems = res.items.filter((i) => !existingIds.has(i.id));
            const mergedItems = [...prev, ...newItems];
            storeCacheRef.current.set(cacheKey, { items: mergedItems, nextPageCursor: res.nextPageCursor });
            return mergedItems;
          });
        }
        setNextCursor(res.nextPageCursor);
        setLoadedCounts((prev) => ({ ...prev, [activeGroup.id]: isInitial ? res.items.length : (prev[activeGroup.id] || 0) + res.items.length }));
        setSaleCounts((prev) => ({ ...prev, [activeGroup.id]: isInitial ? res.items.filter((item) => item.isForSale && !item.isFree).length : (prev[activeGroup.id] || 0) + res.items.filter((item) => item.isForSale && !item.isFree).length }));
        updateGroupAvailability(activeGroup.id, res.items.length > 0 || !isInitial ? 'has_items' : 'empty');
        setHasError(false);
      } catch {
        if (generation !== requestGenerationRef.current) return;
        toast.error('Failed to load group catalog items');
        if (isInitial) {
          setHasError(true);
          updateGroupAvailability(activeGroup.id, 'error');
        }
      } finally {
        if (generation === requestGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
        if (generation === requestGenerationRef.current) paginationInFlightRef.current = false;
      }
    },
    [activeGroup, sortOption, updateGroupAvailability]
  );

  const loadAllRemaining = useCallback(async (silent = false) => {
    if (!activeGroup || !nextCursor || loadingAll || loadingMore) return;
    setLoadingAll(true);
    const generation = requestGenerationRef.current;
    const cacheKey = `${activeGroup.id}:${sortOption}`;
    let cur: string | null = nextCursor;
    let pageCount = 0;
    try {
      const sortOrder = sortOption === 'PriceAsc' ? 'Asc' : 'Desc';
      while (cur) {
        pageCount++;
        const res = await RobloxApiClient.fetchGroupStore(
          activeGroup.id,
          cur,
          GROUP_STORE_PAGE_SIZE,
          sortOption,
          sortOrder
        );
        if (generation !== requestGenerationRef.current) return;
        setItems((prev) => {
          const existingIds = new Set(prev.map((i) => i.id));
          const newItems = res.items.filter((i) => !existingIds.has(i.id));
          const mergedItems = [...prev, ...newItems];
          storeCacheRef.current.set(cacheKey, { items: mergedItems, nextPageCursor: res.nextPageCursor });
          return mergedItems;
        });
        cur = res.nextPageCursor;
        setNextCursor(cur);
        setLoadedCounts((prev) => ({ ...prev, [activeGroup.id]: (prev[activeGroup.id] || 0) + res.items.length }));
        setSaleCounts((prev) => ({ ...prev, [activeGroup.id]: (prev[activeGroup.id] || 0) + res.items.filter((item) => item.isForSale && !item.isFree).length }));
        if (!cur) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!silent) toast.success('Loaded all items from group catalog!');
    } catch {
      if (!silent) toast.error('Partially loaded; click again to continue fetching.');
    } finally {
      setLoadingAll(false);
    }
  }, [activeGroup, loadingAll, loadingMore, nextCursor, sortOption]);

  useEffect(() => {
    if (isOpen && activeGroup) {
      autoLoadRequestRef.current = '';
      setItems([]);
      setNextCursor(null);
      setHasError(false);
      fetchItems(true, '');
    }
  }, [isOpen, activeGroup?.id, sortOption]);

  useEffect(() => {
    if (!isOpen || !activeGroup || items.length === 0 || !nextCursor || loading || loadingAll || loadingMore) return;
    const requestKey = `${activeGroup.id}:${sortOption}:${nextCursor}`;
    if (autoLoadRequestRef.current === requestKey) return;
    autoLoadRequestRef.current = requestKey;
    void loadAllRemaining(true);
  }, [activeGroup?.id, isOpen, items.length, loadAllRemaining, loading, loadingAll, loadingMore, nextCursor, sortOption]);

  useEffect(() => {
    if (isOpen && group) {
      const storedId = Number(localStorage.getItem('wornby_last_store_group'));
      setActiveGroup(availableGroups.find((candidate) => candidate.id === storedId) || group);
    }
  }, [isOpen, group, availableGroups]);

  useEffect(() => {
    if (!isOpen || availableGroups.length === 0) return;
    const controller = new AbortController();
    autoPrefetchBudgetRef.current = 4;

    const initialStatuses = Object.fromEntries(availableGroups.map((candidate) => [
      candidate.id,
      groupAvailabilityRef.current[candidate.id] || 'checking',
    ])) as Record<number, GroupStoreAvailability>;
    groupAvailabilityRef.current = initialStatuses;
    setGroupAvailability(initialStatuses);

    let nextIndex = 0;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const candidate = availableGroups[nextIndex++];
        if (!candidate) return;
        const knownStatus = groupAvailabilityRef.current[candidate.id];
        if (knownStatus === 'has_items' || knownStatus === 'empty') continue;

        updateGroupAvailability(candidate.id, 'checking');
        try {
          const status = await RobloxApiClient.fetchGroupStoreStatus(candidate.id, controller.signal);
          if (controller.signal.aborted) return;
          updateGroupAvailability(candidate.id, status.hasItems ? 'has_items' : 'empty');
          if (status.hasItems && candidate.id !== activeGroupIdRef.current && autoPrefetchBudgetRef.current > 0) {
            autoPrefetchBudgetRef.current -= 1;
            void prefetchGroupStore(candidate.id, controller.signal).catch(() => undefined);
          }
        } catch {
          if (!controller.signal.aborted) updateGroupAvailability(candidate.id, 'error');
        }
      }
    };

    void Promise.all([worker(), worker(), worker()]);
    return () => controller.abort();
  }, [availableGroups, isOpen, prefetchGroupStore, updateGroupAvailability]);

  useEffect(() => {
    if (!activeGroup || groupAvailability[activeGroup.id] !== 'empty') return;
    const nextGroup = availableGroups.find((candidate) => groupAvailability[candidate.id] === 'has_items');
    if (nextGroup) setActiveGroup(nextGroup);
  }, [activeGroup, availableGroups, groupAvailability]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        if (isSelectionOpen) setIsSelectionOpen(false);
        else if (isGroupsOpen) setIsGroupsOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isGroupsOpen, isSelectionOpen, onClose]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      // Category filter
      if (filterCategory === 'on_sale' && (!item.isForSale || item.isFree)) return false;
      if (filterCategory === 'free' && !item.isFree) return false;
      if (filterCategory === 'off_sale' && item.isForSale) return false;
      if (assetType !== 'all' && item.assetTypeName !== assetType) return false;
      if (priceFilter === 'free' && !item.isFree) return false;
      if (priceFilter === 'under100' && (item.price === null || item.price >= 100)) return false;
      if (priceFilter === '100plus' && (item.price === null || item.price < 100)) return false;

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
  }, [items, filterCategory, searchQuery, assetType, priceFilter]);

  const assetTypes = useMemo(() => Array.from(new Set(items.map((item) => item.assetTypeName).filter(Boolean))) as string[], [items]);
  const filteredGroups = useMemo(() => availableGroups.filter((storeGroup) => {
    return groupAvailability[storeGroup.id] !== 'empty' && storeGroup.name.toLowerCase().includes(groupQuery.toLowerCase().trim());
  }), [availableGroups, groupAvailability, groupQuery]);
  const visibleGroupCount = useMemo(
    () => availableGroups.filter((storeGroup) => groupAvailability[storeGroup.id] !== 'empty').length,
    [availableGroups, groupAvailability]
  );
  const selectedIds = useMemo(() => new Set(selectedItems.map((item) => item.id)), [selectedItems]);
  const selectedTotal = useMemo(() => selectedItems.reduce((sum, item) => sum + (item.price && item.price > 0 ? item.price : 0), 0), [selectedItems]);

  useEffect(() => {
    try { localStorage.setItem(SELECTED_ITEMS_KEY, JSON.stringify(selectedItems)); } catch {}
  }, [selectedItems]);

  useEffect(() => () => {
    if (scrollPersistTimerRef.current !== null) window.clearTimeout(scrollPersistTimerRef.current);
  }, []);

  useEffect(() => {
    const handleUndo = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && lastSelection) {
        event.preventDefault();
        setSelectedItems(lastSelection);
        setLastSelection(null);
      }
    };
    window.addEventListener('keydown', handleUndo);
    return () => window.removeEventListener('keydown', handleUndo);
  }, [lastSelection]);

  useEffect(() => {
    if (!activeGroup) return;
    const saved = storeView.current.filters[activeGroup.id];
    if (saved) {
      setSearchQuery(saved.searchQuery);
      setFilterCategory(saved.filterCategory);
      setPriceFilter(saved.priceFilter);
      setAssetType(saved.assetType);
      scrollPositions.current[activeGroup.id] = Number.isFinite(saved.scrollTop) ? saved.scrollTop : 0;
    } else {
      setSearchQuery('');
      setFilterCategory('all');
      setPriceFilter('all');
      setAssetType('all');
      scrollPositions.current[activeGroup.id] = 0;
    }
    const seenKey = `wornby_store_seen_${activeGroup.id}`;
    try {
      if (!seenBaselinesRef.current[activeGroup.id]) {
        seenBaselinesRef.current[activeGroup.id] = new Set<number>(JSON.parse(localStorage.getItem(seenKey) || '[]'));
      }
      const baseline = seenBaselinesRef.current[activeGroup.id];
      setNewItemIds(new Set(baseline.size > 0 ? items.filter((item) => !baseline.has(item.id)).map((item) => item.id) : []));
      localStorage.setItem(seenKey, JSON.stringify(Array.from(new Set([...baseline, ...items.map((item) => item.id)]))));
    } catch { setNewItemIds(new Set()); }
  }, [activeGroup?.id, items]);

  useEffect(() => {
    if (!activeGroup || !isOpen) return;
    storeView.current.filters[activeGroup.id] = { searchQuery, filterCategory, priceFilter, assetType, scrollTop: scrollPositions.current[activeGroup.id] || 0 };
    try { localStorage.setItem(STORE_VIEW_KEY, JSON.stringify(storeView.current)); } catch {}
  }, [activeGroup?.id, isOpen, searchQuery, filterCategory, priceFilter, assetType]);

  const updateSelection = (next: RobloxAssetItem[]) => {
    setLastSelection(selectedItems);
    setSelectedItems(Array.from(new Map(next.map((item) => [item.id, item])).values()));
  };

  const toggleSelection = (item: RobloxAssetItem, shiftKey = false) => {
    if (shiftKey && selectedItems.length > 0) {
      const lastIndex = filteredItems.findIndex((candidate) => candidate.id === selectedItems[selectedItems.length - 1].id);
      const itemIndex = filteredItems.findIndex((candidate) => candidate.id === item.id);
      if (lastIndex >= 0 && itemIndex >= 0) {
        const range = filteredItems.slice(Math.min(lastIndex, itemIndex), Math.max(lastIndex, itemIndex) + 1);
        updateSelection(selectedItems.concat(range));
        return;
      }
    }
    updateSelection(selectedIds.has(item.id) ? selectedItems.filter((selected) => selected.id !== item.id) : selectedItems.concat(item));
  };

  const copySelected = async () => {
    const separator = copyFormat === 'comma' ? ', ' : copyFormat === 'space' ? ' ' : '\n';
    const copied = await copy(selectedItems.map((item) => item.id).join(separator), 'store-items');
    if (copied) toast.success('Copied!', { description: `${selectedItems.length} ID${selectedItems.length === 1 ? '' : 's'}` });
    else toast.error('Could not copy item IDs');
  };

  const dropDraggedItem = () => {
    const draggedItem = draggedItemRef.current;
    if (draggedItem && !selectedIds.has(draggedItem.id)) updateSelection(selectedItems.concat(draggedItem));
    draggedItemRef.current = null;
    setIsDragOverSelection(false);
  };

  const handleCatalogScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!activeGroup) return;
    const element = event.currentTarget;
    scrollPositions.current[activeGroup.id] = element.scrollTop;
    if (scrollPersistTimerRef.current !== null) window.clearTimeout(scrollPersistTimerRef.current);
    scrollPersistTimerRef.current = window.setTimeout(() => {
      const saved = storeView.current.filters[activeGroup.id];
      if (!saved) return;
      saved.scrollTop = element.scrollTop;
      try { localStorage.setItem(STORE_VIEW_KEY, JSON.stringify(storeView.current)); } catch {}
    }, 150);
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 420 && nextCursor && !loadingMore && !loadingAll) {
      fetchItems(false, nextCursor);
    }
  };

  useEffect(() => {
    if (scrollRef.current && activeGroup) scrollRef.current.scrollTop = scrollPositions.current[activeGroup.id] || 0;
  }, [activeGroup?.id, items.length]);

  const onSaleCount = useMemo(() => items.filter((i) => i.isForSale && !i.isFree).length, [items]);
  const freeCount = useMemo(() => items.filter((i) => i.isFree).length, [items]);
  const offSaleCount = useMemo(() => items.filter((i) => !i.isForSale).length, [items]);

  if (!isOpen || !activeGroup) return null;

  const currentGroup = activeGroup;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden p-0">
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
          className="relative flex h-[100dvh] w-[100vw] max-w-none flex-col overflow-hidden rounded-none border-0 bg-neutral-950 shadow-none"
        >
          {/* Header Bar */}
          <div className="p-3.5 sm:p-5 border-b border-white/[0.08] bg-black/40 backdrop-blur-md flex items-center justify-between gap-3 shrink-0">
            {/* Group Identity */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl bg-black/60 border border-white/15 overflow-hidden shrink-0 flex items-center justify-center shadow-md">
                {currentGroup.iconUrl ? (
                  <img
                    src={currentGroup.iconUrl}
                    alt={currentGroup.name}
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
                    {currentGroup.name}
                  </h2>
                  {currentGroup.hasVerifiedBadge && (
                    <BadgeCheck className="w-4 h-4 text-white shrink-0" />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] sm:text-xs font-mono text-white/40 mt-0.5">
                  <span className="flex items-center gap-1">
                    <Store className="w-3 h-3 text-white/70" /> Group Store
                  </span>
                  {typeof currentGroup.memberCount === 'number' && (
                    <>
                      <span>•</span>
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3 text-white/30" />
                        {currentGroup.memberCount.toLocaleString()} members
                      </span>
                    </>
                  )}
                  <span>•</span>
                  <a
                    href={`https://www.roblox.com/groups/${currentGroup.id}/store`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-white/60 hover:text-white transition-colors"
                  >
                    <span>Roblox Store</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>

            {/* Header Actions */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button onClick={() => setIsGroupsOpen(true)} className="md:hidden p-2 sm:p-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 text-white/60 hover:text-white" aria-label="Open groups"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => setIsSelectionOpen(true)} className="relative lg:hidden p-2 sm:p-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-white" aria-label={`Open selected items (${selectedItems.length})`}><ListFilter className="w-4 h-4" />{selectedItems.length > 0 && <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-white px-1 text-center text-[9px] font-bold leading-4 text-neutral-950">{selectedItems.length > 99 ? '99+' : selectedItems.length}</span>}</button>
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
          <div className="z-20 shrink-0 border-b border-white/[0.06] bg-black/80 p-3 backdrop-blur-xl sm:p-4">
            <div className="grid items-center gap-2.5 lg:grid-cols-[minmax(220px,1fr)_auto] lg:gap-3">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-white/30 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search items in group..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] py-2 pl-9 pr-8 text-xs font-mono text-white placeholder:text-white/35 transition-all focus:border-white/35 focus:bg-white/[0.05] focus:outline-none"
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
            <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1 no-scrollbar lg:justify-end lg:pb-0">
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
                        ? 'bg-white/15 text-white font-semibold border border-white/25 shadow-sm'
                        : 'bg-white/[0.03] text-white/50 hover:text-white border border-white/[0.06]'
                    }`}
                  >
                    <Sparkles className="w-3 h-3 text-white/70" />
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
              <FilterMenu label="Sort catalog" icon={<ArrowUpDown className="w-3.5 h-3.5" />} value={sortOption} options={[['RecentlyCreated', 'Newest'], ['PriceAsc', 'Price: Low to High'], ['PriceDesc', 'Price: High to Low']]} onChange={(value) => setSortOption(value as SortOption)} />
              <FilterMenu label="Clothing type" value={assetType} options={[['all', 'All clothing'], ...assetTypes.map((type) => [type, type] as [string, string])]} onChange={setAssetType} />
              <FilterMenu label="Price range" value={priceFilter} options={ [['all', 'Any price'], ['free', 'Free'], ['under100', 'Under 100 R$'], ['100plus', '100+ R$']] } onChange={(value) => setPriceFilter(value as PriceFilter)} />
            </div>
            </div>
          </div>

          {/* Three-pane store workspace */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {(isGroupsOpen || isSelectionOpen) && <button type="button" className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={() => { setIsGroupsOpen(false); setIsSelectionOpen(false); }} aria-label="Close side panel" />}
            <aside className={`${isGroupsOpen ? 'fixed inset-y-0 left-0 z-[60] flex w-[min(18rem,88vw)] shadow-2xl' : 'hidden md:flex w-56 lg:w-64'} shrink-0 flex-col border-r border-white/[0.08] bg-neutral-950/95 backdrop-blur-xl`}>
              <div className="p-3 border-b border-white/[0.06]">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-[0.18em] font-mono text-white/35">Player groups</span>
                  <span className="flex items-center gap-2"><span className="text-[10px] font-mono text-white/40">{visibleGroupCount} stores</span><button type="button" onClick={() => setIsGroupsOpen(false)} className="md:hidden text-white/40 hover:text-white" aria-label="Close groups"><X className="w-4 h-4" /></button></span>
                </div>
                <p className="text-[11px] text-white/35 truncate">Switch stores without leaving</p>
                <div className="relative mt-2"><Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" /><input value={groupQuery} onChange={(event) => setGroupQuery(event.target.value)} placeholder="Find a group..." className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2 pl-8 pr-2 text-[11px] font-mono text-white placeholder:text-white/35 focus:border-white/35 focus:outline-none" /></div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 fancy-scroll">
                {filteredGroups.map((storeGroup) => (
                  <button
                    key={storeGroup.id}
                    type="button"
                    onClick={() => { setActiveGroup(storeGroup); localStorage.setItem('wornby_last_store_group', String(storeGroup.id)); setIsGroupsOpen(false); }}
                    onPointerEnter={() => { if (groupAvailability[storeGroup.id] !== 'empty') void prefetchGroupStore(storeGroup.id).catch(() => undefined); }}
                    onFocus={() => { if (groupAvailability[storeGroup.id] !== 'empty') void prefetchGroupStore(storeGroup.id).catch(() => undefined); }}
                    className={`w-full flex items-center gap-2.5 rounded-xl p-2 text-left transition-all ${storeGroup.id === activeGroup.id ? 'bg-white/10 border border-white/25 text-white' : 'border border-transparent text-white/60 hover:bg-white/[0.05] hover:text-white'}`}
                  >
                    {storeGroup.iconUrl ? <img src={storeGroup.iconUrl} alt="" className="w-8 h-8 rounded-lg object-cover bg-black/40" /> : <div className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center"><Store className="w-3.5 h-3.5 text-white/35" /></div>}
                    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{storeGroup.name}</span><span className="block text-[10px] font-mono text-white/40 mt-0.5">{loadedCounts[storeGroup.id] !== undefined ? `${loadedCounts[storeGroup.id]} loaded · ${saleCounts[storeGroup.id] || 0} for sale` : groupAvailability[storeGroup.id] === 'checking' ? 'Checking store…' : groupAvailability[storeGroup.id] === 'has_items' ? 'Ready to open' : 'Open store'}</span></span>
                    {storeGroup.id === activeGroup.id && <ChevronRight className="w-3.5 h-3.5 text-white shrink-0" />}
                  </button>
                ))}
                {filteredGroups.length === 0 && <div className="px-3 py-8 text-center text-[11px] font-mono text-white/40">No group stores found.</div>}
              </div>
            </aside>

            {/* Items Content Scroll Area */}
            <div ref={scrollRef} onScroll={handleCatalogScroll} className="flex-1 min-w-0 overflow-y-auto p-3 sm:p-5 fancy-scroll overscroll-contain">
            {loading && items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 space-y-3">
                <RefreshCw className="w-8 h-8 text-white animate-spin" />
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
                  className="mt-2 px-5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white border border-white/20 text-xs font-mono font-medium flex items-center gap-2 transition-all active:scale-95 shadow-sm"
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
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                {filteredItems.map((item) => {
                  const wishlisted = isFavorite(item.id);
                  return (
                    <StoreItemCard
                      key={item.id}
                      item={item}
                      isWishlisted={wishlisted}
                      onToggleWishlist={() => toggleFavorite(item, { id: activeGroup.id, name: activeGroup.name })}
                      isSelected={selectedIds.has(item.id)}
                      isNew={newItemIds.has(item.id)}
                      selectionMode={selectionMode}
                      onSelect={(shiftKey) => toggleSelection(item, shiftKey)}
                      onDragStart={() => { draggedItemRef.current = item; }}
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
                  onClick={() => void loadAllRemaining(false)}
                  disabled={loadingMore || loadingAll}
                  className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-mono font-medium text-white flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50 shadow-sm"
                >
                  <Zap className={`w-3.5 h-3.5 ${loadingAll ? 'animate-spin text-white' : 'text-white/75'}`} />
                  <span>{loadingAll ? 'FETCHING ALL ITEMS…' : 'LOAD ALL STORE ITEMS'}</span>
                </button>
              </div>
            )}
            </div>

            <aside
              onDragOver={(event) => { event.preventDefault(); setIsDragOverSelection(true); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragOverSelection(false); }}
              onDrop={(event) => { event.preventDefault(); dropDraggedItem(); }}
              className={`${isSelectionOpen ? 'fixed inset-y-0 right-0 z-[60] w-[min(22rem,92vw)] shadow-2xl' : 'hidden lg:flex w-72'} ${isDragOverSelection ? 'bg-white/[0.08] ring-1 ring-inset ring-white/40' : 'bg-neutral-950/95'} shrink-0 flex-col border-l border-white/[0.08] backdrop-blur-xl transition-colors`}
            >
              <div className="flex items-center justify-between gap-2 p-3 border-b border-white/[0.08]">
                <div><div className="text-xs uppercase tracking-[0.16em] font-mono text-white/45">Selected items</div><div className="text-[11px] font-mono text-white/80 mt-1">{selectedItems.length} selected · {selectedTotal.toLocaleString()} R$</div></div>
                <button type="button" onClick={() => setIsSelectionOpen(false)} className="lg:hidden p-2 rounded-lg bg-white/[0.05] text-white/60" aria-label="Close selected items"><X className="w-4 h-4" /></button>
              </div>
              <div className="flex items-center gap-2 p-3 border-b border-white/[0.06]">
                <button type="button" onClick={() => setSelectionMode((value) => !value)} className={`flex-1 rounded-lg px-2 py-2 text-[11px] font-mono border transition-colors ${selectionMode ? 'bg-white/15 border-white/30 text-white' : 'bg-white/[0.04] border-white/10 text-white/60'}`} aria-pressed={selectionMode} title="Enable dragging catalog items into this panel">{selectionMode ? 'DRAG MODE ON' : 'DRAG MODE'}</button>
                <button type="button" onClick={() => { setLastSelection(selectedItems); setSelectedItems([]); }} disabled={!selectedItems.length} className="p-2 rounded-lg border border-white/10 text-white/45 hover:text-rose-300 disabled:opacity-30" aria-label="Clear selected items"><Trash2 className="w-3.5 h-3.5" /></button>
                <button type="button" onClick={() => { if (lastSelection) { setSelectedItems(lastSelection); setLastSelection(null); } }} disabled={!lastSelection} className="p-2 rounded-lg border border-white/10 text-white/45 hover:text-white disabled:opacity-30" aria-label="Undo last selection"><Undo2 className="w-3.5 h-3.5" /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 fancy-scroll">
                {selectedItems.length === 0 ? <div className="flex h-full flex-col items-center justify-center text-center p-6"><ListFilter className="w-8 h-8 text-white/15 mb-3" /><p className="text-xs font-mono text-white/40">Click an item or drag it here.</p></div> : selectedItems.map((item) => <div key={item.id} className="flex items-center gap-2 p-2 rounded-xl hover:bg-white/[0.05]"><div className="w-10 h-10 rounded-lg bg-black/40 overflow-hidden shrink-0">{item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" className="w-full h-full object-contain" />}</div><div className="min-w-0 flex-1"><div className="truncate text-xs text-white/85">{item.name}</div><div className={`text-[10px] font-mono ${item.isForSale ? 'text-emerald-300/70' : 'text-amber-300/70'}`}>{item.isFree ? 'FREE' : item.isForSale && item.price !== null ? `${item.price.toLocaleString()} R$` : 'OFF-SALE'}</div></div><button type="button" onClick={() => updateSelection(selectedItems.filter((selected) => selected.id !== item.id))} className="p-1.5 text-white/30 hover:text-rose-300" aria-label={`Remove ${item.name}`}><X className="w-3.5 h-3.5" /></button></div>)}
              </div>
              <div className="p-3 border-t border-white/[0.08] space-y-2">
                <FilterMenu className="w-full" label="Copy format" value={copyFormat} options={[['comma', 'Comma separated'], ['space', 'Space separated'], ['newline', 'One per line']]} onChange={(value) => setCopyFormat(value as typeof copyFormat)} />
                <button type="button" onClick={copySelected} disabled={!selectedItems.length} className="w-full flex items-center justify-center gap-2 rounded-lg bg-white hover:bg-white/90 border border-white text-neutral-950 px-3 py-2.5 text-xs font-mono font-semibold disabled:opacity-30"><Copy className="w-3.5 h-3.5" /> Copy all IDs</button>
              </div>
            </aside>
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
  isSelected: boolean;
  isNew: boolean;
  selectionMode: boolean;
  onSelect: (shiftKey: boolean) => void;
  onDragStart: () => void;
}

const StoreItemCard: React.FC<StoreItemCardProps> = ({ item, isWishlisted, onToggleWishlist, isSelected, isNew, selectionMode, onSelect, onDragStart }) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  return (
    <div
      role="checkbox"
      aria-checked={isSelected}
      aria-label={`${isSelected ? 'Remove' : 'Add'} ${item.name} ${isSelected ? 'from' : 'to'} selected items`}
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, a')) return;
        onSelect(event.shiftKey);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect(false);
      }}
      draggable={selectionMode}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/plain', String(item.id));
        onDragStart();
      }}
      className={`group relative flex flex-col justify-between rounded-xl sm:rounded-2xl p-2.5 sm:p-3 transition-all duration-200 shadow-sm h-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${isSelected ? 'bg-white/10 border-white/45' : 'bg-black/40 hover:bg-black/60 border-white/[0.07] hover:border-white/20'}`}
    >
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
        {isNew && <span className="px-1.5 py-0.5 rounded bg-white/10 border border-white/25 text-white/85 text-[9px] font-mono uppercase">New</span>}
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

interface FilterMenuProps {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
  icon?: React.ReactNode;
  className?: string;
}

const FilterMenu: React.FC<FilterMenuProps> = ({ label, value, options, onChange, icon, className = '' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedLabel = options.find(([optionValue]) => optionValue === value)?.[1] || label;

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menuHeight = Math.min(options.length * 40 + 8, 280);
    const menuWidth = Math.max(trigger.width, 176);
    const left = Math.min(Math.max(8, trigger.left), window.innerWidth - menuWidth - 8);
    const openAbove = window.innerHeight - trigger.bottom < menuHeight + 8 && trigger.top > menuHeight + 8;
    setMenuStyle({
      position: 'fixed',
      left,
      top: openAbove ? Math.max(8, trigger.top - menuHeight - 6) : trigger.bottom + 6,
      width: menuWidth,
      maxHeight: menuHeight,
      visibility: 'visible',
    });
  }, [isOpen, options.length]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsOpen(false); };
    const closeOnViewportChange = () => setIsOpen(false);
    document.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [isOpen]);

  return (
    <div className={`relative min-w-[9rem] shrink-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        className={`flex h-10 w-full items-center gap-2 rounded-xl border px-2.5 text-xs font-mono outline-none transition-colors ${isOpen ? 'border-white/45 bg-white/10 text-white ring-2 ring-white/10' : 'border-white/12 bg-neutral-950 text-white/80 hover:border-white/25 hover:text-white'}`}
      >
        <span className="shrink-0 text-white/45">{icon || <ListFilter className="h-3.5 w-3.5" />}</span>
        <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
        <ChevronLeft className={`h-3 w-3 shrink-0 -rotate-90 text-white/40 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>
      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          style={menuStyle}
          className="z-[100] overflow-y-auto rounded-xl border border-white/20 bg-neutral-950 p-1 shadow-[0_18px_48px_rgba(0,0,0,0.75)]"
        >
          {options.map(([optionValue, optionLabel]) => (
            <button
              key={optionValue}
              type="button"
              role="option"
              aria-selected={value === optionValue}
              onClick={() => { onChange(optionValue); setIsOpen(false); triggerRef.current?.focus(); }}
              className={`block min-h-10 w-full rounded-lg px-3 py-2 text-left text-xs font-mono transition-colors ${value === optionValue ? 'bg-white/15 text-white' : 'text-white/65 hover:bg-white/[0.07] hover:text-white'}`}
            >
              {optionLabel}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
};
