import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { RobloxUserProfileFull, RobloxGroupMembership } from '../types/roblox';
import { AssetCard } from './AssetCard';
import { GroupCard } from './GroupCard';
import { TiltCard } from './TiltCard';
import { Card, CardContent } from './ui/card';
import Balatro from './ui/Balatro';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { toast } from 'sonner';
import { AudioHaptics } from './AudioHaptics';
import { FALLBACK_AVATAR_SVG } from '../lib/fallbacks';
import {
  Search,
  ArrowLeft,
  Calendar,
  Layers,
  Users,
  Tag,
  Copy,
  Check,
  BadgeCheck,
  RefreshCw,
  Share2,
  Flame,
  ExternalLink,
  ArrowDownNarrowWide,
  ArrowUpWideNarrow,
  Award,
  RotateCcw,
  Heart,
} from 'lucide-react';
import { useCopiedGroupsFolder } from '../hooks/useCopiedGroupsFolder';
import { CopiedGroupsFolder } from './CopiedGroupsFolder';
import { useFavorites } from '../hooks/useFavorites';
import { GroupStoreModal } from './GroupStoreModal';
import { FavoritesDrawer } from './FavoritesDrawer';

interface Stage2InspectorProps {
  data: RobloxUserProfileFull;
  onNewSearch: (query: string, fresh?: boolean) => void;
  onBackToHero: () => void;
  isLoading: boolean;
}

type GroupSortOption = 'default' | 'members_desc' | 'members_asc' | 'rank_desc';

export const Stage2Inspector: React.FC<Stage2InspectorProps> = ({
  data,
  onNewSearch,
  onBackToHero,
  isLoading,
}) => {
  const [activeTab, setActiveTab] = useState<'outfit' | 'groups'>('outfit');
  const [searchInput, setSearchInput] = useState('');
  const [copiedAction, setCopiedAction] = useState<string | null>(null);
  const [groupSort, setGroupSort] = useState<GroupSortOption>('default');

  // Modals state
  const [storeModalGroup, setStoreModalGroup] = useState<RobloxGroupMembership | { id: number; name: string; memberCount?: number; iconUrl?: string | null; hasVerifiedBadge?: boolean } | null>(null);
  const [isFavoritesOpen, setIsFavoritesOpen] = useState(false);
  const { favoritesCount } = useFavorites();

  // Persistent copied groups memory (Set backed by localStorage) — SSR-safe + Folder
  const [copiedGroupIds, setCopiedGroupIds] = useState<Set<number>>(() => {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return new Set<number>();
      const stored = localStorage.getItem('wornby_copied_groups');
      if (stored) {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) {
          return new Set<number>(arr);
        }
      }
    } catch {
      // ignore
    }
    return new Set<number>();
  });
  // Folder — полные данные скопированных групп с временем, источником и проверкой новинок
  const folder = useCopiedGroupsFolder();

  const { user, thumbnails, outfit, groups, telemetry } = data;

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchInput.trim() || isLoading) return;
    onNewSearch(searchInput.trim());
  };

  const copyTelemetryValue = async (text: string, actionKey: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      AudioHaptics.playCopyPunch();
      toast.success("Copied to clipboard", { description: `Value: ${text}` });
      setCopiedAction(actionKey);
      setTimeout(() => setCopiedAction(null), 2000);
    } catch {
      toast.error("Copy failed");
    }
  };

  const handleGroupCopy = (group: RobloxGroupMembership) => {
    setCopiedGroupIds((prev) => {
      const next = new Set(prev);
      next.add(group.id);
      try { if (typeof window !== 'undefined') localStorage.setItem('wornby_copied_groups', JSON.stringify(Array.from(next))); } catch { /* ignore */ }
      return next;
    });
    folder.add(group, { name: data.user.name, id: data.user.id });
  };

  const handleClearCopiedMemory = () => {
    AudioHaptics.playClearCache();
    setCopiedGroupIds(new Set());
    folder.clear();
    try { if (typeof window !== 'undefined') localStorage.removeItem('wornby_copied_groups'); } catch { /* ignore */ }
  };

  // Multi-criteria sorting for Communities
  const sortedGroups = useMemo(() => {
    const list = [...groups];
    if (groupSort === 'members_desc') {
      return list.sort((a, b) => b.memberCount - a.memberCount);
    }
    if (groupSort === 'members_asc') {
      return list.sort((a, b) => a.memberCount - b.memberCount);
    }
    if (groupSort === 'rank_desc') {
      return list.sort((a, b) => b.roleRank - a.roleRank);
    }
    return list;
  }, [groups, groupSort]);

  // для папки: быстрый lookup наличия группы у текущего игрока
  const currentGroupIds = useMemo(() => new Set(groups.map(g=>g.id)), [groups]);
  const currentGroupsById = useMemo(() => new Map(groups.map(g=>[g.id, { roleName: g.roleName, roleRank: g.roleRank }] as const)), [groups]);

  const formattedJoinDate = (() => {
    if (!user.created) return 'Unknown';
    const d = new Date(user.created);
    return isNaN(d.getTime()) ? 'Unknown' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  })();

  // Subtitle calculation for Outfit Value widget
  const getOutfitValueSubtitle = (): string => {
    const parts: string[] = [];
    if (outfit.offSaleCount > 0) {
      parts.push(`+ ${outfit.offSaleCount} OFF-SALE / UGC`);
    }
    if (outfit.freeCount > 0) {
      parts.push(`+ ${outfit.freeCount} FREE`);
    }
    if (parts.length === 0) {
      return 'PRICED ON CATALOG';
    }
    return parts.join(' ');
  };

  // High-End Editorial Bio Formatter (interactive links + quoted callouts)
  const renderFormattedBio = (text: string) => {
    const lines = text.split('\n');
    // non-global regexes to avoid lastIndex statefulness
    const urlSplitRegex = /(https?:\/\/[^\s]+)/;
    const urlTestRegex = /^https?:\/\/[^\s]+$/;
    return (
      <div className="space-y-2.5">
        {lines.map((line, lIdx) => {
          const trimmed = line.trim();
          if (!trimmed) return null;

          const isQuote = (trimmed.startsWith('"') && trimmed.length > 1 && trimmed.includes('"', 1)) || trimmed.startsWith('“') || trimmed.startsWith('«');

          const parts = line.split(urlSplitRegex);

          const content = parts.map((part, pIdx) => {
            if (urlTestRegex.test(part)) {
              let label = part;
              try {
                const parsed = new URL(part);
                label = parsed.hostname + (parsed.pathname.length > 20 ? parsed.pathname.substring(0, 20) + '...' : parsed.pathname);
              } catch {
                label = 'Link';
              }
              return (
                <a
                  key={pIdx}
                  href={part}
                  target="_blank"
                  rel="noopener noreferrer"
                  onMouseEnter={() => AudioHaptics.playHoverTick()}
                  className="inline-flex items-center gap-1 mx-1 px-2 py-0.5 rounded-md bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-mono transition-colors align-middle"
                >
                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate max-w-[240px]">{label}</span>
                </a>
              );
            }
            return <span key={pIdx}>{part}</span>;
          });

          if (isQuote) {
            return (
              <div key={lIdx} className="border-l-2 border-white/25 pl-3.5 py-0.5 italic text-white/85 text-xs sm:text-sm">
                {content}
              </div>
            );
          }

          return (
            <p key={lIdx} className="text-xs sm:text-sm font-light text-muted-foreground leading-relaxed break-words">
              {content}
            </p>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {/* Persistent Balatro Background for Stage 2 */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-[-1]" aria-hidden="true">
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
        {/* Darker Vignette for Stage 2 so content remains readable */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.3)_0%,rgba(0,0,0,0.85)_100%)]" />
      </div>

      <main className="relative min-h-screen w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12 flex flex-col gap-8">
        {/* Top Floating Control Bar */}
      <header className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              AudioHaptics.playTransitionSubtle();
              onBackToHero();
            }}
            className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-md hover:bg-white/[0.08] text-white/70 hover:text-white border border-white/[0.06] transition-all flex items-center gap-2 font-mono text-xs"
            title="Return to Hero Search"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">ORIGIN</span>
          </button>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/[0.03] backdrop-blur-md border border-white/[0.05] text-xs font-mono text-white/50">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>ROBLOX TELEMETRY STREAM</span>
            {telemetry.cached && (
              <span className="px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 text-[10px] border border-cyan-500/20">
                CACHED
              </span>
            )}
          </div>
        </div>

        {/* Quick Search Header Input & Wishlist Trigger */}
        <div className="flex items-center gap-2.5 flex-1 max-w-lg justify-end">
          <form onSubmit={handleSearchSubmit} className="flex-1 max-w-md">
            <div className="relative flex items-center">
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="inspect another user..."
                className="w-full bg-white/[0.04] backdrop-blur-md hover:bg-white/[0.06] focus:bg-black/80 focus:backdrop-blur-xl text-white placeholder:text-white/30 text-xs font-mono px-4 py-2.5 pr-20 rounded-xl border border-white/[0.06] focus:border-white/30 focus:outline-none transition-all shadow-inner"
              />
              <button
                type="submit"
                disabled={isLoading || !searchInput.trim()}
                className="absolute right-1 px-3 py-1.5 rounded-lg bg-white/10 backdrop-blur-md hover:bg-white/20 text-white text-xs font-mono transition-colors disabled:opacity-30 flex items-center gap-1 shadow-sm"
              >
                {isLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                <span>FIND</span>
              </button>
            </div>
          </form>

          {/* Wishlist Header Trigger */}
          <button
            type="button"
            onClick={() => setIsFavoritesOpen(true)}
            className="p-2.5 px-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-300 text-xs font-mono font-medium flex items-center gap-2 transition-all active:scale-95 shadow-[0_0_15px_rgba(244,63,94,0.12)] shrink-0"
            title="Open Favorites & Wishlist"
          >
            <Heart className={`w-3.5 h-3.5 ${favoritesCount > 0 ? 'fill-rose-400 text-rose-400' : ''}`} />
            <span className="hidden sm:inline">WISHLIST</span>
            {favoritesCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-none">
                {favoritesCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Hero Telemetry Section: User Dossier & Avatar (Bento Redesign) */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left: 3D Avatar Render Showcase */}
        <div className="lg:col-span-4 flex flex-col">
          <TiltCard maxTilt={8} scale={1.01} className="h-full">
            <div className="w-full transition-all duration-300 rounded-2xl bg-black/40 backdrop-blur-xl border border-white/10 shadow-2xl h-full flex flex-col">
              <div className="p-5 flex-1 flex flex-col items-center justify-between relative overflow-hidden">
                {/* Background telemetry matrix */}
                <div className="absolute top-3 left-3 text-[10px] font-mono text-white/20 tracking-widest">
                  AVATAR_RENDER // 3D
                </div>
                <div className="absolute top-3 right-3 text-[10px] font-mono text-white/20 tracking-widest">
                  420x420 PNG
                </div>

                {/* Avatar Display */}
                <div className="relative w-full max-w-[280px] aspect-square flex items-center justify-center my-4">
                  <div className="absolute inset-0 bg-gradient-to-b from-transparent via-cyan-950/10 to-transparent rounded-full blur-2xl pointer-events-none" />
                  {thumbnails.fullBodyUrl ? (
                    <img
                      src={thumbnails.fullBodyUrl}
                      alt={user.name}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        e.currentTarget.src = FALLBACK_AVATAR_SVG;
                      }}
                      className="w-full h-full object-contain filter drop-shadow-[0_12px_24px_rgba(0,0,0,0.8)] z-10 transition-transform duration-500 hover:scale-105"
                    />
                  ) : (
                    <div className="w-32 h-32 rounded-full bg-white/[0.04] border border-white/[0.06] flex items-center justify-center text-white/30 font-mono text-sm">
                      NO 3D AVATAR
                    </div>
                  )}
                </div>

                {/* Avatar Action Buttons */}
                <div className="w-full grid grid-cols-2 gap-2 pt-4 border-t border-white/[0.06]">
                  <button
                    onClick={() => copyTelemetryValue(`https://www.roblox.com/users/${user.id}/profile`, 'profile_link')}
                    className="py-2 px-3 rounded-lg text-xs font-mono bg-white/[0.04] hover:bg-white/[0.08] text-white/80 hover:text-white border border-white/[0.05] transition-all flex items-center justify-center gap-1.5"
                  >
                    {copiedAction === 'profile_link' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Share2 className="w-3.5 h-3.5" />}
                    <span>{copiedAction === 'profile_link' ? 'COPIED LINK' : 'SHARE PROFILE'}</span>
                  </button>

                  <button
                    onClick={() => {
                      AudioHaptics.playRefresh();
                      onNewSearch(user.name, true);
                    }}
                    className="py-2 px-3 rounded-lg text-xs font-mono bg-white/[0.04] hover:bg-white/[0.08] text-white/80 hover:text-white border border-white/[0.05] transition-all flex items-center justify-center gap-1.5"
                    title="Force refresh data from Roblox"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>REFRESH</span>
                  </button>
                </div>
              </div>
            </div>
          </TiltCard>
        </div>

        {/* Right: User Dossier & Editorial Bento Station */}
        <div className="lg:col-span-8 flex flex-col">
          <div className="w-full transition-all duration-300 rounded-2xl bg-black/40 backdrop-blur-xl border border-white/10 shadow-2xl h-full">
            <div className="p-6 flex flex-col justify-between h-full space-y-6">
              {/* Top Row: Identity Header */}
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {thumbnails.headshotUrl && (
                      <div className="relative">
                        <img
                          src={thumbnails.headshotUrl}
                          alt={`Headshot of ${user.name}`}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            e.currentTarget.src = FALLBACK_AVATAR_SVG;
                          }}
                          className="w-13 h-13 rounded-xl bg-black/40 border border-white/[0.12] object-cover ring-2 ring-white/5 shadow-inner"
                        />
                        <div className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/10 pointer-events-none" />
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
                          {user.displayName}
                        </h1>
                        {user.hasVerifiedBadge && (
                          <BadgeCheck className="w-5 h-5 text-cyan-400 flex-shrink-0" />
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono text-white/40 mt-0.5">
                        <span>@{user.name}</span>
                        <span>•</span>
                        <span 
                          onClick={() => copyTelemetryValue(String(user.id), 'userid')}
                          className="cursor-pointer hover:text-white transition-colors flex items-center gap-1 bg-white/[0.03] hover:bg-white/[0.07] px-2 py-0.5 rounded-md border border-white/[0.04]"
                          title="Click to copy User ID"
                        >
                          ID: {user.id}
                          {copiedAction === 'userid' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-white/40" />}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Account Creation Date */}
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-xs font-mono text-white/70">
                    <Calendar className="w-3.5 h-3.5 text-white/40" />
                    <span>JOINED {formattedJoinDate.toUpperCase()}</span>
                  </div>
                </div>

                {/* Middle Section: Editorial Bio Card / Status */}
                {user.description ? (
                  <div className="w-full h-auto min-h-fit rounded-xl bg-muted/30 border border-border p-3.5 max-h-40 overflow-y-auto shadow-inner fancy-scroll overscroll-contain">
                    {renderFormattedBio(user.description)}
                  </div>
                ) : (
                  <div className="w-full rounded-xl bg-muted/30 border border-dashed border-border p-3.5 flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-white/40">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80 motion-safe:animate-pulse" />
                      <span>NO PUBLIC BIO PROVIDED // VERIFIED ACTIVE TELEMETRY</span>
                    </div>
                    <span className={`text-[10px] tracking-wider uppercase px-2 py-0.5 rounded border ${user.isBanned ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-white/[0.03] text-white/30 border-white/[0.04]'}`}>
                      {user.isBanned ? 'ACCOUNT BANNED' : 'ACCOUNT ACTIVE'}
                    </span>
                  </div>
                )}
              </div>

              {/* Bottom Metrics Bar (Unified 4-Col Grid) */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {/* Metric 1: Outfit Robux Valuation */}
                <Card className="bg-black/40 backdrop-blur-md border border-white/5 hover:border-white/20 transition-all duration-200">
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <div className="flex items-center justify-between text-white/50 text-xs font-mono mb-2">
                      <span className="tracking-wider">OUTFIT VALUE</span>
                      <span className="p-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <Tag className="w-3 h-3" />
                      </span>
                    </div>
                    <div className="text-xl sm:text-2xl font-bold font-mono text-foreground tracking-tight">
                      {outfit.totalValueRobux > 0 ? `${outfit.totalValueRobux.toLocaleString()} R$` : '0 R$'}
                    </div>
                    <span className="text-[10px] font-mono text-white/40 mt-1.5 truncate" title={getOutfitValueSubtitle()}>
                      {getOutfitValueSubtitle()}
                    </span>
                  </CardContent>
                </Card>

                {/* Metric 2: Equipped Assets */}
                <Card className="bg-black/40 backdrop-blur-md border border-white/5 hover:border-white/20 transition-all duration-200">
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <div className="flex items-center justify-between text-white/40 text-xs font-mono mb-2">
                      <span className="tracking-wider">ITEMS ON AVATAR</span>
                      <span className="p-1 rounded-md bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                        <Layers className="w-3 h-3" />
                      </span>
                    </div>
                    <div className="text-xl sm:text-2xl font-bold font-mono text-foreground tracking-tight">
                      {outfit.itemCount}
                    </div>
                    <span className="text-[10px] font-mono text-white/30 mt-1.5">
                      ACTIVE WEARABLES
                    </span>
                  </CardContent>
                </Card>

                {/* Metric 3: Groups Joined */}
                <Card className="bg-black/40 backdrop-blur-md border border-white/5 hover:border-white/20 transition-all duration-200">
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <div className="flex items-center justify-between text-white/40 text-xs font-mono mb-2">
                      <span className="tracking-wider">COMMUNITIES</span>
                      <span className="p-1 rounded-md bg-purple-500/10 text-purple-400 border border-purple-500/20">
                        <Users className="w-3 h-3" />
                      </span>
                    </div>
                    <div className="text-xl sm:text-2xl font-bold font-mono text-foreground tracking-tight">
                      {groups.length}
                    </div>
                    <span className="text-[10px] font-mono text-white/30 mt-1.5">
                      ROLES & RANKS
                    </span>
                  </CardContent>
                </Card>

                {/* Metric 4: API Response Time */}
                <Card className="bg-black/40 backdrop-blur-md border border-white/5 hover:border-white/20 transition-all duration-200">
                  <CardContent className="p-4 flex flex-col justify-between h-full">
                    <div className="flex items-center justify-between text-white/40 text-xs font-mono mb-2">
                      <span className="tracking-wider">TELEMETRY LATENCY</span>
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${telemetry.responseTimeMs < 50 ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-amber-400'} animate-pulse`} />
                        <Flame className="w-3 h-3 text-amber-400" />
                      </div>
                    </div>
                    <div className="text-xl sm:text-2xl font-bold font-mono text-foreground tracking-tight">
                      {telemetry.responseTimeMs}ms
                    </div>
                    <span className={`text-[10px] font-mono mt-1.5 ${telemetry.cached ? 'text-emerald-400' : 'text-cyan-400'}`}>
                      {telemetry.cached ? 'FAST LRU HIT' : 'LIVE DISPATCH'}
                    </span>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Tabs Navigation */}
      <Tabs value={activeTab} onValueChange={(val) => {
        AudioHaptics.playTabSelect();
        setActiveTab(val as 'outfit' | 'groups');
      }} className="w-full">
        <section className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-white/[0.08] pb-4 gap-4">
          <TabsList>
            <TabsTrigger value="outfit" className="flex items-center gap-2">
              <Layers className="w-3.5 h-3.5" />
              <span>OUTFIT ITEMS ({outfit.itemCount})</span>
            </TabsTrigger>
            <TabsTrigger value="groups" className="flex items-center gap-2">
              <Users className="w-3.5 h-3.5" />
              <span>COMMUNITIES ({groups.length})</span>
            </TabsTrigger>
          </TabsList>

          {outfit.offSaleCount > 0 && activeTab === 'outfit' && (
            <div className="flex items-center gap-1.5 text-xs font-mono text-amber-300 bg-amber-500/10 px-3 py-1 rounded-lg border border-amber-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
              <span>{outfit.offSaleCount} OFF-SALE / UGC ASSET{outfit.offSaleCount > 1 ? 'S' : ''} DETECTED</span>
            </div>
          )}
        </section>

        {/* Tab Content Display */}
        <TabsContent value="outfit">
          <section className="space-y-4">
            {outfit.items.length === 0 ? (
              <Card className="p-12 text-center border-dashed bg-black/40 backdrop-blur-md border-white/10">
                <CardContent className="p-8">
                  <Layers className="w-8 h-8 text-white/20 mx-auto mb-3" />
                  <h3 className="text-base font-semibold text-white/80">No currently wearing assets detected</h3>
                  <p className="text-xs font-mono text-white/40 mt-1">
                    User may have a private inventory or is wearing default bundle items.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" style={{ contain: 'layout paint' }}>
                {outfit.items.map((item, idx) => (
                  <AssetCard key={item.id} item={item} index={idx} />
                ))}
              </div>
            )}
          </section>
        </TabsContent>

        <TabsContent value="groups">
          <section className="space-y-4">
            {groups.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-black/40 backdrop-blur-md border border-white/10 shadow-sm">
                {/* Multi-Criteria Sorting Options Bar with Sliding Pill */}
                <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-black/40 backdrop-blur-md border border-white/5">
                  <span className="text-xs font-mono text-white/40 px-2 hidden sm:inline">SORT:</span>

                  <button
                    onClick={() => {
                      AudioHaptics.playSortChange();
                      setGroupSort('members_desc');
                    }}
                    onMouseEnter={() => AudioHaptics.playHoverTick()}
                    className={`relative text-xs font-mono px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors z-10 ${
                      groupSort === 'members_desc' ? 'text-white font-semibold' : 'text-white/60 hover:text-white'
                    }`}
                  >
                    {groupSort === 'members_desc' && (
                      <motion.div
                        layoutId="groupSortActivePill"
                        transition={{ type: 'spring', stiffness: 300, damping: 28 }}
                        className="absolute inset-0 bg-black/50 backdrop-blur-lg border border-white/20 shadow-md rounded-lg -z-10"
                      />
                    )}
                    <ArrowUpWideNarrow className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Most Members</span>
                  </button>

                  <button
                    onClick={() => {
                      AudioHaptics.playSortChange();
                      setGroupSort('members_asc');
                    }}
                    onMouseEnter={() => AudioHaptics.playHoverTick()}
                    className={`relative text-xs font-mono px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors z-10 ${
                      groupSort === 'members_asc' ? 'text-white font-semibold' : 'text-white/60 hover:text-white'
                    }`}
                  >
                    {groupSort === 'members_asc' && (
                      <motion.div
                        layoutId="groupSortActivePill"
                        transition={{ type: 'spring', stiffness: 300, damping: 28 }}
                        className="absolute inset-0 bg-black/50 backdrop-blur-lg border border-white/20 shadow-md rounded-lg -z-10"
                      />
                    )}
                    <ArrowDownNarrowWide className="w-3.5 h-3.5 text-amber-400" />
                    <span>Least Members</span>
                  </button>

                  <button
                    onClick={() => {
                      AudioHaptics.playSortChange();
                      setGroupSort('rank_desc');
                    }}
                    onMouseEnter={() => AudioHaptics.playHoverTick()}
                    className={`relative text-xs font-mono px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors z-10 ${
                      groupSort === 'rank_desc' ? 'text-white font-semibold' : 'text-white/60 hover:text-white'
                    }`}
                  >
                    {groupSort === 'rank_desc' && (
                      <motion.div
                        layoutId="groupSortActivePill"
                        transition={{ type: 'spring', stiffness: 300, damping: 28 }}
                        className="absolute inset-0 bg-black/50 backdrop-blur-lg border border-white/20 shadow-md rounded-lg -z-10"
                      />
                    )}
                    <Award className="w-3.5 h-3.5 text-purple-400" />
                    <span>Highest Rank</span>
                  </button>

                  <button
                    onClick={() => {
                      AudioHaptics.playSortChange();
                      setGroupSort('default');
                    }}
                    onMouseEnter={() => AudioHaptics.playHoverTick()}
                    className={`relative text-xs font-mono px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors z-10 ${
                      groupSort === 'default' ? 'text-white font-semibold' : 'text-white/60 hover:text-white'
                    }`}
                  >
                    {groupSort === 'default' && (
                      <motion.div
                        layoutId="groupSortActivePill"
                        transition={{ type: 'spring', stiffness: 300, damping: 28 }}
                        className="absolute inset-0 bg-black/50 backdrop-blur-lg border border-white/20 shadow-md rounded-lg -z-10"
                      />
                    )}
                    <RotateCcw className="w-3.5 h-3.5 text-white/40" />
                    <span>Default</span>
                  </button>
                </div>

                {/* Copied Memory Status Indicator */}
                {copiedGroupIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-950/40 backdrop-blur-md border border-emerald-500/30 text-emerald-400 text-xs font-mono shadow-sm">
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span>{copiedGroupIds.size} COPIED TO MEMORY</span>
                    </div>
                    <button
                      onClick={handleClearCopiedMemory}
                      className="text-[11px] font-mono text-white/40 hover:text-white/80 transition-colors underline"
                      title="Reset copied groups memory"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Copied Folder — папка скопированных групп с проверкой новинок + сравнение с текущим игроком */}
            <CopiedGroupsFolder
              entries={folder.entries}
              currentGroupIds={currentGroupIds}
              currentGroupsById={currentGroupsById}
              onRemove={folder.remove}
              onClear={folder.clear}
              onCheckUpdates={folder.checkForUpdates}
              checking={folder.checking}
              updates={folder.updates}
              onOpenStore={(grp) => setStoreModalGroup(grp)}
            />

            {sortedGroups.length === 0 ? (
              <Card className="p-12 text-center border-dashed bg-black/40 backdrop-blur-md border-white/10">
                <CardContent className="p-8">
                  <Users className="w-8 h-8 text-white/20 mx-auto mb-3" />
                  <h3 className="text-base font-semibold text-white/80">No public groups found</h3>
                  <p className="text-xs font-mono text-white/40 mt-1">
                    User has not joined any public groups or their memberships are hidden.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <motion.div
                layout
                transition={{ layout: { type: 'spring', stiffness: 420, damping: 38, mass: 0.85 } }}
                className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
                style={{ contain: 'layout paint' }}
              >
                {sortedGroups.map((grp, idx) => (
                  <GroupCard
                    key={grp.id}
                    group={grp}
                    index={idx}
                    isCopiedPersistent={copiedGroupIds.has(grp.id)}
                    onCopyGroup={handleGroupCopy}
                    onOpenStore={(g) => setStoreModalGroup(g)}
                  />
                ))}
              </motion.div>
            )}
          </section>
        </TabsContent>


      </Tabs>
    </main>

    {/* Group Catalog Store Modal */}
    <GroupStoreModal
      isOpen={!!storeModalGroup}
      onClose={() => setStoreModalGroup(null)}
      group={storeModalGroup}
    />

    {/* Favorites & Wishlist Drawer */}
    <FavoritesDrawer
      isOpen={isFavoritesOpen}
      onClose={() => setIsFavoritesOpen(false)}
      onOpenGroupStore={(gid, gname) => {
        setIsFavoritesOpen(false);
        setStoreModalGroup({ id: gid, name: gname });
      }}
    />
    </>
  );
};
