import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { RobloxGroupMembership } from '../types/roblox';
import { TiltCard } from './TiltCard';
import { Card, CardContent } from './ui/card';
import { toast } from 'sonner';
import { Shield, Users, Check, BadgeCheck, Store, FolderPlus } from 'lucide-react';
import { AudioHaptics } from './AudioHaptics';
import { FALLBACK_GROUP_SVG } from '../lib/fallbacks';
import { Tooltip, TooltipMono } from './ui/tooltip';

interface GroupCardProps {
  group: RobloxGroupMembership;
  index: number;
  isSaved: boolean;
  onSaveGroup: (group: RobloxGroupMembership) => void;
  onOpenStore?: (group: RobloxGroupMembership) => void;
}

export const GroupCard: React.FC<GroupCardProps> = ({
  group,
  index,
  isSaved,
  onSaveGroup,
  onOpenStore,
}) => {
  const [savedRecently, setSavedRecently] = useState(false);

  const handleSaveGroup = () => {
    if (isSaved) return;
    AudioHaptics.playCopyPunch();
    setSavedRecently(true);
    onSaveGroup(group);
    toast.success('Group saved', { description: `${group.name} added to Saved stores` });
    setTimeout(() => setSavedRecently(false), 2200);
  };

  const saved = savedRecently || isSaved;
  // Уникальная волна: диагональ + синус, 60fps, не режет глаза (высокий damping, без отскока)
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const shouldFloat = !prefersReduced;
  const floatClass = !shouldFloat ? '' : (index % 2 === 0 ? 'animate-float-slow' : 'animate-float-delayed');
  const col = index % 4;
  const row = Math.floor(index / 4);
  // математика волны: col*0.012 + row*0.018 = диагональная волна, sin = органический изгиб
  const waveDelay = col * 0.012 + row * 0.018 + Math.sin(col * 1.1 + row * 0.7) * 0.012;
  const layoutDelay = Math.max(0, Math.min(waveDelay, 0.14));

  return (
    <motion.div
      layout={!prefersReduced ? 'position' : false}
      layoutId={!prefersReduced ? `group-${group.id}` : undefined}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        layout: {
          type: 'spring',
          stiffness: 420,
          damping: 38,
          mass: 0.85,
          delay: layoutDelay,
        },
        opacity: { duration: 0.34, delay: Math.min(index * 0.022, 0.18), ease: [0.25, 0.1, 0.25, 1] },
        y: { duration: 0.38, delay: Math.min(index * 0.022, 0.18), ease: [0.22, 1, 0.36, 1] },
        scale: { duration: 0.38, delay: Math.min(index * 0.022, 0.18), ease: [0.22, 1, 0.36, 1] },
      }}
      className="h-full relative will-change-transform"
      style={{ transform: 'translateZ(0)' }}
    >
      <div className={`${floatClass} h-full will-change-transform`} style={{ contain: 'layout paint' }}>
        <TiltCard maxTilt={5} scale={1.012} className="h-full">
          <Card className="h-full flex flex-col group border-none bg-transparent shadow-none">
          <CardContent className="p-4 flex-1 flex flex-col justify-between min-h-[135px] h-full space-y-3 bg-black/40 backdrop-blur-md group-hover:bg-black/60 border border-white/5 group-hover:border-white/20 rounded-2xl transition-all duration-300 shadow-inner">
            {/* Top Section: Emblem, Name & Verified Badge */}
            <div className="flex items-center gap-3 min-w-0">
              {/* Group Emblem Thumbnail */}
              <div className="w-11 h-11 rounded-xl bg-black/40 border border-white/[0.06] overflow-hidden flex-shrink-0 flex items-center justify-center">
                {group.iconUrl ? (
                  <img
                    src={group.iconUrl}
                    alt={group.name}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      e.currentTarget.src = FALLBACK_GROUP_SVG;
                    }}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <Shield className="w-5 h-5 text-white/30" />
                )}
              </div>

              {/* Group Metadata */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Tooltip content={<TooltipMono label={group.name} hint={`Group #${group.id}`} />} side="top" align="start">
                    <h4 className="text-sm font-semibold text-white/95 truncate flex-1">
                      {group.name}
                    </h4>
                  </Tooltip>
                  {group.hasVerifiedBadge && (
                    <BadgeCheck className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                  )}
                </div>

                {/* Member Count Telemetry */}
                <div className="flex items-center gap-1 mt-1 text-xs text-white/40 font-mono">
                  <Users className="w-3 h-3 text-white/30" />
                  <span className="truncate">{group.memberCount.toLocaleString()} members</span>
                </div>
              </div>
            </div>

            {/* Bottom Role & Rank Section with Strict 1-Line Layout */}
            <div className="pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-2 w-full mt-auto">
              {/* Left: Rank Badge + Truncated Role Title */}
              <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground border border-border whitespace-nowrap">
                  RANK {group.roleRank}
                </span>
                <Tooltip content={<TooltipMono label="Role" hint={group.roleName} />} side="top">
                  <span 
                    className="text-xs text-muted-foreground truncate min-w-0 font-medium cursor-default"
                  >
                    {group.roleName}
                  </span>
                </Tooltip>
              </div>

              {/* Right: store and saved-folder actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                {onOpenStore && (
                  <Tooltip content={<TooltipMono label="Browse Store" hint={`${group.name.slice(0, 16)}...`} icon={<Store className="w-3 h-3 text-cyan-400" />} />} side="top">
                    <button
                      onClick={() => {
                        AudioHaptics.playHoverTick();
                        onOpenStore(group);
                      }}
                      aria-label="Browse Group Store"
                      className="px-2.5 h-7 rounded-lg text-xs font-mono bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/25 transition-all duration-150 active:scale-95 flex items-center justify-center gap-1 font-medium shadow-sm"
                    >
                      <Store className="w-3 h-3 text-cyan-400" />
                      <span>Store</span>
                    </button>
                  </Tooltip>
                )}

                <Tooltip content={<TooltipMono label={saved ? 'Saved group' : 'Save group'} hint={saved ? 'Already in Saved stores' : 'Add to Saved stores'} icon={saved ? <Check className="w-3 h-3" /> : <FolderPlus className="w-3 h-3" />} />} side="top" align="end">
                  <button
                    onClick={handleSaveGroup}
                    aria-label={saved ? 'Group saved' : 'Save group'}
                    disabled={saved}
                    className={`shrink-0 w-[84px] h-7 rounded-lg text-xs font-mono transition-all duration-150 active:scale-95 flex items-center justify-center gap-1.5 ${
                      saved
                        ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-500/30 font-semibold shadow-sm'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white border border-white/[0.06]'
                    }`}
                  >
                    {saved ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                        <span>SAVED</span>
                      </>
                    ) : (
                      <>
                        <FolderPlus className="w-3 h-3 text-white/50 shrink-0" />
                        <span>Save</span>
                      </>
                    )}
                  </button>
                </Tooltip>
              </div>
            </div>
          </CardContent>
        </Card>
      </TiltCard>
      </div>
    </motion.div>
  );
};
