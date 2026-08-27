import React, { useState } from 'react';
import { Copy, Check, Terminal, ExternalLink, Hash, Code2 } from 'lucide-react';
import { AudioHaptics } from './AudioHaptics';
import { toast } from 'sonner';
import { Tooltip, TooltipMono } from './ui/tooltip';

interface QuickCopyStationProps {
  assetId: number;
  studioLuaCommand: string;
  catalogUrl: string;
  assetName: string;
  variant?: 'compact' | 'expanded';
  showStudioCommand?: boolean;
}

export const QuickCopyStation: React.FC<QuickCopyStationProps> = ({
  assetId,
  studioLuaCommand,
  catalogUrl,
  assetName,
  variant = 'compact',
  showStudioCommand = true,
}) => {
  const [copiedType, setCopiedType] = useState<string | null>(null);

  const copyToClipboard = async (text: string, type: string) => {
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
      toast.success(type === 'id' ? "Asset ID Copied" : "Lua Command Copied", { description: text });
      setCopiedType(type);
      setTimeout(() => setCopiedType(null), 2000);
    } catch (err) {
      console.error('Copy failed', err);
      toast.error("Copy failed");
    }
  };

  if (variant === 'compact') {
    return (
      <div className="flex items-center gap-1 pt-1.5 mt-auto border-t border-white/[0.06] w-full min-w-0">
        {/* Asset ID Quick-Copy */}
        <Tooltip content={<TooltipMono label="Copy ID" hint={`#${assetId}`} icon={<Hash className="w-3 h-3" />} />} side="top">
          <button
            onClick={() => copyToClipboard(String(assetId), 'id')}
            aria-label="Copy Numeric Asset ID"
            className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[11px] font-mono leading-none transition-all duration-200 ${
              copiedType === 'id'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 haptic-active font-semibold'
                : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/80 hover:text-white border border-white/[0.05]'
            }`}
          >
            {copiedType === 'id' ? (
              <Check className="w-3 h-3 stroke-[2] text-emerald-400 shrink-0" />
            ) : (
              <Hash className="w-3 h-3 stroke-[1.75] text-white/40 shrink-0" />
            )}
            <span className="truncate">{copiedType === 'id' ? 'COPIED' : assetId}</span>
          </button>
        </Tooltip>

        {/* Studio Lua Script Copy */}
        {showStudioCommand && <Tooltip content={<TooltipMono label="Copy Studio Lua" hint="InsertService" icon={<Code2 className="w-3 h-3" />} />} side="top">
          <button
            onClick={() => copyToClipboard(studioLuaCommand, 'lua')}
            aria-label="Copy Studio Lua Insert Command"
            className={`w-7 h-7 shrink-0 rounded-lg text-xs transition-all duration-200 flex items-center justify-center ${
              copiedType === 'lua'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 haptic-active'
                : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white border border-white/[0.05]'
            }`}
          >
            {copiedType === 'lua' ? <Check className="w-3 h-3 stroke-[2] text-cyan-400" /> : <Code2 className="w-3 h-3 stroke-[1.75]" />}
          </button>
        </Tooltip>}

        {/* Catalog Direct Link — премиальный URL-чип */}
        <Tooltip
          content={
            <span className="inline-flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80 shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
              <span className="text-white/40">www.roblox.com/catalog/</span>
              <span className="text-white font-medium tracking-wider">{assetId}</span>
              <ExternalLink className="w-3 h-3 text-white/30 ml-1" />
            </span>
          }
          side="top"
          align="end"
        >
          <a
            href={catalogUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open "${assetName}" in Roblox Catalog`}
            className="group w-7 h-7 shrink-0 rounded-lg text-xs bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white border border-white/[0.05] hover:border-white/10 transition-all duration-200 flex items-center justify-center"
          >
            <ExternalLink className="w-3 h-3 stroke-[1.75] group-hover:translate-x-[0.5px] group-hover:-translate-y-[0.5px] transition-transform" />
          </a>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
      <div className="flex items-center justify-between text-xs text-white/40 font-mono">
        <span>QUICK-COPY STATION</span>
        <span>ID: {assetId}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button
          onClick={() => copyToClipboard(String(assetId), 'id')}
          className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono transition-all duration-200 ${
            copiedType === 'id'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 haptic-active'
              : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/90 border border-white/[0.06]'
          }`}
        >
          <span className="flex items-center gap-2">
            <Hash className="w-3.5 h-3.5 text-white/40" />
            Asset ID: {assetId}
          </span>
          {copiedType === 'id' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-white/40" />}
        </button>

        <button
          onClick={() => copyToClipboard(studioLuaCommand, 'lua')}
          className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono transition-all duration-200 ${
            copiedType === 'lua'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 haptic-active'
              : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/90 border border-white/[0.06]'
          }`}
        >
          <span className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-cyan-400" />
            Studio Lua Loader
          </span>
          {copiedType === 'lua' ? <Check className="w-3.5 h-3.5 text-cyan-400" /> : <Copy className="w-3.5 h-3.5 text-white/40" />}
        </button>
      </div>
    </div>
  );
};
