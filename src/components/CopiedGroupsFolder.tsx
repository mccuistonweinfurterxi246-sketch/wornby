import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Folder, FolderOpen, Trash2, Copy, Check, ExternalLink, Clock, Users, Sparkles, RefreshCw, ChevronDown, ChevronUp, Package, Award, Bot } from 'lucide-react';
import { CopiedGroupEntry } from '../hooks/useCopiedGroupsFolder';
import { Tooltip, TooltipMono } from './ui/tooltip';
import { toast } from 'sonner';

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s/60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h/24); return `${d}d ago`;
}

export const CopiedGroupsFolder: React.FC<{
  entries: CopiedGroupEntry[];
  currentGroupIds?: Set<number>;
  currentGroupsById?: Map<number, { roleName: string; roleRank: number }>;
  onRemove: (id: number) => void;
  onClear: () => void;
  onCheckUpdates: () => void;
  checking: boolean;
  updates: Record<number, { memberDelta: number; hasNewItem?: boolean; latestItemName?: string }>;
}> = ({ entries, currentGroupIds, currentGroupsById, onRemove, onClear, onCheckUpdates, checking, updates }) => {
  const [open, setOpen] = useState(true);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [language, setLanguage] = useState<'en' | 'ru'>(() => {
    try { return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'; } catch { return 'en'; }
  });

  const [discordLinked, setDiscordLinked] = useState<string | null>(null);

  // Новый безопасный путь: cookie wornby_auth (HttpOnly) — токен НЕ в URL, не в localStorage XSS-доступен.
  // При монтировании спрашиваем /api/auth/discord/me с credentials include (кука улетит).
  // Легаси ?discord_token= в URL тоже поддерживаем для старых ссылок, но сразу чистим и мигрируем в куку (бек уже ставит куку).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1) чистим legacy токен из URL если вдруг старый бек прислал (утечка через history/referer)
        try {
          const url = new URL(window.location.href);
          if (url.searchParams.has('discord_token')) {
            url.searchParams.delete('discord_token');
            url.searchParams.delete('roblox');
            window.history.replaceState({}, '', url.toString());
          }
          if (url.searchParams.has('linked')) {
            // новый бек редиректит ?linked=1 — тоже чистим чтобы не палить связь
            url.searchParams.delete('linked');
            url.searchParams.delete('roblox');
            window.history.replaceState({}, '', url.toString());
          }
        } catch {}
        // 2) спрашиваем бек по куке (HttpOnly, не палится в URL/referer)
        const res = await fetch('/api/auth/discord/me', { credentials: 'include' }).then(r=>r.json()).catch(()=>null);
        if (!cancelled) {
          if (res?.linked) {
            setDiscordLinked(res.robloxUsername || 'linked');
            // мигрируем: стираем legacy токен из localStorage чтобы не светить в XSS
            try { localStorage.removeItem('wornby_discord_token'); } catch {}
          } else {
            // после /unlink бек вернет linked:false — чистим UI и legacy токен
            setDiscordLinked(null);
            try { localStorage.removeItem('wornby_discord_token'); } catch {}
          }
          return;
        }
      } catch {
        if (!cancelled) setDiscordLinked(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // после линка — ресинк всех локальных групп bulk'ом через куку, иначе Discord /folder останется 0
  useEffect(() => {
    if (!discordLinked || entries.length === 0) return;
    const ids = entries.map(e=>e.id);
    const groups = entries.map(e=>({ id: e.id, name: e.name, memberCount: e.memberCount, iconUrl: e.iconUrl }));
    fetch('/api/folder/sync-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include' as RequestCredentials,
      body: JSON.stringify({ groupIds: ids, groups }),
    }).catch(()=>{
      // fallback per-entry
      for (const e of entries) {
        fetch('/api/folder/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include' as RequestCredentials,
          body: JSON.stringify({ groupId: e.id, groupName: e.name, memberCount: e.memberCount, iconUrl: e.iconUrl }),
        }).catch(()=>{});
      }
    });
  }, [discordLinked, entries.length]);

  if (entries.length === 0) return null;

  const handleLinkDiscord = async (changeAccount = false) => {
    if (discordLinked && !changeAccount) return;
    // 1-клик OAuth — теперь без обязательного поиска игрока, достаточно нажать кнопку
    const lastRoblox = (()=>{ try { return localStorage.getItem('wornby_last_roblox_username') || ''; } catch { return ''; }})();
    try {
      const status = await fetch('/api/discord/status').then(r=>r.json()).catch(()=>null);
      if (!status?.enabled) {
        toast.error('Discord notifications are temporarily unavailable');
        return;
      }
      const qs = lastRoblox ? `?roblox=${encodeURIComponent(lastRoblox)}` : '';
      window.location.href = `/api/auth/discord${qs}`;
    } catch {
      toast.error('Could not connect to Discord. Try again.');
    }
  };

  const handleCopy = async (e: CopiedGroupEntry) => {
    try {
      await navigator.clipboard.writeText(e.name);
      setCopiedId(e.id);
      setTimeout(()=>setCopiedId(null), 2000);
      toast.success('Copied', { description: e.name });
    } catch { toast.error('Copy failed'); }
  };

  return (
    <div className="w-full rounded-2xl bg-black/40 backdrop-blur-xl border border-white/[0.07] overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(v=>!v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v=>!v); } }}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-3">
          <span className="p-1.5 rounded-lg bg-amber-500/10 border border-amber-500/15 text-amber-300">
            {open ? <FolderOpen className="w-4 h-4" /> : <Folder className="w-4 h-4" />}
          </span>
          <span className="text-xs font-mono tracking-[0.14em] font-medium text-white/80">COPIED FOLDER</span>
          <span className="px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/10 text-[11px] font-mono font-medium text-white/70">{entries.length}</span>
          {entries.some(e=> updates[e.id]?.hasNewItem) && (
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 text-[11px] font-mono font-medium flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> NEW ITEM
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Tooltip content={<TooltipMono label={discordLinked ? 'Discord connected' : 'Connect Discord'} hint={discordLinked ? 'DM notifications on' : 'Private notifications'} icon={<Bot className="w-3 h-3" />} />} side="top">
            <span
              role="button"
              aria-disabled={discordLinked ? 'true' : 'false'}
              onClick={(e)=>{ e.stopPropagation(); if (!discordLinked) handleLinkDiscord(); }}
              className={`p-1.5 rounded-lg border flex items-center gap-1 transition-colors ${discordLinked ? 'bg-indigo-500/15 border-indigo-500/25 text-indigo-300 cursor-default' : 'bg-white/[0.04] hover:bg-white/[0.06] border-white/10 text-white/40 hover:text-white'}`}
            >
              <Bot className="w-3.5 h-3.5" /> <span className="hidden sm:inline text-xs font-mono">{discordLinked ? (language === 'ru' ? 'Discord подключён' : 'Discord connected') : (language === 'ru' ? 'Подключить Discord' : 'Connect Discord')}</span>
            </span>
          </Tooltip>
          {discordLinked && (
            <Tooltip content={<TooltipMono label={language === 'ru' ? 'Сменить Discord' : 'Change Discord'} hint={language === 'ru' ? 'группы сохранятся' : 'groups stay saved'} icon={<RefreshCw className="w-3 h-3" />} />} side="top">
              <button type="button" onClick={(e)=>{ e.stopPropagation(); if (window.confirm(language === 'ru' ? 'Сменить Discord-аккаунт? Твои группы сохранятся.' : 'Change Discord account? Your groups will stay saved.')) handleLinkDiscord(true); }} className="px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-[10px] font-mono text-white/45 hover:text-white transition-colors">
                {language === 'ru' ? 'Сменить' : 'Change'}
              </button>
            </Tooltip>
          )}
          <Tooltip content={<TooltipMono label="Check for new items" hint={`${entries.length} groups`} icon={<RefreshCw className="w-3 h-3" />} />} side="top">
            <span
              role="button"
              onClick={(e)=>{ e.stopPropagation(); onCheckUpdates(); }}
              className={`px-2.5 py-1 rounded-lg border text-xs font-mono font-medium flex items-center gap-1.5 transition-colors ${checking ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-300' : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/10 text-white/60 hover:text-white'}`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} /> {checking ? 'CHECKING' : 'Check new'}
            </span>
          </Tooltip>
          <Tooltip content={<TooltipMono label="Clear folder" hint={`${entries.length} items`} />} side="top">
            <span
              role="button"
              onClick={(e)=>{ e.stopPropagation(); onClear(); }}
              className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-red-500/10 border border-white/10 hover:border-red-500/20 text-white/40 hover:text-red-300 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </span>
          </Tooltip>
          <span className="ml-1 p-1 rounded-md bg-white/[0.04] border border-white/10 text-white/30">
            {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </span>
        </div>
      </div>
      <AnimatePresence initial={false}>
      {!discordLinked && open && (
        <motion.div initial={{ opacity: 0, height: 0, y: -4 }} animate={{ opacity: 1, height: 'auto', y: 0 }} exit={{ opacity: 0, height: 0, y: -4 }} transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }} className="mx-3 mb-2 px-2.5 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/15 text-indigo-200 text-[11px] font-mono flex items-center gap-1.5 overflow-hidden">
          <Bot className="w-3 h-3 shrink-0" />
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={language} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
              {language === 'ru' ? '1. Нажми «Подключить Discord» → 2. Скопируй группу ↓ — бот пришлёт DM.' : '1. Click Connect Discord → 2. Copy a group ↓ — bot will DM you.'}
            </motion.span>
          </AnimatePresence>
          <button type="button" onClick={(e)=>{ e.stopPropagation(); setLanguage(language === 'ru' ? 'en' : 'ru'); }} className="ml-auto shrink-0 text-[10px] font-mono text-white/45 hover:text-white/80 underline underline-offset-2" aria-label="Switch language">
            {language === 'ru' ? 'EN' : 'RU'}
          </button>
        </motion.div>
      )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
      {discordLinked && open && (
        <motion.div initial={{ opacity: 0, height: 0, y: -4 }} animate={{ opacity: 1, height: 'auto', y: 0 }} exit={{ opacity: 0, height: 0, y: -4 }} transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }} className="mx-3 mb-2 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/15 text-emerald-200 text-[11px] font-mono flex items-center gap-1.5 overflow-hidden">
          <Sparkles className="w-3 h-3 shrink-0" />
          <span>{entries.length === 0 ? (language === 'ru' ? 'Готово! Теперь скопируй группу ниже — бот будет слать DM о новых вещах, снятии и возврате.' : 'Done! Now copy a group below — bot will DM about new/off/back on sale.') : (language === 'ru' ? `Отслеживается ${entries.length} — бот уже следит, DM придёт при изменениях.` : `Tracking ${entries.length} — bot is watching, DM on changes.`)}</span>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[460px] overflow-y-auto fancy-scroll overscroll-contain">
              {entries.map(e => {
                const upd = updates[e.id];
                const hasNew = upd?.hasNewItem;
                const delta = upd?.memberDelta;
                const isCopied = copiedId === e.id;
                const hasGroup = currentGroupIds?.has(e.id) ?? false;
                const curRole = currentGroupsById?.get(e.id);
                return (
                  <div
                    key={e.id}
                    className={`group relative rounded-xl border p-3 flex flex-col gap-2.5 backdrop-blur-sm transition-all overflow-visible ${hasNew ? 'border-emerald-500/25 bg-emerald-950/10 shadow-[0_2px_12px_rgba(16,185,129,0.08)]' : hasGroup ? 'border-white/[0.07] bg-white/[0.02] hover:border-white/12 hover:bg-white/[0.04]' : 'border-amber-500/20 bg-amber-950/10 hover:border-amber-500/30'}`}
                  >
                    {/* Top status badge — inside card, not clipped */}
                    <div className="absolute top-2.5 right-2.5 z-10">
                      {hasNew ? (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-mono font-bold tracking-wide shadow flex items-center gap-1">
                          <Package className="w-3 h-3" /> NEW
                        </span>
                      ) : !hasGroup ? (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500 text-black text-[10px] font-mono font-bold tracking-wide shadow flex items-center gap-1">
                          MISSING
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-white/10 border border-white/15 text-white/70 text-[10px] font-mono font-medium flex items-center gap-1 backdrop-blur">
                          <Check className="w-3 h-3 text-emerald-400" /> OWNED
                        </span>
                      )}
                    </div>

                    <div className="flex items-start gap-3 min-w-0 pr-14">
                      <div className="w-10 h-10 rounded-xl bg-black/40 border border-white/10 overflow-hidden shrink-0 flex items-center justify-center shadow-sm">
                        {e.iconUrl ? <img src={e.iconUrl} alt={e.name} referrerPolicy="no-referrer" className="w-full h-full object-cover" /> : <Users className="w-4 h-4 text-white/30" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold tracking-tight text-white/95 truncate pr-1">{e.name}</div>
                        <div className="flex items-center gap-1.5 text-[11px] font-mono text-white/40 mt-0.5">
                          <Users className="w-3 h-3 text-white/30" /> {e.memberCount.toLocaleString()}
                          {typeof delta === 'number' && delta !== 0 && (
                            <span className={`ml-1 px-1 py-0 rounded text-[10px] border font-medium ${delta>0 ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-300'}`}>
                              {delta>0?'+':''}{delta.toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="px-2 py-1 rounded-lg bg-white/[0.04] border border-white/10 text-[10px] font-mono font-medium text-white/60 flex items-center gap-1"><Award className="w-3 h-3 text-white/40" /> RANK {e.roleRank}</span>
                      <span className="text-[11px] font-mono text-white/40 truncate flex-1">{e.roleName}</span>
                    </div>

                    {/* Ownership status — formal English */}
                    <div className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-mono flex items-center gap-1.5 ${hasGroup ? 'bg-emerald-500/10 border-emerald-500/18 text-emerald-300' : 'bg-amber-500/10 border-amber-500/18 text-amber-200'}`}>
                      {hasGroup ? <><Check className="w-3.5 h-3.5" /> Owned by this player</> : <><Users className="w-3.5 h-3.5" /> Missing for this player</>}
                      {hasGroup && curRole && <span className="ml-auto text-white/35 truncate">· {curRole.roleName}</span>}
                    </div>

                    {hasNew && upd?.latestItemName && (
                      <div className="px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-200 text-[11px] font-mono truncate flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3 text-emerald-400 shrink-0" /> New item: {upd.latestItemName}
                      </div>
                    )}

                    <div className="text-[10px] font-mono tracking-wide text-white/25 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Copied {timeAgo(e.copiedAt)} {e.sourceUserName ? `from @${e.sourceUserName}` : ''}
                    </div>

                    <div className="flex items-center gap-1.5 pt-1 border-t border-white/[0.06]">
                      <Tooltip content={<TooltipMono label={isCopied ? 'Copied' : 'Copy name'} hint={e.name.slice(0,20)} />}>
                        <button
                          onClick={()=>handleCopy(e)}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-mono font-medium border flex items-center justify-center gap-1.5 transition-colors ${isCopied ? 'bg-emerald-500/15 border-emerald-500/25 text-emerald-300' : 'bg-white/[0.04] hover:bg-white/[0.06] border-white/10 text-white/70 hover:text-white'}`}
                        >
                          {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {isCopied ? 'COPIED' : 'Copy'}
                        </button>
                      </Tooltip>
                      <Tooltip content={<TooltipMono label="Open group" hint={`#${e.id}`} />}>
                        <a href={`https://www.roblox.com/groups/${e.id}`} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/60 hover:text-white transition-colors">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </Tooltip>
                      <Tooltip content={<TooltipMono label="Remove" hint="from folder" />}>
                        <button onClick={()=>onRemove(e.id)} className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-red-500/10 border border-white/10 hover:border-red-500/20 text-white/30 hover:text-red-300 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
