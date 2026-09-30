import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { RobloxAssetItem, RobloxGroupMembership } from '../types/roblox';
import { RobloxApiClient } from '../services/api';
import { useFavorites } from '../hooks/useFavorites';
import { useClipboard } from '../hooks/useClipboard';
import { useViewedGroups, ViewedGroupCategory } from '../hooks/useViewedGroups';
import { classifyGroupItem } from '../lib/groupStoreAnalysis';
import { GroupAnalysisSummary } from './GroupAnalysisSummary';
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
  Copy,
  ListFilter,
  Undo2,
  Trash2,
  RefreshCw,
  BadgeCheck,
  Package,
  ArrowUpDown,
  Zap,
  FolderPlus,
  Check,
} from 'lucide-react';

interface GroupStoreModalProps {
  isOpen: boolean;
  onClose: () => void;
  group: RobloxGroupMembership | { id: number; name: string; memberCount?: number; iconUrl?: string | null; hasVerifiedBadge?: boolean } | null;
  groups?: RobloxGroupMembership[];
  savedGroups?: RobloxGroupMembership[];
  onSaveGroup?: (group: RobloxGroupMembership) => void;
  onRemoveSavedGroup?: (groupId: number) => void;
}

type FilterCategory = 'all' | 'on_sale' | 'free' | 'off_sale';
type CatalogKind = 'all' | 'clothing' | 'items';
type SortOption = 'RecentlyCreated' | 'PriceAsc' | 'PriceDesc';
type PriceFilter = 'all' | 'free' | 'under100' | '100plus';

const SELECTED_ITEMS_KEY = 'wornby_store_selected_items_v1';
const STORE_VIEW_KEY = 'wornby_store_view_state_v1';
const EMPTY_GROUPS: RobloxGroupMembership[] = [];
// Roblox catalog cursors are tied to the page size that created them.
// Keep this value identical for the first and every following page.
// Roblox accepts up to 120 catalog items per page. Starting at the maximum
// makes most group stores arrive complete in one request while preserving a
// cursor-safe fallback for exceptionally large stores.
const GROUP_STORE_PAGE_SIZE = 120;

function loadStoredItems(): RobloxAssetItem[] {
  try {
    if (typeof window === 'undefined') return [];
    const stored = JSON.parse(localStorage.getItem(SELECTED_ITEMS_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter((item): item is RobloxAssetItem => Number.isSafeInteger(item?.id) && item.id > 0) : [];
  } catch { return []; }
}

function loadStoreView(): { filters: Record<string, { searchQuery: string; filterCategory: FilterCategory; catalogKind?: CatalogKind; priceFilter: PriceFilter; assetType: string; scrollTop: number }> } {
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
  groups = EMPTY_GROUPS,
  savedGroups = EMPTY_GROUPS,
  onSaveGroup,
  onRemoveSavedGroup,
}) => {
  const { viewedGroups, recordViewedGroup, updateCatalogSummary } = useViewedGroups();
  const [activeGroup, setActiveGroup] = useState<typeof group>(group);
  const [groupListSource, setGroupListSource] = useState<'player' | 'saved' | 'viewed'>('player');
  const [items, setItems] = useState<RobloxAssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [retryingImages, setRetryingImages] = useState(false);
  const [failedImageIds, setFailedImageIds] = useState<Set<number>>(new Set());
  const [imageRetryKey, setImageRetryKey] = useState(0);
  const [hasError, setHasError] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<FilterCategory>('all');
  const [catalogKind, setCatalogKind] = useState<CatalogKind>('all');
  const [sortOption, setSortOption] = useState<SortOption>('RecentlyCreated');
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('all');
  const [assetType, setAssetType] = useState('all');
  const [selectedItems, setSelectedItems] = useState<RobloxAssetItem[]>(loadStoredItems);
  const [selectionMode, setSelectionMode] = useState(false);
  const [isSelectionOpen, setIsSelectionOpen] = useState(false);
  const [isGroupsOpen, setIsGroupsOpen] = useState(false);
  const [copyFormat, setCopyFormat] = useState<'comma' | 'space' | 'newline'>('comma');
  const [lastSelection, setLastSelection] = useState<RobloxAssetItem[] | null>(null);
  const [groupQuery, setGroupQuery] = useState('');
  const [groupTypeFilter, setGroupTypeFilter] = useState<'all' | ViewedGroupCategory>('all');
  const [newItemIds, setNewItemIds] = useState<Set<number>>(new Set());
  const [isDragOverSelection, setIsDragOverSelection] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<number, number>>({});
  const pendingScrollRestoreRef = useRef<{ groupId: number; top: number } | null>(null);
  const storeView = useRef(loadStoreView());
  const seenBaselinesRef = useRef<Record<number, Set<number>>>({});
  const scrollPersistTimerRef = useRef<number | null>(null);
  const requestGenerationRef = useRef(0);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const paginationInFlightRef = useRef(false);
  const draggedItemRef = useRef<RobloxAssetItem | null>(null);
  const autoLoadRequestRef = useRef('');
  const itemsRef = useRef<RobloxAssetItem[]>([]);
  const manualGroupSelectionRef = useRef(false);

  const { isFavorite, toggleFavorite } = useFavorites();
  const { copied, copy } = useClipboard();

  const hydrateThumbnails = useCallback(async (
    sourceItems: RobloxAssetItem[],
    generation: number
  ) => {
    let missingIds = Array.from(new Set(sourceItems.filter((item) => !item.thumbnailUrl).map((item) => item.id)));
    if (missingIds.length === 0) return;
    const signal = catalogAbortRef.current?.signal;
    for (let attempt = 0; attempt < 3 && missingIds.length > 0; attempt++) {
      if (generation !== requestGenerationRef.current || signal?.aborted) return;
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      if (generation !== requestGenerationRef.current || signal?.aborted) return;
      const chunks: number[][] = [];
      for (let index = 0; index < missingIds.length; index += 120) chunks.push(missingIds.slice(index, index + 120));
      const results = await Promise.allSettled(chunks.map((chunk) => RobloxApiClient.fetchAssetThumbnails(chunk, signal)));
      if (generation !== requestGenerationRef.current || signal?.aborted) return;
      const thumbnails = Object.assign({}, ...results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])) as Record<number, string>;
      if (Object.keys(thumbnails).length > 0) {
        itemsRef.current = itemsRef.current.map((item) => thumbnails[item.id] ? { ...item, thumbnailUrl: thumbnails[item.id] } : item);
        setItems(itemsRef.current);
      }
      missingIds = missingIds.filter((id) => !thumbnails[id]);
    }
  }, []);

  const fetchItems = useCallback(
    async (isInitial = true, cursor = '') => {
      if (!activeGroup) return;
      if (!isInitial && paginationInFlightRef.current) return;
      const generation = isInitial ? ++requestGenerationRef.current : requestGenerationRef.current;
      if (isInitial) {
        catalogAbortRef.current?.abort();
        catalogAbortRef.current = new AbortController();
      }
      if (!isInitial) paginationInFlightRef.current = true;
      if (isInitial) {
        setLoading(true);
        setHasError(false);
      } else {
        setLoadingMore(true);
      }

      try {
        const sortOrder = sortOption === 'PriceAsc' ? 'Asc' : 'Desc';
        const res = await RobloxApiClient.fetchGroupStore(
          activeGroup.id,
          cursor,
          GROUP_STORE_PAGE_SIZE,
          sortOption,
          sortOrder,
          catalogAbortRef.current?.signal,
          true
        );
        if (generation !== requestGenerationRef.current) return;
        if (isInitial) {
          itemsRef.current = res.items;
          setItems(res.items);
        } else {
          const existingIds = new Set(itemsRef.current.map((item) => item.id));
          const mergedItems = [...itemsRef.current, ...res.items.filter((item) => !existingIds.has(item.id))];
          itemsRef.current = mergedItems;
          setItems(mergedItems);
        }
        setNextCursor(res.nextPageCursor);
        updateCatalogSummary(activeGroup.id, itemsRef.current, !res.nextPageCursor);
        setHasError(false);
        void hydrateThumbnails(res.items, generation);
      } catch {
        if (generation !== requestGenerationRef.current) return;
        if (catalogAbortRef.current?.signal.aborted) return;
        toast.error('Failed to load group catalog items');
        if (isInitial) {
          setHasError(true);
        }
      } finally {
        if (generation === requestGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
        if (generation === requestGenerationRef.current) paginationInFlightRef.current = false;
      }
    },
    [activeGroup, hydrateThumbnails, sortOption, updateCatalogSummary]
  );

  const loadAllRemaining = useCallback(async (silent = false) => {
    if (!activeGroup || !nextCursor || loadingAll || loadingMore) return;
    setLoadingAll(true);
    const generation = requestGenerationRef.current;
    const signal = catalogAbortRef.current?.signal;
    let cur: string | null = nextCursor;
    const requestedCursors = new Set<string>();
    let failed = false;
    try {
      const sortOrder = sortOption === 'PriceAsc' ? 'Asc' : 'Desc';
      while (cur) {
        if (requestedCursors.has(cur)) throw new Error('Catalog repeated a page cursor');
        requestedCursors.add(cur);
        let res: Awaited<ReturnType<typeof RobloxApiClient.fetchGroupStore>> | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            res = await RobloxApiClient.fetchGroupStore(
              activeGroup.id,
              cur,
              GROUP_STORE_PAGE_SIZE,
              sortOption,
              sortOrder,
              signal,
              true
            );
            break;
          } catch (error) {
            if (attempt === 1 || signal?.aborted || generation !== requestGenerationRef.current) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (!res) throw new Error('Catalog page unavailable');
        if (generation !== requestGenerationRef.current) return;
        const existingIds = new Set(itemsRef.current.map((item) => item.id));
        const newItems = res.items.filter((item) => !existingIds.has(item.id));
        itemsRef.current = [...itemsRef.current, ...newItems];
        setItems(itemsRef.current);
        cur = res.nextPageCursor;
        setNextCursor(cur);
        updateCatalogSummary(activeGroup.id, itemsRef.current, !cur);
        if (newItems.length > 0) void hydrateThumbnails(newItems, generation);
        if (!cur) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch {
      failed = true;
    } finally {
      if (generation === requestGenerationRef.current) {
        setNextCursor(cur);
        if (!signal?.aborted) setHasError(failed);
      }
      if (generation === requestGenerationRef.current) setLoadingAll(false);
      if (!silent && generation === requestGenerationRef.current && !signal?.aborted) {
        if (failed) toast.error('Partially loaded; click again to continue fetching.');
        else toast.success('Loaded all items from group catalog!');
      }
    }
  }, [activeGroup, hydrateThumbnails, loadingAll, loadingMore, nextCursor, sortOption, updateCatalogSummary]);

  useEffect(() => {
    if (!isOpen) {
      manualGroupSelectionRef.current = false;
      requestGenerationRef.current++;
      catalogAbortRef.current?.abort();
      return;
    }
    if (activeGroup && (activeGroup.id === group?.id || manualGroupSelectionRef.current)) {
      autoLoadRequestRef.current = '';
      requestGenerationRef.current++;
      catalogAbortRef.current?.abort();
      itemsRef.current = [];
      paginationInFlightRef.current = false;
      setLoadingAll(false);
      setLoadingMore(false);
      setFailedImageIds(new Set());
      setItems([]);
      setNextCursor(null);
      setHasError(false);
      fetchItems(true, '');
    }
  }, [isOpen, activeGroup?.id, sortOption]);

  useEffect(() => {
    if (!isOpen || !activeGroup || !nextCursor || loading || loadingAll || loadingMore) return;
    const requestKey = `${activeGroup.id}:${sortOption}:${nextCursor}`;
    if (autoLoadRequestRef.current === requestKey) return;
    autoLoadRequestRef.current = requestKey;
    void loadAllRemaining(true);
  }, [activeGroup?.id, isOpen, items.length, loadAllRemaining, loading, loadingAll, loadingMore, nextCursor, sortOption]);

  useEffect(() => {
    if (isOpen && group) {
      setActiveGroup(group);
      const belongsToPlayer = groups.some((candidate) => candidate.id === group.id);
      const belongsToSaved = savedGroups.some((candidate) => candidate.id === group.id);
      setGroupListSource(belongsToPlayer ? 'player' : belongsToSaved ? 'saved' : 'viewed');
    }
  }, [isOpen, group, groups, savedGroups]);

  useEffect(() => {
    if (isOpen && activeGroup && (activeGroup.id === group?.id || manualGroupSelectionRef.current)) recordViewedGroup(activeGroup);
  }, [isOpen, activeGroup?.id, recordViewedGroup]);

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

  const catalogCounts = useMemo(() => items.reduce((counts, item) => {
    const kind = classifyGroupItem(item).kind;
    if (kind === 'clothing' || kind === 'items') counts[kind]++;
    return counts;
  }, { clothing: 0, items: 0 }), [items]);
  const kindItems = useMemo(() => catalogKind === 'all'
    ? items
    : items.filter((item) => classifyGroupItem(item).kind === catalogKind), [items, catalogKind]);

  const filteredItems = useMemo(() => {
    return kindItems.filter((item) => {
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
  }, [kindItems, filterCategory, searchQuery, assetType, priceFilter]);

  const assetTypes = useMemo(() => Array.from(new Set(kindItems.map((item) => item.assetTypeName).filter(Boolean))) as string[], [kindItems]);
  const missingImageCount = useMemo(() => items.filter((item) => !item.thumbnailUrl || failedImageIds.has(item.id)).length, [items, failedImageIds]);
  const retryMissingImages = async () => {
    if (retryingImages) return;
    setRetryingImages(true);
    setImageRetryKey((current) => current + 1);
    try {
      await hydrateThumbnails(itemsRef.current.filter((item) => !item.thumbnailUrl || failedImageIds.has(item.id)).map((item) => ({ ...item, thumbnailUrl: null })), requestGenerationRef.current);
    } finally {
      setRetryingImages(false);
    }
  };
  const sourceGroups = groupListSource === 'saved' ? savedGroups : groupListSource === 'viewed' ? viewedGroups : groups;
  const viewedGroupsById = useMemo(() => new Map(viewedGroups.map((entry) => [entry.id, entry])), [viewedGroups]);
  const filteredGroups = useMemo(() => sourceGroups.filter((storeGroup) => {
    const category = viewedGroupsById.get(storeGroup.id)?.category || 'unknown';
    return (groupTypeFilter === 'all' || category === groupTypeFilter)
      && storeGroup.name.toLowerCase().includes(groupQuery.toLowerCase().trim());
  }), [sourceGroups, viewedGroupsById, groupQuery, groupTypeFilter]);
  const visibleGroupCount = filteredGroups.length;
  const playerStoreCount = groups.length;
  const savedStoreCount = savedGroups.length;
  const viewedStoreCount = viewedGroups.length;
  const savedGroupIds = useMemo(() => new Set(savedGroups.map((storeGroup) => storeGroup.id)), [savedGroups]);
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
    if (!activeGroup || !isOpen) return;
    const saved = storeView.current.filters[activeGroup.id];
    if (saved) {
      setSearchQuery(saved.searchQuery);
      setFilterCategory(saved.filterCategory);
      setCatalogKind(saved.catalogKind || 'all');
      setPriceFilter(saved.priceFilter);
      setAssetType(saved.assetType);
      scrollPositions.current[activeGroup.id] = Number.isFinite(saved.scrollTop) ? saved.scrollTop : 0;
    } else {
      setSearchQuery('');
      setFilterCategory('all');
      setCatalogKind('all');
      setPriceFilter('all');
      setAssetType('all');
      scrollPositions.current[activeGroup.id] = 0;
    }
    pendingScrollRestoreRef.current = {
      groupId: activeGroup.id,
      top: scrollPositions.current[activeGroup.id] || 0,
    };
  }, [activeGroup?.id, isOpen]);

  useEffect(() => {
    if (!activeGroup) return;
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
    storeView.current.filters[activeGroup.id] = { searchQuery, filterCategory, catalogKind, priceFilter, assetType, scrollTop: scrollPositions.current[activeGroup.id] || 0 };
    try { localStorage.setItem(STORE_VIEW_KEY, JSON.stringify(storeView.current)); } catch {}
  }, [activeGroup?.id, isOpen, searchQuery, filterCategory, catalogKind, priceFilter, assetType]);

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

  const copySelectedItemId = async (item: RobloxAssetItem) => {
    const copiedId = await copy(String(item.id), `selected-item-${item.id}`);
    if (copiedId) toast.success('Asset ID copied', { description: String(item.id) });
    else toast.error('Could not copy asset ID');
  };

  const saveGroupFromStore = (storeGroup: RobloxGroupMembership) => {
    if (!onSaveGroup || savedGroupIds.has(storeGroup.id)) return;
    onSaveGroup(storeGroup);
    toast.success('Group saved', { description: `${storeGroup.name} added to Saved stores` });
  };

  const removeGroupFromSaved = (storeGroup: RobloxGroupMembership) => {
    if (!onRemoveSavedGroup) return;
    onRemoveSavedGroup(storeGroup.id);
    toast.success('Group removed', { description: `${storeGroup.name} removed from Saved stores` });
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

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    const element = scrollRef.current;
    if (!pending || !element || !activeGroup || pending.groupId !== activeGroup.id || items.length === 0) return;
    element.scrollTop = Math.min(pending.top, Math.max(0, element.scrollHeight - element.clientHeight));
    pendingScrollRestoreRef.current = null;
  }, [activeGroup?.id, items.length === 0]);

  const onSaleCount = useMemo(() => kindItems.filter((i) => i.isForSale && !i.isFree).length, [kindItems]);
  const freeCount = useMemo(() => kindItems.filter((i) => i.isFree).length, [kindItems]);
  const offSaleCount = useMemo(() => kindItems.filter((i) => !i.isForSale).length, [kindItems]);

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
                <div className="mt-1.5 flex items-center gap-2">
                  <GroupAnalysisSummary group={viewedGroupsById.get(currentGroup.id)} analyzing={loading || loadingAll || loadingMore} compact />
                  {hasError && nextCursor && !loading && !loadingAll && !loadingMore && (
                    <button type="button" onClick={() => void loadAllRemaining(false)} className="shrink-0 rounded-md border border-white/15 px-1.5 py-0.5 font-mono text-[10px] text-white/70 hover:border-white/30 hover:text-white">Retry analysis</button>
                  )}
                  {!nextCursor && (viewedGroupsById.get(currentGroup.id)?.unknownCount || 0) > 0 && !loading && !loadingAll && !loadingMore && (
                    <button type="button" onClick={() => void fetchItems(true, '')} className="shrink-0 rounded-md border border-white/15 px-1.5 py-0.5 font-mono text-[10px] text-white/70 hover:border-white/30 hover:text-white">Retry analysis</button>
                  )}
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

            <div role="group" aria-label="Catalog type" className="grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
              {([
                ['all', 'All items', items.length],
                ['clothing', 'Clothing', catalogCounts.clothing],
                ['items', 'Items', catalogCounts.items],
              ] as const).map(([kind, label, count]) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={catalogKind === kind}
                  onClick={() => { setCatalogKind(kind); setAssetType('all'); }}
                  className={`flex h-9 min-w-0 items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 sm:text-xs ${catalogKind === kind ? 'bg-white text-neutral-950' : 'text-white/65 hover:bg-white/[0.08] hover:text-white'}`}
                >
                  <span className="truncate">{label}</span>
                  <span className={`tabular-nums ${catalogKind === kind ? 'text-neutral-500' : 'text-white/40'}`}>{count}</span>
                </button>
              ))}
            </div>

            {/* Filter Pills & Sort Row */}
            <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1 no-scrollbar lg:col-span-2 lg:pb-0">
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
                  <span className="text-[10px] opacity-60">({kindItems.length})</span>
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
              <FilterMenu label="Asset type" value={assetType} options={[['all', 'All types'], ...assetTypes.map((type) => [type, type] as [string, string])]} onChange={setAssetType} />
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
                  <span className="text-[10px] uppercase tracking-[0.18em] font-mono text-white/35">Group stores</span>
                  <span className="flex items-center gap-2"><span className="text-[10px] font-mono text-white/40">{visibleGroupCount} stores</span><button type="button" onClick={() => setIsGroupsOpen(false)} className="md:hidden text-white/40 hover:text-white" aria-label="Close groups"><X className="w-4 h-4" /></button></span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-white/[0.035] p-1 ring-1 ring-inset ring-white/[0.07]">
                  <button
                    type="button"
                    onClick={() => setGroupListSource('player')}
                    className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[10px] font-mono transition-colors ${groupListSource === 'player' ? 'bg-white text-black' : 'text-white/50 hover:bg-white/[0.06] hover:text-white'}`}
                  >
                    <span className="truncate">Player</span>
                    <span className="tabular-nums opacity-60">{playerStoreCount}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupListSource('saved')}
                    className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[10px] font-mono transition-colors ${groupListSource === 'saved' ? 'bg-white text-black' : 'text-white/50 hover:bg-white/[0.06] hover:text-white'}`}
                  >
                    <span className="truncate">Saved</span>
                    <span className="tabular-nums opacity-60">{savedStoreCount}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupListSource('viewed')}
                    className={`flex min-w-0 items-center justify-center gap-1 rounded-lg px-1 py-2 text-[10px] font-mono transition-colors ${groupListSource === 'viewed' ? 'bg-white text-black' : 'text-white/50 hover:bg-white/[0.06] hover:text-white'}`}
                  >
                    <span className="truncate">Viewed</span>
                    <span className="tabular-nums opacity-60">{viewedStoreCount}</span>
                  </button>
                </div>
                <div className="relative mt-2"><Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" /><input value={groupQuery} onChange={(event) => setGroupQuery(event.target.value)} placeholder="Find a group..." className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2 pl-8 pr-2 text-[11px] font-mono text-white placeholder:text-white/35 focus:border-white/35 focus:outline-none" /></div>
                <select aria-label="Filter group stores" value={groupTypeFilter} onChange={(event) => setGroupTypeFilter(event.target.value as 'all' | ViewedGroupCategory)} className="mt-2 w-full rounded-lg border border-white/10 bg-neutral-900 px-2.5 py-2 text-[11px] font-mono text-white focus:border-white/35 focus:outline-none">
                  <option value="all">All groups</option>
                  <option value="clothing">Clothing</option>
                  <option value="items">Items</option>
                  <option value="mixed">Mixed</option>
                  <option value="empty">Empty</option>
                  <option value="unknown">To check</option>
                </select>
              </div>
              <div className="flex-1 overflow-y-auto p-2 fancy-scroll">
                {filteredGroups.map((storeGroup) => {
                  const isSavedGroup = savedGroupIds.has(storeGroup.id);
                  return (
                    <div key={storeGroup.id} className={`mb-1 flex items-center rounded-xl transition-colors ${storeGroup.id === activeGroup.id ? 'bg-cyan-500/15 border border-cyan-400/60 text-white' : 'border border-transparent text-white/60 hover:bg-white/[0.05] hover:text-white'}`}>
                      <button
                        type="button"
                        aria-current={storeGroup.id === activeGroup.id ? 'true' : undefined}
                        onClick={() => { if (storeGroup.id === activeGroup.id) void fetchItems(true, ''); else { catalogAbortRef.current?.abort(); requestGenerationRef.current++; manualGroupSelectionRef.current = true; setActiveGroup(storeGroup); } localStorage.setItem('wornby_last_store_group', String(storeGroup.id)); setIsGroupsOpen(false); }}
                        className="flex min-w-0 flex-1 items-center gap-2.5 p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50"
                      >
                        {storeGroup.iconUrl ? <img src={storeGroup.iconUrl} alt="" className="w-8 h-8 rounded-lg object-cover bg-black/40" /> : <div className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center"><Store className="w-3.5 h-3.5 text-white/35" /></div>}
                        <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{storeGroup.name}</span><GroupAnalysisSummary group={viewedGroupsById.get(storeGroup.id)} analyzing={storeGroup.id === activeGroup.id && (loading || loadingAll || loadingMore)} compact /></span>
                        {storeGroup.id === activeGroup.id && <span className="shrink-0 text-[9px] font-mono font-bold uppercase tracking-wide text-cyan-300">Viewing</span>}
                      </button>
                      {groupListSource === 'player' && onSaveGroup && (
                        <Tooltip content={<TooltipMono label={isSavedGroup ? 'Saved group' : 'Save group'} hint={isSavedGroup ? 'Already in Saved stores' : 'Add to Saved stores'} />} side="right">
                          <button
                            type="button"
                            onClick={() => saveGroupFromStore(storeGroup as RobloxGroupMembership)}
                            disabled={isSavedGroup}
                            aria-label={isSavedGroup ? `${storeGroup.name} is saved` : `Save ${storeGroup.name}`}
                            className={`mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${isSavedGroup ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-white/10 bg-white/[0.04] text-white/45 hover:border-white/25 hover:text-white'}`}
                          >
                            {isSavedGroup ? <Check className="h-3.5 w-3.5" /> : <FolderPlus className="h-3.5 w-3.5" />}
                          </button>
                        </Tooltip>
                      )}
                      {groupListSource === 'saved' && onRemoveSavedGroup && (
                        <Tooltip content={<TooltipMono label="Remove group" hint="Remove from Saved stores" />} side="right">
                          <button
                            type="button"
                            onClick={() => removeGroupFromSaved(storeGroup as RobloxGroupMembership)}
                            aria-label={`Remove ${storeGroup.name} from saved groups`}
                            className="mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/35 transition-colors hover:border-rose-500/25 hover:bg-rose-500/10 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
                {filteredGroups.length === 0 && <div className="px-3 py-8 text-center text-[11px] font-mono text-white/40">{sourceGroups.length > 0 ? 'No groups match this filter.' : groupListSource === 'saved' ? 'No saved group stores yet.' : groupListSource === 'viewed' ? 'No viewed group stores yet.' : 'No player group stores found.'}</div>}
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
                    : kindItems.length === 0 && catalogKind !== 'all'
                      ? `No ${catalogKind === 'clothing' ? 'clothing' : 'other items'} found in this group.`
                    : 'This group does not have any items matching the selected filter.'}
                </p>
                {catalogKind !== 'all' && (
                  <button type="button" onClick={() => { setCatalogKind('all'); setAssetType('all'); }} className="mt-4 rounded-lg border border-white/20 px-3 py-2 text-xs text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">Show all items</button>
                )}
              </div>
            ) : (
              <>
              {missingImageCount > 0 && !loading && (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/55">
                  <span>{missingImageCount} image{missingImageCount === 1 ? '' : 's'} unavailable</span>
                  <button type="button" onClick={() => void retryMissingImages()} disabled={retryingImages} className="inline-flex shrink-0 items-center gap-1.5 text-white/80 hover:text-white disabled:opacity-50">
                    <RefreshCw className={`h-3.5 w-3.5 ${retryingImages ? 'animate-spin' : ''}`} />
                    Retry images
                  </button>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                {filteredItems.map((item) => {
                  const wishlisted = isFavorite(item.id);
                  return (
                    <StoreItemCard
                      key={`${item.id}:${imageRetryKey}`}
                      item={item}
                      onImageError={() => setFailedImageIds((current) => new Set(current).add(item.id))}
                      onImageLoad={() => setFailedImageIds((current) => {
                        if (!current.has(item.id)) return current;
                        const next = new Set(current);
                        next.delete(item.id);
                        return next;
                      })}
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
              </>
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
                  <span>{loadingMore ? 'LOADING NEXT…' : `LOAD NEXT ${GROUP_STORE_PAGE_SIZE} ITEMS`}</span>
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
                {selectedItems.length === 0 ? <div className="flex h-full flex-col items-center justify-center text-center p-6"><ListFilter className="w-8 h-8 text-white/15 mb-3" /><p className="text-xs font-mono text-white/40">Click an item or drag it here.</p></div> : selectedItems.map((item) => <div key={item.id} className="flex items-center gap-2 p-2 rounded-xl hover:bg-white/[0.05]"><div className="w-10 h-10 rounded-lg bg-black/40 overflow-hidden shrink-0">{item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" className="w-full h-full object-contain" />}</div><div className="min-w-0 flex-1"><div className="truncate text-xs text-white/85">{item.name}</div><div className="flex items-center gap-2 mt-0.5"><span className={`text-[10px] font-mono ${item.isForSale ? 'text-emerald-300/70' : 'text-amber-300/70'}`}>{item.isFree ? 'FREE' : item.isForSale && item.price !== null ? `${item.price.toLocaleString()} R$` : 'OFF-SALE'}</span><button type="button" onClick={() => void copySelectedItemId(item)} className="flex min-w-0 items-center gap-1 text-[10px] font-mono text-white/35 hover:text-white" aria-label={`Copy asset ID ${item.id}`}>{copied === `selected-item-${item.id}` ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}<span className="truncate">#{item.id}</span></button></div></div><button type="button" onClick={() => updateSelection(selectedItems.filter((selected) => selected.id !== item.id))} className="p-1.5 text-white/30 hover:text-rose-300" aria-label={`Remove ${item.name}`}><X className="w-3.5 h-3.5" /></button></div>)}
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
  onImageError: () => void;
  onImageLoad: () => void;
  isWishlisted: boolean;
  onToggleWishlist: () => void;
  isSelected: boolean;
  isNew: boolean;
  selectionMode: boolean;
  onSelect: (shiftKey: boolean) => void;
  onDragStart: () => void;
}

const StoreItemCard: React.FC<StoreItemCardProps> = ({ item, onImageError, onImageLoad, isWishlisted, onToggleWishlist, isSelected, isNew, selectionMode, onSelect, onDragStart }) => {
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

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
        {item.thumbnailUrl && failedImageUrl !== item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt={item.name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onLoad={() => { setLoadedImageUrl(item.thumbnailUrl); onImageLoad(); }}
            onError={() => { setFailedImageUrl(item.thumbnailUrl); onImageError(); }}
            className={`w-full h-full object-contain filter drop-shadow-[0_4px_10px_rgba(0,0,0,0.5)] transition-all duration-300 transform group-hover:scale-105 ${
              loadedImageUrl === item.thumbnailUrl ? 'opacity-100' : 'opacity-0'
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
        showStudioCommand={false}
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
    const menuHeight = Math.min(options.length * 40 + 12, 280);
    const menuWidth = Math.max(trigger.width, 176);
    const left = Math.min(Math.max(8, trigger.left), window.innerWidth - menuWidth - 8);
    const openAbove = window.innerHeight - trigger.bottom < menuHeight + 8 && trigger.top > menuHeight + 8;
    setMenuStyle({
      position: 'fixed',
      left,
      top: openAbove ? Math.max(8, trigger.top - menuHeight - 6) : trigger.bottom + 6,
      width: menuWidth,
      maxHeight: options.length > 6 ? menuHeight : undefined,
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
    const closeOnResize = () => setIsOpen(false);
    document.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnResize);
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
          className={`z-[100] rounded-xl border border-white/20 bg-neutral-950 p-1 shadow-[0_18px_48px_rgba(0,0,0,0.75)] ${options.length > 6 ? 'overflow-y-auto' : 'overflow-visible'}`}
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
