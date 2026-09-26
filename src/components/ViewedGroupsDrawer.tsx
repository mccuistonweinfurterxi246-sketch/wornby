import React, { useEffect, useMemo, useState } from 'react';
import { Search, Store, X } from 'lucide-react';
import { GroupStoreModal } from './GroupStoreModal';
import { GroupAnalysisSummary } from './GroupAnalysisSummary';
import { ViewedGroup, ViewedGroupCategory, useViewedGroups } from '../hooks/useViewedGroups';

const FILTERS: { value: 'all' | ViewedGroupCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'clothing', label: 'Clothing' },
  { value: 'items', label: 'Items' },
  { value: 'mixed', label: 'Mixed' },
  { value: 'empty', label: 'Empty' },
  { value: 'unknown', label: 'To check' },
];

export const ViewedGroupsDrawer: React.FC = () => {
  const { viewedGroups } = useViewedGroups();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<ViewedGroup | null>(null);
  const [filter, setFilter] = useState<'all' | ViewedGroupCategory>('all');
  const [query, setQuery] = useState('');

  const filteredGroups = useMemo(() => viewedGroups.filter((group) =>
    (filter === 'all' || group.category === filter) && group.name.toLowerCase().includes(query.trim().toLowerCase())
  ), [viewedGroups, filter, query]);

  useEffect(() => {
    if (!isOpen) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsOpen(false); };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [isOpen]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={`Viewed group stores (${viewedGroups.length})`}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-xl border border-white/20 bg-neutral-950/95 px-4 py-3 text-xs font-mono font-semibold text-white shadow-[0_12px_36px_rgba(0,0,0,0.5)] transition-colors hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 sm:bottom-6 sm:right-6"
      >
        <Store className="h-4 w-4 text-cyan-300" />
        <span>VIEWED STORES</span>
        <span className="rounded-md bg-white/10 px-1.5 py-0.5 tabular-nums text-white/70">{viewedGroups.length}</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[70] flex justify-end">
          <button type="button" className="absolute inset-0 bg-black/75" onClick={() => setIsOpen(false)} aria-label="Close viewed stores" />
          <aside role="dialog" aria-modal="true" aria-label="Viewed group stores" className="relative flex h-full w-full max-w-md flex-col border-l border-white/10 bg-neutral-950 shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-white/10 p-5">
              <div>
                <h2 className="text-xl font-semibold text-white">Viewed stores</h2>
                <p className="mt-1 text-xs text-white/55">Every group you opened, across players and visits.</p>
              </div>
              <button type="button" onClick={() => setIsOpen(false)} aria-label="Close viewed stores" className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3 border-b border-white/10 p-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a viewed group" aria-label="Find a viewed group" className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.04] pl-9 pr-3 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none" />
              </div>
              <div className="flex flex-wrap gap-1.5" aria-label="Filter viewed stores">
                {FILTERS.map((option) => (
                  <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)} className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${filter === option.value ? 'border-white/30 bg-white/15 text-white' : 'border-white/10 text-white/55 hover:text-white'}`}>{option.label}</button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 fancy-scroll">
              {filteredGroups.map((group) => (
                <button key={group.id} type="button" onClick={() => { setSelectedGroup(group); setIsOpen(false); }} className="mb-1 flex w-full items-center gap-3 rounded-xl border border-transparent p-2.5 text-left transition-colors hover:border-white/10 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                  {group.iconUrl ? <img src={group.iconUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.06]"><Store className="h-4 w-4 text-white/45" /></span>}
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-white">{group.name}</span><span className="mt-1 block"><GroupAnalysisSummary group={group} /></span></span>
                </button>
              ))}
              {filteredGroups.length === 0 && <p className="px-4 py-12 text-center text-sm text-white/50">{viewedGroups.length === 0 ? 'Open a group store to start your history.' : 'No groups match this filter.'}</p>}
            </div>
          </aside>
        </div>
      )}

      <GroupStoreModal isOpen={!!selectedGroup} group={selectedGroup} onClose={() => setSelectedGroup(null)} />
    </>
  );
};
