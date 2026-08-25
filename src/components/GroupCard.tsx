import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { RobloxGroupMembership } from '../types/roblox';
import { TiltCard } from './TiltCard';
import { Card, CardContent } from './ui/card';
import { toast } from 'sonner';
import { Shield, Users, Copy, Check, BadgeCheck } from 'lucide-react';
import { AudioHaptics } from './AudioHaptics';
import { FALLBACK_GROUP_SVG } from '../lib/fallbacks';
import { Tooltip, TooltipMono } from './ui/tooltip';

interface GroupCardProps {
  group: RobloxGroupMembership;
  index: number;
  isCopiedPersistent: boolean;
  onCopyGroup: (group: RobloxGroupMembership) => void;
}

export const GroupCard: React.FC<GroupCardProps> = ({
  group,
  index,
  isCopiedPersistent,
  onCopyGroup,
}) => {
  const [copiedRecently, setCopiedRecently] = useState(false);

  const handleCopyName = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(group.name);
      } else {
        const ta = document.createElement('textarea');
        ta.value = group.name; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      AudioHaptics.playCopyPunch();
      setCopiedRecently(true);
      onCopyGroup(group);
      toast.success("Group Name Copied", { description: group.name });
      setTimeout(() => setCopiedRecently(false), 2200);
    } catch {
      toast.error("Copy failed");
    }
  };

  const isCopied = copiedRecently || isCopiedPersistent;
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
                  <Tooltip content={<TooltipMono label="Click to copy" hint={group.name.slice(0,24)} />} side="top" align="start">
                    <h4 
                      className="text-sm font-semibold text-white/95 truncate cursor-pointer hover:text-cyan-300 transition-colors flex-1"
                      onClick={handleCopyName}
                    >
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

              {/* Right: Dimension-Locked Copy Name Button */}
              <Tooltip content={<TooltipMono label={isCopied ? 'Copied' : 'Copy Name'} hint={group.name.slice(0,18)} icon={isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} />} side="top" align="end">
                <button
                  onClick={handleCopyName}
                  aria-label="Copy Group Name"
                  className={`shrink-0 w-[88px] h-7 rounded-lg text-xs font-mono transition-all duration-150 active:scale-95 flex items-center justify-center gap-1.5 ${
                    isCopied
                      ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-500/30 font-semibold shadow-sm'
                      : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white border border-white/[0.06]'
                  }`}
                >
                {isCopied ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                    <span>COPIED</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 text-white/40 shrink-0" />
                    <span>Copy Name</span>
                  </>
                )}
              </button>
              </Tooltip>
            </div>
          </CardContent>
        </Card>
      </TiltCard>
      </div>
    </motion.div>
  );
};
