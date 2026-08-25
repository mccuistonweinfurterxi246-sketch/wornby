import axios, { AxiosError, AxiosInstance } from 'axios';
import { LRUCache } from 'lru-cache';
import http from 'node:http';
import https from 'node:https';

// ── Types ─────────────────────────────────────────────────────────────
export interface RobloxUserResolve {
  id: number; name: string; displayName: string; hasVerifiedBadge: boolean;
  description?: string; created?: string; isBanned?: boolean;
}
export interface RobloxAvatarThumbnails { fullBodyUrl: string | null; headshotUrl: string | null; }
export interface RobloxAssetItem {
  id: number; name: string; description: string; assetType?: number | string; assetTypeName?: string;
  creatorName: string; creatorId?: number; creatorType?: string;
  price: number | null; priceStatus?: string; lowestPrice?: number | null;
  isForSale: boolean; isOffSale: boolean; isDeletedOrModerated: boolean; isFree: boolean;
  itemRestrictions?: string[]; thumbnailUrl: string | null; studioLuaCommand: string; catalogUrl: string;
}
export interface RobloxGroupMembership {
  id: number; name: string; memberCount: number; hasVerifiedBadge: boolean;
  roleName: string; roleRank: number; iconUrl: string | null;
}
export interface RobloxUserProfileFull {
  user: RobloxUserResolve;
  thumbnails: RobloxAvatarThumbnails;
  outfit: { totalValueRobux: number; hasOffSaleItems: boolean; offSaleCount: number; freeCount: number; pricedCount: number; itemCount: number; items: RobloxAssetItem[]; };
  groups: RobloxGroupMembership[];
  telemetry: { cached: boolean; timestamp: number; responseTimeMs: number; wearingAssetCount: number; fingerprint?: string; egressShards?: number; };
}

// ── Caches ────────────────────────────────────────────────────────────
const profileCache = new LRUCache<string, RobloxUserProfileFull>({ max: 250, ttl: 1000 * 60 });
const catalogCache = new LRUCache<number, Partial<RobloxAssetItem>>({ max: 3000, ttl: 1000 * 60 * 5 });
const thumbCache = new LRUCache<number, string>({ max: 3000, ttl: 1000 * 60 * 10 });
const groupIconCache = new LRUCache<number, string>({ max: 2000, ttl: 1000 * 60 * 10 });
const negativeCache = new LRUCache<string, number>({ max: 500, ttl: 1000 * 15 });
const pendingProfiles = new Map<string, Promise<RobloxUserProfileFull>>();

// ── 2️⃣ Fingerprint Skip: murmur/FNV hash of sorted assetIds ────────
const outfitFingerprintCache = new LRUCache<string, string>({ max: 2000, ttl: 1000 * 60 * 10 }); // userId -> fp
const outfitSnapshotCache = new LRUCache<string, Map<number, Partial<RobloxAssetItem>>>({ max: 500, ttl: 1000 * 60 * 10 }); // fp -> catalog Map snapshot

// ── 5️⃣ Quantized Price Vector: price vs meta split TTL ──────────────
const priceVectorCache = new LRUCache<number, Pick<RobloxAssetItem,'price'|'lowestPrice'|'priceStatus'|'isForSale'|'isOffSale'|'isFree'|'isDeletedOrModerated'>>({
  max: 4000, ttl: 1000 * 60 * 15, // 15 min — price stable
});
const metaCache = new LRUCache<number, Pick<RobloxAssetItem,'name'|'description'|'assetType'|'assetTypeName'|'creatorName'|'creatorId'|'creatorType'|'itemRestrictions'>>({
  max: 4000, ttl: 1000 * 60 * 5, // 5 min — meta may change
});

// ── 4️⃣ ETag caches for conditional GET (304) ────────────────────────
const thumbEtagCache = new LRUCache<number, { etag: string; url: string }>({ max: 3000, ttl: 1000 * 60 * 10 });
const groupIconEtagCache = new LRUCache<number, { etag: string; url: string }>({ max: 2000, ttl: 1000 * 60 * 10 });

const ARCHIVED_PREFIX = '__ARCHIVED__:';
const ROBLOX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── 1️⃣ Consistent-Hash Egress Sharding ───────────────────────────────
// C_total = N × C_single — each shard has independent TCP pool + optional proxy.
// Configure via: EGRESS_COUNT=3 EGRESS_PROXIES=http://proxy1:8080,http://proxy2:8080 (optional)
const EGRESS_COUNT = Math.max(1, Math.min(8, parseInt(process.env.EGRESS_COUNT || '3', 10) || 3));
const EGRESS_PROXIES: string[] = (process.env.EGRESS_PROXIES || '').split(',').map(s=>s.trim()).filter(Boolean);

// VPN FAST — для медленного интернета/ВПН: hedged раньше, таймауты чуть больше, ETag выкл (304 дороже на VPN)
const IS_VPN_FAST = process.env.VPN_FAST === '1' || process.env.VPN_MODE === '1';
const HEDGED_DELAY_MS = IS_VPN_FAST ? 400 : 1200;
const SPECULATIVE_DELAY_BASE = IS_VPN_FAST ? 380 : 900;
const ECONOMY_TIMEOUT = IS_VPN_FAST ? 9500 : 8000;
const CATALOG_TIMEOUT = IS_VPN_FAST ? 8500 : 7000;
const THUMB_TIMEOUT = IS_VPN_FAST ? 8000 : 7000;
const ECONOMY_PLIMIT = IS_VPN_FAST ? 10 : 8;

function makeAgentPair() {
  return {
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 15000 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 15000 }),
  };
}
const egressAxios: AxiosInstance[] = [];
for (let i = 0; i < EGRESS_COUNT; i++) {
  const { httpAgent, httpsAgent } = makeAgentPair();
  const inst = axios.create({
    headers: ROBLOX_HEADERS as unknown as Record<string,string>,
    httpAgent, httpsAgent,
    validateStatus: (s) => s >= 200 && s < 400, // 304 included
    proxy: EGRESS_PROXIES[i] ? (() => {
      try { const u = new URL(EGRESS_PROXIES[i]); return { host: u.hostname, port: parseInt(u.port||'8080',10), protocol: u.protocol } as const; } catch { return false as const; }
    })() : false as const,
  });
  // debugging header to trace shard
  inst.defaults.headers.common['X-Egress-Shard'] = String(i);
  egressAxios.push(inst);
}
const robloxAxios = egressAxios[0]; // default fallback for non-sharded calls (users, avatar, groups)

// Knuth multiplicative hash: fast consistent hash for 32-bit ints
function egressForAsset(assetId: number): AxiosInstance {
  if (EGRESS_COUNT === 1) return egressAxios[0];
  const h = (assetId * 2654435761) >>> 0;
  return egressAxios[h % EGRESS_COUNT];
}

// ── Helpers: FNV-1a 32-bit → hex (fingerprint) ───────────────────────
function fnv1aHash(str: string): string {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function computeFingerprint(assetIds: number[]): string {
  if (assetIds.length === 0) return 'empty';
  const sorted = [...assetIds].sort((a,b)=>a-b);
  return fnv1aHash(sorted.join(','));
}

// ── Retry — VPN-aware: timeout + 429 + 5xx + ECONNABORTED ───────
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      const e = err as AxiosError & { code?: string; message?: string };
      const status = e.response?.status;
      const msg = (e.message || '').toLowerCase();
      const isTimeout = msg.includes('timeout') || msg.includes('timed out') || msg.includes('abort');
      const isRetryable = status === 429 || status === 408 || (status != null && status >= 500 && status < 600) || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED' || isTimeout;
      if (!isRetryable || attempt >= retries) throw err;
      const backoff = 300 * Math.pow(2, attempt) + Math.random() * 250;
      await new Promise(r=>setTimeout(r, backoff));
      attempt++;
    }
  }
}
// Hedged: если первый запрос не ответил за hedgedDelay, шлём дубликат через другой egress и берём первый успешный — спасает при VPN хвостах
async function hedged<T>(primary: () => Promise<T>, fallback: () => Promise<T>, hedgedDelayMs = 1200, signal?: AbortSignal): Promise<T> {
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const fallbackPromise = new Promise<T>((resolve, reject) => {
    fallbackTimer = setTimeout(() => {
      if (signal?.aborted) return reject(new DOMException('Aborted','AbortError'));
      fallback().then(resolve).catch(reject);
    }, hedgedDelayMs);
  });
  try {
    const result = await Promise.race([primary(), fallbackPromise]);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    return result;
  } catch (e) {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    // если primary упал, ждём fallback
    return fallback();
  }
}

const ASSET_TYPE_MAP: Record<number,string> = {
  2:'T-Shirt',8:'Hat',11:'Shirt',12:'Pants',17:'Head',18:'Face',19:'Gear',
  27:'Torso',28:'Right Arm',29:'Left Arm',30:'Left Leg',31:'Right Leg',
  41:'Hair Accessory',42:'Face Accessory',43:'Neck Accessory',44:'Shoulder Accessory',
  45:'Front Accessory',46:'Back Accessory',47:'Waist Accessory',
  48:'Climb Animation',49:'Death Animation',50:'Fall Animation',51:'Idle Animation',
  52:'Jump Animation',53:'Run Animation',54:'Swim Animation',55:'Walk Animation',56:'Pose Animation',
  61:'Emote Animation',64:'T-Shirt Accessory',65:'Shirt Accessory',66:'Pants Accessory',
  67:'Jacket Accessory',68:'Sweater Accessory',69:'Shorts Accessory',70:'Left Shoe Accessory',
  71:'Right Shoe Accessory',72:'Dress Skirt Accessory',76:'Eyebrow Accessory',77:'Eyelash Accessory',
  78:'Mood Animation',79:'Dynamic Head',
};

export class RobloxService {
  public static async resolveUser(query: string, signal?: AbortSignal): Promise<RobloxUserResolve> {
    const trimmed = query.trim();
    const isNumeric = /^\d+$/.test(trimmed);
    if (isNumeric) {
      const userId = parseInt(trimmed,10);
      const res = await withRetry(()=> robloxAxios.get(`https://users.roblox.com/v1/users/${userId}`, { timeout: 5000, signal }));
      return { id: res.data.id, name: res.data.name, displayName: res.data.displayName||res.data.name, hasVerifiedBadge: !!res.data.hasVerifiedBadge, description: res.data.description||'', created: res.data.created, isBanned: !!res.data.isBanned };
    } else {
      const username = trimmed;
      const negKey = `neg:${username.toLowerCase()}`;
      if (negativeCache.has(negKey)) throw new Error(`User "${username}" was not found.`);
      let res;
      try {
        res = await withRetry(()=> robloxAxios.post('https://users.roblox.com/v1/usernames/users', { usernames:[username], excludeBannedUsers:false }, { timeout:5000, signal }));
      } catch (err) {
        const e = err as AxiosError; if (e.response?.status===429) throw new Error('Too many requests — Roblox throttled username lookup');
        throw new Error(`Failed to resolve username "${username}": ${(e as Error).message}`);
      }
      if (!res.data.data || res.data.data.length===0) { negativeCache.set(negKey,1); throw new Error(`User "${username}" was not found.`); }
      const rawUser = res.data.data[0];
      let extra: { description?:string; created?:string; isBanned?:boolean } = {};
      try {
        const detailRes = await withRetry(()=> robloxAxios.get(`https://users.roblox.com/v1/users/${rawUser.id}`, { timeout:6000, signal }));
        extra = { description: detailRes.data.description, created: detailRes.data.created, isBanned: detailRes.data.isBanned };
      } catch {}
      return { id: rawUser.id, name: rawUser.name, displayName: rawUser.displayName||rawUser.name, hasVerifiedBadge: !!rawUser.hasVerifiedBadge, description: extra.description||'', created: extra.created, isBanned: !!extra.isBanned };
    }
  }

  public static async getEquippedAssets(userId:number, signal?:AbortSignal): Promise<{id:number;name?:string;assetType?:number;assetTypeName?:string}[]> {
    const assetMap = new Map<number,{id:number;name?:string;assetType?:number;assetTypeName?:string}>();
    const [wearingRes, avatarRes] = await Promise.allSettled([
      withRetry(()=> robloxAxios.get(`https://avatar.roblox.com/v1/users/${userId}/currently-wearing`, {timeout:7000, signal})),
      withRetry(()=> robloxAxios.get(`https://avatar.roblox.com/v1/users/${userId}/avatar`, {timeout:7000, signal})),
    ]);
    if (wearingRes.status==='fulfilled' && Array.isArray((wearingRes.value as unknown as {data:{assetIds:unknown[]}}).data?.assetIds)) {
      for (const rawId of (wearingRes.value as unknown as {data:{assetIds:unknown[]}}).data.assetIds) { const id=Number(rawId); if(id>0) assetMap.set(id,{id}); }
    }
    if (avatarRes.status==='fulfilled' && Array.isArray((avatarRes.value as unknown as {data:{assets:unknown[]}}).data?.assets)) {
      for (const item of (avatarRes.value as unknown as {data:{assets:{id:unknown;name?:string;assetType?:{id?:number;name?:string}}[]}}).data.assets) {
        const id=Number(item.id); if(id>0){ const existing=assetMap.get(id)||{id}; assetMap.set(id,{...existing, name:(item as {name?:string}).name||existing.name, assetType:(item as {assetType?:{id?:number}}).assetType?.id||existing.assetType, assetTypeName:(item as {assetType?:{name?:string;id?:number}}).assetType?.name || ((item as {assetType?:{id?:number}}).assetType?.id ? ASSET_TYPE_MAP[(item as {assetType:{id:number}}).assetType.id] : existing.assetTypeName)}); }
      }
    }
    return Array.from(assetMap.values());
  }

  public static async getAvatarThumbnails(userId:number, signal?:AbortSignal): Promise<RobloxAvatarThumbnails> {
    let fullBodyUrl:string|null=null, headshotUrl:string|null=null;
    try {
      const [fullRes, headshotRes] = await Promise.allSettled([
        withRetry(()=> robloxAxios.get(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`, {timeout:7000, signal})),
        withRetry(()=> robloxAxios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`, {timeout:7000, signal})),
      ]);
      if (fullRes.status==='fulfilled' && (fullRes.value as unknown as {data:{data:{imageUrl:string}[]}}).data?.data?.[0]?.imageUrl) fullBodyUrl=(fullRes.value as unknown as {data:{data:{imageUrl:string}[]}}).data.data[0].imageUrl;
      if (headshotRes.status==='fulfilled' && (headshotRes.value as unknown as {data:{data:{imageUrl:string}[]}}).data?.data?.[0]?.imageUrl) headshotUrl=(headshotRes.value as unknown as {data:{data:{imageUrl:string}[]}}).data.data[0].imageUrl;
    } catch {}
    return { fullBodyUrl, headshotUrl };
  }

  // ── 4️⃣ ETag-aware asset thumbnails (304 = 0 bytes, 80% traffic saved) — на VPN ETag выключаем (дороже) ─
  public static async getAssetThumbnails(assetIds:number[], signal?:AbortSignal): Promise<Record<number,string>> {
    if (assetIds.length===0) return {};
    const map: Record<number,string> = {};
    const missing:number[]=[];
    for (const id of assetIds){ const cached=thumbCache.get(id); if(cached) map[id]=cached; else missing.push(id); }
    if (missing.length===0) return map;
    // bucket by egress for sharding + chunk 100
    const byShard = new Map<number, number[]>();
    for (const id of missing){ const shard=(id*2654435761>>>0)%EGRESS_COUNT; const arr=byShard.get(shard)||[]; arr.push(id); byShard.set(shard,arr); }
    const tasks: Promise<void>[]=[];
    for (const [shard, ids] of byShard) {
      const client = egressAxios[shard];
      for (let i=0;i<ids.length;i+=100){
        const chunk=ids.slice(i,i+100);
        tasks.push((async()=>{
          // collect etags for this chunk — пропускаем на VPN (304 на медленном инете дороже)
          const etags = IS_VPN_FAST ? [] : chunk.map(id=>thumbEtagCache.get(id)?.etag).filter(Boolean) as string[];
          const headers: Record<string,string> = {};
          if (etags.length===chunk.length && etags.length>0) headers['If-None-Match']= etags.join(', ');
          try {
            const res = await withRetry(()=> client.get(`https://thumbnails.roblox.com/v1/assets?assetIds=${chunk.join(',')}&size=420x420&format=Png`, { timeout: THUMB_TIMEOUT, signal, headers: Object.keys(headers).length?headers:undefined }));
            // 304 -> use cached
            if (res.status===304) { for (const id of chunk){ const c=thumbEtagCache.get(id); if(c) map[id]=c.url; } return; }
            const etag = (res.headers?.etag || res.headers?.ETag || '') as string;
            if ((res as unknown as {data:{data:{targetId:number;imageUrl:string}[]}}).data?.data){
              for (const item of (res as unknown as {data:{data:{targetId:number;imageUrl:string}[]}}).data.data){
                if(item.targetId && item.imageUrl){ map[item.targetId]=item.imageUrl; thumbCache.set(item.targetId,item.imageUrl); if(etag) thumbEtagCache.set(item.targetId,{etag,url:item.imageUrl}); else thumbEtagCache.set(item.targetId,{etag:`W/"${item.targetId}-${Date.now()}"`,url:item.imageUrl}); }
              }
            }
            // also store etag per id even if url already cached (for next 304)
            if(etag) for (const id of chunk) if(map[id] && !thumbEtagCache.has(id)) thumbEtagCache.set(id,{etag,url:map[id]});
          } catch {}
        })());
      }
    }
    await Promise.allSettled(tasks);
    return map;
  }

  public static async getEconomyAssetDetails(assetId:number, signal?:AbortSignal, bypassCache=false): Promise<Partial<RobloxAssetItem>|null> {
    const priceHit = bypassCache ? undefined : priceVectorCache.get(assetId);
    const metaHit = bypassCache ? undefined : metaCache.get(assetId);
    if (priceHit && metaHit) {
      const merged = { id: assetId, ...priceHit, ...metaHit } as Partial<RobloxAssetItem>;
      // stale FREE fix (старый кэш 0 + resale)
      const low = (merged.lowestPrice as number|null) ?? null;
      if (merged.price===0 && low!=null && low>0) return { ...merged, price: low, isFree:false, isForSale:true, isOffSale:false, priceStatus: merged.priceStatus==='OffSale'?'Resale':merged.priceStatus };
      return merged;
    }
    const cached = bypassCache ? undefined : catalogCache.get(assetId);
    if (cached) {
      const low = (cached.lowestPrice as number|null) ?? null;
      if (cached.price===0 && low!=null && low>0) {
        const fixed = { ...cached, price: low, isFree:false, isForSale:true, isOffSale:false, priceStatus: cached.priceStatus==='OffSale'?'Resale':cached.priceStatus };
        catalogCache.set(assetId,fixed);
        return fixed;
      }
      return cached;
    }
    const doFetch = async (client: AxiosInstance) => {
      const res = await withRetry(()=> client.get(`https://economy.roblox.com/v2/assets/${assetId}/details`, { timeout: ECONOMY_TIMEOUT, signal }));
      if(!res.data || !res.data.Name) return null;
      const data=res.data;
      const price = typeof data.PriceInRobux==='number'?data.PriceInRobux:null;
      const isForSale=!!data.IsForSale; const isFree=data.IsPublicDomain||price===0;
      const out: Partial<RobloxAssetItem> = { id: assetId, name:data.Name, description:data.Description||'', assetType:data.AssetTypeId, assetTypeName:data.AssetTypeId?(ASSET_TYPE_MAP[data.AssetTypeId]||`Type ${data.AssetTypeId}`):'Wearable Asset', creatorName:data.Creator?.Name||'Roblox User / UGC', creatorId:data.Creator?.Id, creatorType:data.Creator?.CreatorType, price:isFree?0:price, lowestPrice:price, isForSale, isOffSale:!isForSale&&!isFree, isFree, isDeletedOrModerated:false };
      catalogCache.set(assetId,out);
      priceVectorCache.set(assetId,{ price: out.price??null, lowestPrice: out.lowestPrice??null, priceStatus: out.priceStatus, isForSale: !!out.isForSale, isOffSale: !!out.isOffSale, isFree: !!out.isFree, isDeletedOrModerated: !!out.isDeletedOrModerated });
      metaCache.set(assetId,{ name: out.name as string, description: out.description as string, assetType: out.assetType, assetTypeName: out.assetTypeName, creatorName: out.creatorName as string, creatorId: out.creatorId, creatorType: out.creatorType, itemRestrictions: out.itemRestrictions });
      return out;
    };
    const primary = egressForAsset(assetId);
    const altShard = (assetId * 2654435761 >>>0) % EGRESS_COUNT;
    const fallback = egressAxios[(altShard+1)%EGRESS_COUNT] ?? primary;
    try {
      // hedged: primary сразу, fallback через HEDGED_DELAY_MS если VPN тормозит (400ms VPN vs 1200ms обычный)
      if (EGRESS_COUNT>1) {
        return await hedged(()=>doFetch(primary), ()=>doFetch(fallback), HEDGED_DELAY_MS, signal);
      }
      return await doFetch(primary);
    } catch (err){
      const e=err as AxiosError; const status=e.response?.status;
      // только 404 = реально удалён, всё остальное (timeout/429/403) = не помечаем DELETED, возвращаем null чтобы показать OFF-SALE а не DELETED
      const is404=status===404;
      const marker: Partial<RobloxAssetItem> = is404 ? { id: assetId, isDeletedOrModerated:true, isOffSale:true, isFree:false, name:`${ARCHIVED_PREFIX}${assetId}` } : null as unknown as Partial<RobloxAssetItem>;
      if(is404 && marker){ catalogCache.set(assetId,marker); priceVectorCache.set(assetId,{ price:null, lowestPrice:null, priceStatus: undefined, isForSale:false, isOffSale:true, isFree:false, isDeletedOrModerated:true }); }
      return is404?marker:null;
    }
  }

  private static async pLimit<T>(tasks:(()=>Promise<T>)[], limit:number): Promise<void> {
    const executing: Promise<void>[]=[];
    for (const t of tasks){
      const p=(async()=>{ await new Promise(r=>setTimeout(r,Math.random()*35)); await t(); })().then(()=>{ const idx=executing.indexOf(p as unknown as Promise<void>); if(idx>=0) executing.splice(idx,1); }) as Promise<void>;
      executing.push(p as unknown as Promise<void>);
      if(executing.length>=limit) await Promise.race(executing);
    }
    await Promise.allSettled(executing);
  }

  // ── Quantized + Sharded Catalog Resolver ────────────────────────────
  public static async getCatalogDetails(assetIds:number[], signal?:AbortSignal, onChunk?:(partial: Map<number,Partial<RobloxAssetItem>>)=>void): Promise<Map<number,Partial<RobloxAssetItem>>> {
    const detailsMap = new Map<number,Partial<RobloxAssetItem>>();
    if(assetIds.length===0) return detailsMap;

    // 1) quantized fast path: price+meta (+ stale FREE→resale fix for 76692407)
    const fixStaleFree = (m: Partial<RobloxAssetItem>): Partial<RobloxAssetItem> => {
      const low = (m.lowestPrice as number|null) ?? null;
      const hasResale = low!=null && low>0;
      if (m.price===0 && hasResale) {
        return { ...m, price: low, isFree: false, isForSale: true, isOffSale: false, priceStatus: m.priceStatus==='OffSale' ? 'Resale' : m.priceStatus };
      }
      if ((m.price==null) && hasResale && !m.isFree) {
        return { ...m, price: low, isForSale: true, isOffSale: false };
      }
      return m;
    };
    const uncached:number[]=[];
    for (const id of assetIds){
      const c=catalogCache.get(id);
      if(c){
        // УНИКАЛЬНО: если кэш помечен DELETED — не доверяем старому VPN-таймауту, форсим рефетч (особенно для 104...,115...,132...)
        if (c.isDeletedOrModerated) { uncached.push(id); continue; }
        const fixed=fixStaleFree(c); if(fixed!==c) catalogCache.set(id,fixed); detailsMap.set(id,fixed); continue;
      }
      const priceHit=priceVectorCache.get(id);
      const metaHit=metaCache.get(id);
      if(priceHit && metaHit){
        if (priceHit.isDeletedOrModerated) { uncached.push(id); continue; }
        let merged: Partial<RobloxAssetItem> = { id, ...priceHit, ...metaHit } as Partial<RobloxAssetItem>;
        merged = fixStaleFree(merged);
        if (merged.isDeletedOrModerated) { uncached.push(id); continue; }
        // also sync corrected back to caches
        if (merged.price!==priceHit.price || merged.isFree!==priceHit.isFree) {
          priceVectorCache.set(id, { price: merged.price ?? null, lowestPrice: merged.lowestPrice ?? null, priceStatus: merged.priceStatus, isForSale: !!merged.isForSale, isOffSale: !!merged.isOffSale, isFree: !!merged.isFree, isDeletedOrModerated: !!merged.isDeletedOrModerated });
          catalogCache.set(id, merged);
        }
        detailsMap.set(id, merged);
        continue;
      }
      // partial hit: need to fill missing half — keep in uncached to refetch but we could keep half
      // for speed we still refetch full if not both
      uncached.push(id);
    }
    if(uncached.length===0) return detailsMap;

    // 2) fingerprint skip already checked in getFullProfile; but also check snapshot cache here
    const fp = computeFingerprint(uncached);
    const snap = outfitSnapshotCache.get(fp);
    if (snap && snap.size>0) {
      // snap is for exactly this uncached set? only if same fp, reuse
      // verify all uncached ids present
      let allPresent=true;
      for (const id of uncached) if(!snap.has(id)) { allPresent=false; break; }
      if (allPresent) {
        for (const [k,v] of snap) { detailsMap.set(k,v); catalogCache.set(k,v); }
        return detailsMap;
      }
    }

    // shard-aware chunking: bucket by egress first, then chunk 30/50
    // keep 30 for catalog, 50 for develop — need separate bucketing
    const bucketByEgress = (ids:number[]): Map<number, number[]> => {
      const m=new Map<number,number[]>();
      for(const id of ids){ const shard=(id*2654435761>>>0)%EGRESS_COUNT; const a=m.get(shard)||[]; a.push(id); m.set(shard,a); }
      return m;
    };

    const parseCatalogItem = (item:{id:number;name:string;description?:string;assetType?:number;creatorName?:string;creatorTargetId?:number;creatorType?:string;price?:number|null;lowestPrice?:number|null;lowestResalePrice?:number|null;priceStatus?:string;itemRestrictions?:string[]}, fallback:string): Partial<RobloxAssetItem>=>{
      const rawPrice=item.price; // null | 0 | number
      const resalePrice=item.lowestPrice ?? item.lowestResalePrice ?? null;
      const priceStatus=item.priceStatus || '';
      const hasResale=resalePrice!=null && resalePrice>0;
      // FREE только если статус Free или price==0 без ресейла (иначе 0 + ресейл 482 = должен быть 482)
      const isFreeStatus=priceStatus==='Free';
      const isFree=isFreeStatus || (rawPrice===0 && !hasResale);
      // effectivePrice: приоритет — реальная цена >0, иначе ресейл, иначе 0 для Free
      let effectivePrice: number|null = null;
      if (isFree) effectivePrice=0;
      else if (rawPrice!=null && rawPrice>0) effectivePrice=rawPrice;
      else if (hasResale) effectivePrice=resalePrice as number;
      else if (rawPrice!=null) effectivePrice=rawPrice; // может быть null
      // ForSale: если есть хоть какая-то положительная цена (включая ресейл) или Free
      const isForSale = isFree || (effectivePrice!=null && effectivePrice>0);
      const isOffSale = !isForSale && !isFree;
      // priceStatus для ресейла нормализуем — если был OffSale но есть ресейл, считаем Resale
      const normalizedStatus = hasResale && priceStatus==='OffSale' ? 'Resale' : priceStatus;
      return { id:Number(item.id), name:item.name||`${fallback} #${item.id}`, description:item.description||'', assetType:item.assetType, assetTypeName:item.assetType?(ASSET_TYPE_MAP[item.assetType]||`Type ${item.assetType}`):fallback, creatorName:item.creatorName||'Roblox User / UGC', creatorId:item.creatorTargetId, creatorType:item.creatorType, price:effectivePrice, priceStatus:normalizedStatus||item.priceStatus, lowestPrice:resalePrice ?? null, isForSale, isOffSale, isFree, isDeletedOrModerated:false, itemRestrictions:item.itemRestrictions||[] };
    };

    const storeQuantized = (parsed: Partial<RobloxAssetItem>)=>{
      const id=parsed.id as number;
      priceVectorCache.set(id,{ price: parsed.price??null, lowestPrice: parsed.lowestPrice??null, priceStatus: parsed.priceStatus, isForSale: !!parsed.isForSale, isOffSale: !!parsed.isOffSale, isFree: !!parsed.isFree, isDeletedOrModerated: !!parsed.isDeletedOrModerated });
      metaCache.set(id,{ name: parsed.name as string, description: parsed.description as string, assetType: parsed.assetType, assetTypeName: parsed.assetTypeName, creatorName: parsed.creatorName as string, creatorId: parsed.creatorId, creatorType: parsed.creatorType, itemRestrictions: parsed.itemRestrictions });
      catalogCache.set(id, parsed);
    };

    const allTasks: Promise<void>[]=[];
    const emit = (m: Map<number,Partial<RobloxAssetItem>>)=>{ if(onChunk && m.size>0){ const copy=new Map(m); try{ onChunk(copy);}catch{} } };

    // Type1 & Type2 sharded
    const byShard = bucketByEgress(uncached);
    for (const [shard, shardIds] of byShard){
      const client=egressAxios[shard];
      const chunks30:number[][]=[];
      for(let i=0;i<shardIds.length;i+=30) chunks30.push(shardIds.slice(i,i+30));
      for (const chunk of chunks30){
        allTasks.push((async()=>{
          try{
            const res=await withRetry(()=> client.post('https://catalog.roblox.com/v1/catalog/items/details', {items: chunk.map(id=>({itemType:1,id}))}, {timeout: CATALOG_TIMEOUT, signal}));
            if(res.data?.data) for(const it of res.data.data){
              const parsed=parseCatalogItem(it,'Accessory / Wearable');
              if(!detailsMap.has(parsed.id as number)){ detailsMap.set(parsed.id as number, parsed); storeQuantized(parsed); emit(new Map([[parsed.id as number, parsed]])); }
            }
          }catch{}
        })());
        allTasks.push((async()=>{
          try{
            const res=await withRetry(()=> client.post('https://catalog.roblox.com/v1/catalog/items/details', {items: chunk.map(id=>({itemType:2,id}))}, {timeout: CATALOG_TIMEOUT, signal}));
            if(res.data?.data) for(const it of res.data.data){
              const parsed=parseCatalogItem(it,'Avatar Bundle / Pack'); parsed.assetTypeName='Avatar Bundle / Pack';
              if(!detailsMap.has(parsed.id as number)){ detailsMap.set(parsed.id as number, parsed); storeQuantized(parsed); emit(new Map([[parsed.id as number, parsed]])); }
            }
          }catch{}
        })());
      }
      // develop sharded
      const chunks50:number[][]=[];
      for(let i=0;i<shardIds.length;i+=50) chunks50.push(shardIds.slice(i,i+50));
      for (const chunk of chunks50){
        allTasks.push((async()=>{
          try{
            const res=await withRetry(()=> client.get(`https://develop.roblox.com/v1/assets?assetIds=${chunk.join(',')}`, {timeout: CATALOG_TIMEOUT, signal}));
            if(res.data?.data) for(const it of res.data.data){
              if(it.id && it.name && !detailsMap.has(Number(it.id))){
                const parsed: Partial<RobloxAssetItem> = { id:Number(it.id), name:it.name, description:it.description||'', assetTypeName:it.type||'Animation / Wearable', creatorName:it.creator?.name||'Roblox UGC Creator', creatorId:it.creator?.id, price: typeof it.price==='number'?it.price:null, isForSale:!!it.isForSale, isOffSale:!it.isForSale, isFree:it.price===0, isDeletedOrModerated:false };
                detailsMap.set(Number(it.id), parsed); storeQuantized(parsed as Partial<RobloxAssetItem>); emit(new Map([[Number(it.id), parsed]]));
              }
            }
          }catch{}
        })());
      }
      // speculative hedged economy: стартует через SPECULATIVE_DELAY_BASE параллельно каталогу, не ждёт его 403/таймаута — критично для VPN (380ms VPN vs 900ms обычн)
      for (const id of shardIds) {
        allTasks.push((async()=>{
          await new Promise(r=>setTimeout(r, SPECULATIVE_DELAY_BASE + Math.random()*300));
          if (detailsMap.has(id) || signal?.aborted) return;
          try {
            const d = await RobloxService.getEconomyAssetDetails(id, signal);
            if (d && !detailsMap.has(id)) { detailsMap.set(id, d); storeQuantized(d as Partial<RobloxAssetItem>); emit(new Map([[id,d]])); }
          } catch {}
        })());
      }
    }

    await Promise.allSettled(allTasks);
    if(signal?.aborted) return detailsMap;

    // snapshot for fingerprint dedup next time
    if (uncached.length>0) {
      // store snapshot of just the newly fetched ids
      const snapMap=new Map<number,Partial<RobloxAssetItem>>();
      for(const id of uncached){ const v=detailsMap.get(id); if(v) snapMap.set(id,v); }
      if(snapMap.size>0) outfitSnapshotCache.set(fp, snapMap);
    }

    const stillMissing=uncached.filter(id=>!detailsMap.has(id));
    if(stillMissing.length>0){
      const econTasks=stillMissing.map((id)=> async()=>{
        if(signal?.aborted) return;
        // shard economy as well — VPN быстрее с большим лимитом, но не баним (10 vs 8)
        const d=await RobloxService.getEconomyAssetDetails(id, signal);
        if(d && !detailsMap.has(id)){ detailsMap.set(id,d); emit(new Map([[id,d]])); }
      });
      await RobloxService.pLimit(econTasks, ECONOMY_PLIMIT);
    }
    return detailsMap;
  }

  public static async getGroupInfo(groupId:number, signal?:AbortSignal): Promise<{ id:number; name:string; memberCount:number; description?:string; owner?: unknown; created?:string; updated?:string } | null> {
    try {
      const res = await withRetry(()=> robloxAxios.get(`https://groups.roblox.com/v1/groups/${groupId}`, { timeout:6000, signal }));
      if (!res.data?.id) return null;
      return { id: res.data.id, name: res.data.name, memberCount: res.data.memberCount ?? 0, description: res.data.description, owner: res.data.owner, created: res.data.created, updated: res.data.updated };
    } catch { return null; }
  }

  public static async getGroupNewItems(groupId:number, limit=5, signal?:AbortSignal): Promise<{ items: { id:number; name:string; price?:number|null; isForSale?:boolean; created?:string; updated?:string }[] }> {
    try {
      // Catalog search for group's recent creations — группы как creatorType Group (2)
      const res = await withRetry(()=> {
        const client = egressForAsset(groupId);
        return client.get(`https://catalog.roblox.com/v1/search/items`, {
          params: { category: 'All', creatorTargetId: groupId, creatorType: 2, limit: Math.min(limit,10), sortType: 'RecentlyCreated', sortOrder: 'Desc' },
          timeout: CATALOG_TIMEOUT,
          signal,
        });
      });
      const data = res.data?.data ?? res.data?.items ?? [];
      const items = (Array.isArray(data) ? data : []).map((it: { id?:number; itemId?:number; name?:string; title?:string; price?:number; lowestPrice?:number; isForSale?:boolean; priceStatus?:string; created?:string; updated?:string; itemType?:number })=>({
        id: Number(it.id ?? it.itemId ?? 0),
        name: it.name ?? it.title ?? `Item #${it.id}`,
        price: it.price ?? it.lowestPrice ?? null,
        isForSale: typeof it.isForSale === 'boolean' ? it.isForSale : (it.priceStatus === 'OnSale' || it.priceStatus === 'ForSale' ? true : undefined),
        created: it.created,
        updated: it.updated,
      })).filter((x: { id:number })=> x.id>0).slice(0, limit);
      const detailTasks = items.map(item => async () => {
        const details = await RobloxService.getEconomyAssetDetails(item.id, undefined, true);
        if (!details) return;
        if (details.name) item.name = details.name;
        if ('price' in details) item.price = details.price ?? null;
        if (typeof details.isForSale === 'boolean') item.isForSale = details.isForSale;
      });
      await RobloxService.pLimit(detailTasks, 3);
      return { items };
    } catch {
      return { items: [] };
    }
  }

  public static async getAllGroupItems(groupId: number, limit = 2000, signal?: AbortSignal): Promise<{ id: number; name: string; price: number | null; isForSale: boolean | null; created?: string; updated?: string }[]> {
    try {
      const allItems: { id: number; name: string; price: number | null; isForSale: boolean | null; created?: string; updated?: string }[] = [];
      let cursor = '';
      const client = egressForAsset(groupId);
      
      while (allItems.length < limit) {
        if (signal?.aborted) break;
        const res = await withRetry(() => client.get(`https://catalog.roblox.com/v1/search/items`, {
          params: { category: 'All', creatorTargetId: groupId, creatorType: 2, limit: 120, sortType: 'RecentlyCreated', sortOrder: 'Desc', cursor: cursor || undefined },
          timeout: CATALOG_TIMEOUT,
          signal,
        }));
        
        const data = res.data?.data ?? res.data?.items ?? [];
        if (data.length === 0) break;
        
        for (const it of data) {
          const id = Number(it.id ?? it.itemId ?? 0);
          if (id <= 0) continue;
          
          allItems.push({
            id,
            name: it.name ?? it.title ?? `Item #${id}`,
            price: null,
            isForSale: null,
            created: it.created,
            updated: it.updated,
          });
        }
        
        const nextCursor = res.data?.nextPageCursor;
        if (!nextCursor) break;
        cursor = nextCursor;
      }
      
      const finalItems = allItems.slice(0, limit);
      
      // Fetch details in batches of 5 concurrent to avoid 429
      const chunks = [];
      for (let i = 0; i < finalItems.length; i += 5) chunks.push(finalItems.slice(i, i + 5));
      
      for (const chunk of chunks) {
        if (signal?.aborted) break;
        await Promise.all(chunk.map(async (item) => {
          try {
            const details = await this.getEconomyAssetDetails(item.id, signal, true);
            if (!details) return;
            // ВАЖНО: getEconomyAssetDetails возвращает нормализованные поля (name, price, isForSale, isOffSale)
            // PascalCase (Name, PriceInRobux, IsForSale) — это сырой ответ Roblox API, но мы его уже нормализовали.
            // Старый баг: проверка details.Name / PriceInRobux / IsForSale всегда была false → price оставался null и off-sale не детектился.
            const d = details as unknown as Record<string, unknown>;
            // name: сначала пробуем нормализованное, затем fallback на PascalCase если вдруг прямой кэш
            const rawName = (d['name'] ?? d['Name']) as string | undefined;
            if (typeof rawName === 'string' && rawName.length > 0) item.name = String(rawName);
            // price: нормализованное price (уже учитывает resale fix), fallback на PascalCase
            if (typeof d['price'] !== 'undefined') {
              const p = d['price'] as number | null;
              item.price = p !== null && Number.isFinite(p as number) ? Number(p) : null;
            } else if ('PriceInRobux' in d) {
              const p = d['PriceInRobux'] as number | null;
              item.price = p !== null && Number.isFinite(p as number) ? Number(p) : null;
            } else if (typeof d['lowestPrice'] !== 'undefined' && d['lowestPrice'] !== null) {
              const lp = d['lowestPrice'] as number;
              if (Number.isFinite(lp)) item.price = Number(lp);
            }
            // isForSale: нормализованное, fallback на PascalCase / isOffSale
            if (typeof d['isForSale'] === 'boolean') item.isForSale = d['isForSale'] as boolean;
            else if (typeof d['IsForSale'] === 'boolean') item.isForSale = d['IsForSale'] as boolean;
            else if (typeof d['isOffSale'] === 'boolean') item.isForSale = !(d['isOffSale'] as boolean);
            else if (typeof d['IsOffSale'] === 'boolean') item.isForSale = !(d['IsOffSale'] as boolean);
          } catch {}
        }));
      }
      
      return finalItems;
    } catch (e) {
      console.warn('[RobloxService] getAllGroupItems error:', (e as Error).message);
      return [];
    }
  }

  public static async getUserGroups(userId:number, signal?:AbortSignal): Promise<RobloxGroupMembership[]> {
    try{
      const res=await withRetry(()=> robloxAxios.get(`https://groups.roblox.com/v2/users/${userId}/groups/roles`, {timeout:7000, signal}));
      if(!res.data?.data || !Array.isArray(res.data.data)) return [];
      const rawGroups=res.data.data as {group:{id:number;name:string;memberCount:number;hasVerifiedBadge?:boolean};role:{id:number;name:string;rank:number}}[];
      const groupIds=rawGroups.map(g=>g.group.id);
      const iconMap:Record<number,string>={};
      const missingIds:number[]=[];
      for(const gid of groupIds){ const cached=groupIconCache.get(gid); if(cached) iconMap[gid]=cached; else missingIds.push(gid); }
      if(missingIds.length>0){
        // shard group icons too with etag
        const byShard=new Map<number,number[]>();
        for(const id of missingIds){ const shard=(id*2654435761>>>0)%EGRESS_COUNT; const a=byShard.get(shard)||[]; a.push(id); byShard.set(shard,a); }
        const tasks: Promise<void>[]=[];
        for (const [shard, ids] of byShard){
          const client=egressAxios[shard];
          for(let i=0;i<ids.length;i+=50){
            const chunk=ids.slice(i,i+50);
            tasks.push((async()=>{
              const etags=chunk.map(id=>groupIconEtagCache.get(id)?.etag).filter(Boolean) as string[];
              const headers: Record<string,string>={}; if(etags.length===chunk.length && etags.length>0) headers['If-None-Match']=etags.join(', ');
              try{
                const iconRes=await withRetry(()=> client.get(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${chunk.join(',')}&size=150x150&format=Png`, {timeout:7000, signal, headers: Object.keys(headers).length?headers:undefined}));
                if(iconRes.status===304){ for(const id of chunk){ const c=groupIconEtagCache.get(id); if(c) iconMap[id]=c.url; } return; }
                const etag=(iconRes.headers?.etag||iconRes.headers?.ETag||'') as string;
                if((iconRes as unknown as {data:{data:{targetId:number;imageUrl:string}[]}}).data?.data){
                  for(const item of (iconRes as unknown as {data:{data:{targetId:number;imageUrl:string}[]}}).data.data){
                    if(item.targetId && item.imageUrl){ iconMap[item.targetId]=item.imageUrl; groupIconCache.set(item.targetId,item.imageUrl); if(etag) groupIconEtagCache.set(item.targetId,{etag,url:item.imageUrl}); }
                  }
                }
              }catch{}
            })());
          }
        }
        await Promise.allSettled(tasks);
      }
      return rawGroups.map(item=>({ id:item.group.id, name:item.group.name, memberCount:item.group.memberCount||0, hasVerifiedBadge:!!item.group.hasVerifiedBadge, roleName:item.role.name, roleRank:item.role.rank, iconUrl: iconMap[item.group.id]||null }));
    }catch{ return []; }
  }

  // ── Core orchestrator (non-stream) ────────────────────────────────
  public static async getFullProfile(query:string, bypassCache=false, signal?:AbortSignal): Promise<RobloxUserProfileFull> {
    const startTime=Date.now();
    const trimmedLower=query.trim().toLowerCase();
    const coalesceKey=`${trimmedLower}:${bypassCache?'fresh':'cache'}`;
    if(!bypassCache){
      const hit=profileCache.get(trimmedLower);
      if(hit) {
        // если в кэше есть DELETED (старый VPN-таймаут) — инвалидируем, форсим свежий фетч для этих 3 вещей и им подобных
        const hasStaleDeleted = hit.outfit.items.some(i=>i.isDeletedOrModerated);
        if (hasStaleDeleted) {
          profileCache.delete(trimmedLower);
        } else {
          return {...hit, telemetry:{...hit.telemetry, cached:true, responseTimeMs: Date.now()-startTime}};
        }
      }
      const pending=pendingProfiles.get(coalesceKey);
      if(pending) return pending;
    }
    const task=(async(): Promise<RobloxUserProfileFull>=>{
      const user=await this.resolveUser(query, signal);
      if(signal?.aborted) throw new DOMException('Aborted','AbortError');
      const [equippedAssets, thumbnails, groups]=await Promise.all([ this.getEquippedAssets(user.id, signal), this.getAvatarThumbnails(user.id, signal), this.getUserGroups(user.id, signal) ]);
      if(signal?.aborted) throw new DOMException('Aborted','AbortError');
      const assetIds=equippedAssets.map(a=>a.id);
      const fp=computeFingerprint(assetIds);
      // 2️⃣ Fingerprint Skip: if fp unchanged vs last fetch for this user, reuse snapshot and skip catalog network
      let catalogDetailsMap: Map<number,Partial<RobloxAssetItem>>;
      let assetThumbnailMap: Record<number,string>;
      const cachedFp=outfitFingerprintCache.get(String(user.id));
      const snap=outfitSnapshotCache.get(fp);
      const canSkip = !bypassCache && cachedFp===fp && snap && assetIds.every(id=> snap.has(id) || catalogCache.has(id) || (priceVectorCache.has(id) && metaCache.has(id)));
      if (canSkip) {
        // reconstruct map from snapshot + caches
        catalogDetailsMap=new Map<number,Partial<RobloxAssetItem>>();
        for(const id of assetIds){
          const v=snap?.get(id) || catalogCache.get(id);
          if(v) catalogDetailsMap.set(id,v);
          else {
            const pv=priceVectorCache.get(id), mv=metaCache.get(id);
            if(pv && mv) catalogDetailsMap.set(id, {id, ...pv, ...mv} as Partial<RobloxAssetItem>);
          }
        }
        assetThumbnailMap=await this.getAssetThumbnails(assetIds, signal);
      } else {
        [catalogDetailsMap, assetThumbnailMap]=await Promise.all([ this.getCatalogDetails(assetIds, signal), this.getAssetThumbnails(assetIds, signal) ]);
        outfitFingerprintCache.set(String(user.id), fp);
      }
      if(signal?.aborted) throw new DOMException('Aborted','AbortError');
      let totalValueRobux=0, offSaleCount=0, freeCount=0, pricedCount=0;
      const items: RobloxAssetItem[] = equippedAssets.map((baseAsset)=>{
        const assetId=baseAsset.id; const catalogData=catalogDetailsMap.get(assetId); const thumbUrl=assetThumbnailMap[assetId]||null;
        const rawResolvedName=catalogData?.name||baseAsset.name; const isArchivedMarker=typeof rawResolvedName==='string' && rawResolvedName.startsWith(ARCHIVED_PREFIX);
        const displayName=isArchivedMarker?`Asset #${assetId}`:rawResolvedName; // hasValidName только для имени, не для DELETED флага
        // УНИКАЛЬНОЕ ИСПРАВЛЕНИЕ VPN: DELETED только при явном 404-маркере, а не при таймауте. Иначе VPN с медленным инетом помечал все как удалённые
        const isDeletedOrModerated=catalogData?.isDeletedOrModerated===true;
        // resilient price resolve: исправляет старый кэш где 76692407 был FREE 0 вместо ресейла 482
        let price: number|null = (catalogData?.price as number|null) ?? null;
        const lowest = (catalogData?.lowestPrice as number|null) ?? null;
        const hasResale = lowest!=null && lowest>0;
        let catalogIsFree = catalogData?.isFree===true;
        // СТАРЫЙ КЭШ: FREE 0 + resale 482 — считаем это не FREE, а ресейл (перекрываем даже если isFree=true)
        if (price===0 && hasResale) { price = lowest; catalogIsFree = false; }
        else if ((price==null) && hasResale) { price = lowest; catalogIsFree = false; }
        const isFree = catalogIsFree || price===0;
        // если есть ресейл-цена, считаем forSale даже при OffSale
        const isForSale=!isDeletedOrModerated && (isFree || (price!==null && price>0) || (hasResale && (catalogData?.isForSale===true || catalogData?.priceStatus==='Resale')) || catalogData?.isForSale===true);
        const isOffSale=!isForSale && !isFree;
        if(price!=null && price>0){ totalValueRobux+=price; pricedCount++; } else if(isFree) freeCount++; else offSaleCount++;
        const finalName=displayName||`Asset #${assetId}`; const resolvedTypeName=catalogData?.assetTypeName||baseAsset.assetTypeName||(baseAsset.assetType?ASSET_TYPE_MAP[baseAsset.assetType]:'Wearable Asset');
        let effectivePriceStatus = catalogData?.priceStatus;
        if (!effectivePriceStatus) effectivePriceStatus = isFree ? 'Free' : isOffSale ? 'OffSale' : 'Resale';
        else if (hasResale && effectivePriceStatus==='OffSale') effectivePriceStatus='Resale';
        return { id:assetId, name:finalName, description:catalogData?.description||'Equipped on avatar.', assetType:catalogData?.assetType||baseAsset.assetType, assetTypeName:resolvedTypeName, creatorName:catalogData?.creatorName||'Roblox UGC Creator', creatorId:catalogData?.creatorId, creatorType:catalogData?.creatorType, price, priceStatus:effectivePriceStatus, lowestPrice:lowest ?? null, isForSale, isOffSale, isDeletedOrModerated, isFree, itemRestrictions:catalogData?.itemRestrictions||[], thumbnailUrl:thumbUrl, studioLuaCommand:`game:GetService("InsertService"):LoadAsset(${assetId}).Parent = workspace`, catalogUrl:`https://www.roblox.com/catalog/${assetId}` };
      });
      const fullProfile: RobloxUserProfileFull = { user, thumbnails, outfit:{ totalValueRobux, hasOffSaleItems: offSaleCount>0, offSaleCount, freeCount, pricedCount, itemCount: items.length, items }, groups, telemetry:{ cached:false, timestamp: Date.now(), responseTimeMs: Date.now()-startTime, wearingAssetCount: items.length, fingerprint: fp, egressShards: EGRESS_COUNT } };
      profileCache.set(trimmedLower, fullProfile);
      const canonicalLower=user.name.toLowerCase(); if(canonicalLower!==trimmedLower) profileCache.set(canonicalLower, fullProfile);
      const idKey=String(user.id); if(idKey!==trimmedLower && idKey!==canonicalLower) profileCache.set(idKey, fullProfile);
      return fullProfile;
    })();
    if(!bypassCache){ pendingProfiles.set(coalesceKey, task); try{ const res=await task; return res;} finally{ pendingProfiles.delete(coalesceKey);} } else return task;
  }

  // ── 3️⃣ SSE Streaming: incremental valuation ────────────────────────
  public static async streamFullProfile(query:string, signal: AbortSignal, onEvent:(event:string, data:unknown)=>void): Promise<void> {
    const startTime=Date.now();
    const send=(ev:string, data:unknown)=>{ try{ onEvent(ev,data);}catch{} };
    const user=await this.resolveUser(query, signal);
    send('user', { user, fingerprint: undefined });
    if(signal.aborted) throw new DOMException('Aborted','AbortError');
    const equippedPromise=this.getEquippedAssets(user.id, signal);
    const thumbPromise=this.getAvatarThumbnails(user.id, signal);
    const groupsPromise=this.getUserGroups(user.id, signal);
    const [equippedAssets, thumbnails, groups]=await Promise.all([equippedPromise, thumbPromise, groupsPromise]);
    send('equipped', { count: equippedAssets.length, assetIds: equippedAssets.map(a=>a.id) });
    send('thumbnails', thumbnails);
    send('groups', { count: groups.length });
    if(signal.aborted) throw new DOMException('Aborted','AbortError');
    const assetIds=equippedAssets.map(a=>a.id);
    const fp=computeFingerprint(assetIds);
    send('fingerprint', { fingerprint: fp, egressShards: EGRESS_COUNT });
    // thumbnails for assets streamed too
    const thumbPromise2=this.getAssetThumbnails(assetIds, signal).then(m=>{ send('assetThumbnails', { count: Object.keys(m).length }); return m; });
    // incremental catalog
    let runningValue=0; let runningPriced=0; let runningFree=0; let runningOff=0;
    const seen=new Set<number>();
    const catalogMap=new Map<number,Partial<RobloxAssetItem>>();
    const onChunk=(partial: Map<number,Partial<RobloxAssetItem>>)=>{
      for(const [id, data] of partial){
        if(seen.has(id)) continue; seen.add(id);
        catalogMap.set(id,data);
        let p = (data.price as number|null) ?? null;
        const low = (data.lowestPrice as number|null) ?? null;
        const hasResale = low!=null && low>0;
        let isF = !!data.isFree;
        if (p===0 && hasResale) { p = low; isF = false; }
        else if (p==null && hasResale) { p = low; isF = false; }
        else isF = isF || p===0;
        if(p!=null && p>0){ runningValue+=p; runningPriced++; }
        else if(isF) runningFree++;
        else runningOff++;
      }
      send('valuation', { totalValueRobux: runningValue, pricedCount: runningPriced, freeCount: runningFree, offSaleCount: runningOff, seen: seen.size, total: assetIds.length });
      // send chunk items
      const itemsChunk=Array.from(partial.entries()).map(([id,d])=>({ id, name: d.name, price: d.price ?? d.lowestPrice ?? null, isFree: d.isFree }));
      send('chunk', { items: itemsChunk });
    };
    const catalogPromise=this.getCatalogDetails(assetIds, signal, onChunk);
    const [assetThumbnailMap, catalogDetailsMap]=await Promise.all([thumbPromise2, catalogPromise]);
    // final assembly (same as getFullProfile) — resilient resale fix
    let totalValueRobux=0, offSaleCount=0, freeCount=0, pricedCount=0;
    const items: RobloxAssetItem[] = equippedAssets.map((baseAsset)=>{
      const assetId=baseAsset.id; const catalogData=catalogDetailsMap.get(assetId); const thumbUrl=assetThumbnailMap[assetId]||null;
      const rawResolvedName=catalogData?.name||baseAsset.name; const isArchivedMarker=typeof rawResolvedName==='string' && rawResolvedName.startsWith(ARCHIVED_PREFIX);
      const displayName=isArchivedMarker?`Asset #${assetId}`:rawResolvedName;
      const isDeletedOrModerated=catalogData?.isDeletedOrModerated===true;
      let price: number|null = (catalogData?.price as number|null) ?? null;
      const lowest = (catalogData?.lowestPrice as number|null) ?? null;
      const hasResale = lowest!=null && lowest>0;
      let catalogIsFree = catalogData?.isFree===true;
      if (price===0 && hasResale) { price = lowest; catalogIsFree = false; }
      else if (price==null && hasResale) { price = lowest; catalogIsFree = false; }
      const isFree = catalogIsFree || price===0;
      const isForSale=!isDeletedOrModerated && (isFree || (price!==null && price>0) || (hasResale && (catalogData?.isForSale===true || catalogData?.priceStatus==='Resale')) || catalogData?.isForSale===true);
      const isOffSale=!isForSale && !isFree;
      if(price!=null && price>0){ totalValueRobux+=price; pricedCount++; } else if(isFree) freeCount++; else offSaleCount++;
      const finalName=displayName||`Asset #${assetId}`; const resolvedTypeName=catalogData?.assetTypeName||baseAsset.assetTypeName||(baseAsset.assetType?ASSET_TYPE_MAP[baseAsset.assetType]:'Wearable Asset');
      let effectivePriceStatus = catalogData?.priceStatus;
      if (!effectivePriceStatus) effectivePriceStatus = isFree ? 'Free' : isOffSale ? 'OffSale' : 'Resale';
      else if (hasResale && effectivePriceStatus==='OffSale') effectivePriceStatus='Resale';
      return { id:assetId, name:finalName, description:catalogData?.description||'Equipped on avatar.', assetType:catalogData?.assetType||baseAsset.assetType, assetTypeName:resolvedTypeName, creatorName:catalogData?.creatorName||'Roblox UGC Creator', creatorId:catalogData?.creatorId, creatorType:catalogData?.creatorType, price, priceStatus:effectivePriceStatus, lowestPrice:lowest ?? null, isForSale, isOffSale, isDeletedOrModerated, isFree, itemRestrictions:catalogData?.itemRestrictions||[], thumbnailUrl:thumbUrl, studioLuaCommand:`game:GetService("InsertService"):LoadAsset(${assetId}).Parent = workspace`, catalogUrl:`https://www.roblox.com/catalog/${assetId}` };
    });
    const fullProfile: RobloxUserProfileFull = { user, thumbnails, outfit:{ totalValueRobux, hasOffSaleItems: offSaleCount>0, offSaleCount, freeCount, pricedCount, itemCount: items.length, items }, groups, telemetry:{ cached:false, timestamp: Date.now(), responseTimeMs: Date.now()-startTime, wearingAssetCount: items.length, fingerprint: fp, egressShards: EGRESS_COUNT } };
    send('done', fullProfile);
  }
}
