import fs from 'node:fs';
import path from 'node:path';

// Лёгкое хранилище для связки сайт ↔ Discord
// Локально: файл server/data/folderSync.json (персистент на диске)
// На Vercel (REDIS_URL/STORAGE_URL): Redis Cloud (персистент serverless, иначе FS эфемерный)
type Store = {
  version?: number;
  links: Record<string, string>;
  reverseLinks: Record<string, string>;
  tracked: Record<string, { lastItemId: number | null; lastChecked: number; itemStates?: Record<string, { name: string; price: number | null; isForSale: boolean | null }> }>;
  subscriptions: Record<string, string[]>;
  groupRoblox: Record<string, string>;
  groupMeta?: Record<string, { name: string; memberCount: number; iconUrl?: string }>;
};

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const DATA_FILE = path.join(DATA_DIR, 'folderSync.json');
const REDIS_KEY = 'wornby:folderSync';
const REDIS_URL = process.env.REDIS_URL || process.env.STORAGE_URL || process.env.STORAGE_REDIS_URL || process.env.KV_URL || process.env.KV_REDIS_URL || process.env.REDIS_PRIVATE_URL || process.env.REDIS_TLS_URL || (process.env.KV_REST_API_URL ? 'kv_rest' : '') || '';

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function loadFromFile(): Store {
  ensureDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const store: Store = {
        version: 2,
        links: parsed.links || {},
        reverseLinks: parsed.reverseLinks || {},
        tracked: parsed.tracked || {},
        subscriptions: parsed.subscriptions || {},
        groupRoblox: parsed.groupRoblox || {},
        groupMeta: parsed.groupMeta || {},
      };
      for (const [gid, subscribers] of Object.entries(store.subscriptions)) {
        const personal = subscribers.filter(id => /^\d{17,20}$/.test(id));
        if (personal.length > 0) store.subscriptions[gid] = personal;
        else {
          delete store.subscriptions[gid];
          delete store.tracked[gid];
          delete store.groupRoblox[gid];
        }
      }
      for (const gid of Object.keys(store.tracked)) {
        if (!store.subscriptions[gid]) {
          delete store.tracked[gid];
          delete store.groupRoblox[gid];
        }
      }
      return store;
    }
  } catch {}
  return { version: 2, links: {}, reverseLinks: {}, tracked: {}, subscriptions: {}, groupRoblox: {}, groupMeta: {} };
}

function cloneStore(s: Store): Store {
  return JSON.parse(JSON.stringify(s));
}

// ── Redis lazy client (only on Vercel / Railway / when REDIS_URL set) ───────────────
let redisClient: any = null;
let redisReady: Promise<any> | null = null;
async function getRedis(): Promise<any | null> {
  if (!REDIS_URL) return null;
  if (redisClient) return redisClient;
  if (redisReady) return redisReady;
  redisReady = (async () => {
    try {
      const { createClient } = await import('redis');
      const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 5000 } });
      client.on('error', (e: unknown) => console.warn('[folderStore] redis error', (e as Error).message));
      await client.connect();
      redisClient = client;
      return client;
    } catch (e) {
      console.warn('[folderStore] redis connect failed, fallback to file', (e as Error).message);
      return null;
    }
  })();
  return redisReady;
}

let store: Store | null = REDIS_URL ? null : loadFromFile();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loaded = !REDIS_URL;
let lastRedisFetch = 0;
const REDIS_CACHE_TTL_MS = 5000; // Кэш в памяти на 5 сек — гарантирует, что бот на Railway видит новые группы с сайта без рестарта

if (!REDIS_URL && process.env.VERCEL) {
  console.warn('[folderStore] REDIS_URL/STORAGE_URL not set on VERCEL — file storage is ephemeral, tracked groups will be lost after each deploy/lambda restart. Set Upstash Redis URL to fix.');
}

async function ensureLoaded(): Promise<Store> {
  // Для локального режима без Redis
  if (!REDIS_URL && store && loaded) return store;

  // Если Redis есть и кэш еще свежий (< 5 сек)
  if (REDIS_URL && store && loaded && (Date.now() - lastRedisFetch < REDIS_CACHE_TTL_MS)) {
    return store;
  }

  if (REDIS_URL) {
    try {
      const redis = await getRedis();
      if (redis) {
        const raw = await redis.get(REDIS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          store = {
            version: 2,
            links: parsed.links || {},
            reverseLinks: parsed.reverseLinks || {},
            tracked: parsed.tracked || {},
            subscriptions: parsed.subscriptions || {},
            groupRoblox: parsed.groupRoblox || {},
            groupMeta: parsed.groupMeta || {},
          };
          loaded = true;
          lastRedisFetch = Date.now();
          return store!;
        }
      }
    } catch (e) {
      console.warn('[folderStore] redis read error', (e as Error).message);
    }
    // fallback to file if redis empty/error
    if (!store) store = loadFromFile();
    loaded = true;
    lastRedisFetch = Date.now();
    // prime redis from file if had data
    if (store && Object.keys(store.tracked).length > 0) {
      try { const r = await getRedis(); if (r) await r.set(REDIS_KEY, JSON.stringify(store)); } catch {}
    }
    return store!;
  }
  // file mode already loaded
  if (!store) store = loadFromFile();
  loaded = true;
  return store!;
}

function saveToFileImmediate(s: Store) {
  try {
    ensureDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2), 'utf-8');
    try { fs.chmodSync(DATA_FILE, 0o600); } catch {}
  } catch {}
}

async function saveImmediate(): Promise<void> {
  if (!store) return;
  lastRedisFetch = Date.now();
  if (REDIS_URL) {
    try {
      const redis = await getRedis();
      if (redis) {
        await redis.set(REDIS_KEY, JSON.stringify(store));
        return;
      }
    } catch (e) {
      console.warn('[folderStore] redis save error', (e as Error).message);
    }
  }
  saveToFileImmediate(store);
}

function save(): void {
  if (REDIS_URL) {
    // на Vercel serverless — сразу в Redis, без дебаунса (функция может умереть)
    saveImmediate().catch(()=>{});
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveImmediate().catch(()=>{}); }, 300);
}

function flush(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // fire-and-forget для Redis, sync для файла уже в saveImmediate
  saveImmediate().catch(()=>{});
  // для файла — синхронный fallback если redis не успел
  if (!REDIS_URL && store) saveToFileImmediate(store);
}

try {
  process.on('SIGINT', () => { flush(); });
  process.on('SIGTERM', () => { flush(); });
  process.on('beforeExit', () => { flush(); });
} catch {}

export const folderStore = {
  async link(discordUserId: string, robloxUsername: string) {
    const s = await ensureLoaded();
    const lower = robloxUsername.toLowerCase();
    const oldDiscord = s.reverseLinks[lower];
    if (oldDiscord && oldDiscord !== discordUserId) delete s.links[oldDiscord];
    const oldRoblox = s.links[discordUserId];
    if (oldRoblox && oldRoblox !== lower) delete s.reverseLinks[oldRoblox];
    s.links[discordUserId] = lower;
    s.reverseLinks[lower] = discordUserId;
    for (const gid of Object.keys(s.groupRoblox)) {
      if (s.groupRoblox[gid] === lower) {
        if (!s.subscriptions[gid]) s.subscriptions[gid] = [];
        if (!s.subscriptions[gid].includes(discordUserId)) s.subscriptions[gid].push(discordUserId);
      }
    }
    save();
  },
  async unlink(discordUserId: string) {
    const s = await ensureLoaded();
    const roblox = s.links[discordUserId];
    if (roblox) delete s.reverseLinks[roblox];
    delete s.links[discordUserId];
    for (const gid of Object.keys(s.subscriptions)) {
      s.subscriptions[gid] = s.subscriptions[gid].filter(id => id !== discordUserId);
      if (s.subscriptions[gid].length === 0) delete s.subscriptions[gid];
    }
    save();
  },
  async getDiscordForRoblox(robloxUsername: string): Promise<string | null> {
    const s = await ensureLoaded();
    return s.reverseLinks[robloxUsername.toLowerCase()] ?? null;
  },
  async getRobloxForDiscord(discordUserId: string): Promise<string | null> {
    const s = await ensureLoaded();
    return s.links[discordUserId] ?? null;
  },
  async getGroupRoblox(groupId: number): Promise<string | null> {
    const s = await ensureLoaded();
    return s.groupRoblox[String(groupId)] ?? null;
  },
  async track(groupId: number, discordUserId?: string, robloxUsername?: string) {
    const s = await ensureLoaded();
    const gid = String(groupId);
    if (!s.tracked[gid]) s.tracked[gid] = { lastItemId: null, lastChecked: Date.now() };
    if (robloxUsername) s.groupRoblox[gid] = robloxUsername.toLowerCase();
    if (discordUserId) {
      if (!s.subscriptions[gid]) s.subscriptions[gid] = [];
      if (!s.subscriptions[gid].includes(discordUserId)) s.subscriptions[gid].push(discordUserId);
    } else if (robloxUsername) {
      const linked = s.reverseLinks[robloxUsername.toLowerCase()];
      if (linked) {
        if (!s.subscriptions[gid]) s.subscriptions[gid] = [];
        if (!s.subscriptions[gid].includes(linked)) s.subscriptions[gid].push(linked);
      }
    }
    save();
  },
  async untrack(groupId: number, discordUserId?: string) {
    const s = await ensureLoaded();
    const gid = String(groupId);
    if (discordUserId) {
      if (s.subscriptions[gid]) {
        s.subscriptions[gid] = s.subscriptions[gid].filter(id => id !== discordUserId);
        if (s.subscriptions[gid].length === 0) delete s.subscriptions[gid];
      }
    } else {
      delete s.subscriptions[gid];
      delete s.tracked[gid];
    }
    save();
  },
  async getTrackedGroupIds(): Promise<number[]> {
    const s = await ensureLoaded();
    return Object.keys(s.tracked).map(n=>Number(n)).filter(n=>Number.isFinite(n));
  },
  async getSubscribers(groupId: number): Promise<string[]> {
    const s = await ensureLoaded();
    return s.subscriptions[String(groupId)] ?? [];
  },
  async getLastItemId(groupId: number): Promise<number | null> {
    const s = await ensureLoaded();
    return s.tracked[String(groupId)]?.lastItemId ?? null;
  },
  async setLastItemId(groupId: number, itemId: number) {
    const s = await ensureLoaded();
    const gid = String(groupId);
    if (!s.tracked[gid]) s.tracked[gid] = { lastItemId: itemId, lastChecked: Date.now() };
    else { s.tracked[gid].lastItemId = itemId; s.tracked[gid].lastChecked = Date.now(); }
    save();
  },
  async getItemStates(groupId: number): Promise<Record<string, { name: string; price: number | null; isForSale: boolean | null }>> {
    const s = await ensureLoaded();
    return s.tracked[String(groupId)]?.itemStates ?? {};
  },
  async setItemStates(groupId: number, states: Record<string, { name: string; price: number | null; isForSale: boolean | null }>) {
    const s = await ensureLoaded();
    const gid = String(groupId);
    if (!s.tracked[gid]) s.tracked[gid] = { lastItemId: null, lastChecked: Date.now() };
    s.tracked[gid].itemStates = states;
    s.tracked[gid].lastChecked = Date.now();
    save();
  },
  async getGroupMeta(groupId: number): Promise<{ name: string; memberCount: number; iconUrl?: string } | null> {
    const s = await ensureLoaded();
    return s.groupMeta?.[String(groupId)] ?? null;
  },
  async setGroupMeta(groupId: number, meta: { name: string; memberCount: number; iconUrl?: string }) {
    const s = await ensureLoaded();
    if (!s.groupMeta) s.groupMeta = {};
    s.groupMeta[String(groupId)] = {
      name: meta.name,
      memberCount: meta.memberCount,
      iconUrl: meta.iconUrl,
    };
    save();
  },
  async setGroupMetasBulk(metas: { id: number; name: string; memberCount: number; iconUrl?: string }[]) {
    const s = await ensureLoaded();
    if (!s.groupMeta) s.groupMeta = {};
    for (const m of metas) {
      if (!m.id) continue;
      s.groupMeta[String(m.id)] = {
        name: m.name,
        memberCount: m.memberCount,
        iconUrl: m.iconUrl,
      };
    }
    save();
  },
  async getAllGroupMetas(): Promise<Record<string, { name: string; memberCount: number; iconUrl?: string }>> {
    const s = await ensureLoaded();
    return s.groupMeta ?? {};
  },
  async getStore(): Promise<Store> {
    const s = await ensureLoaded();
    return cloneStore(s);
  },
  // sync fallback for legacy callers (local dev without Redis) — не использовать на Vercel
  getStoreSync(): Store {
    if (store) return cloneStore(store);
    return loadFromFile();
  },
  flush,
  _saveImmediate: saveImmediate,
  _ensureLoaded: ensureLoaded,
};
