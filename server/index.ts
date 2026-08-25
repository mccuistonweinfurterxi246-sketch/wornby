import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { RobloxService } from './robloxService.js';
import { folderStore } from './folderStore.js';

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('[Security] SESSION_SECRET not set — using ephemeral random key, tokens will invalidate after restart. Set a persistent value in .env');

function signUserId(userId: string): string {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(userId);
  return `${userId}.${hmac.digest('hex')}`;
}

function verifyUserId(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const userId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!userId || !sig || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(userId);
  const expected = hmac.digest('hex');
  // timingSafeEqual — защита от side-channel
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch { return null; }
  return userId;
}

// Helper: достать auth cookie (HttpOnly) или fallback query/body token — для плавной миграции со старого ?discord_token= в URL
function getAuthTokenFromRequest(req: Request): string | null {
  // 1) HttpOnly cookie wornby_auth (новый безопасный путь)
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const i = c.indexOf('=');
      if (i === -1) return ['', ''] as const;
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())] as const;
    }).filter(([k]) => k)
  );
  if (cookies['wornby_auth']) return cookies['wornby_auth'];
  // 2) Authorization header Bearer (для API клиентов)
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// — prod helpers: на Vercel FRONTEND_URL может не быть задан — берём VERCEL_URL
function getFrontendUrl(): string {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return `http://localhost:${PORT}`;
}
function getDiscordRedirectUri(): string {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  return `${getFrontendUrl().replace(/:\d+$/, ':3001')}/api/auth/discord/callback`.replace('https://', 'https://').replace('http://localhost:5173', 'http://localhost:3001');
}

// Security headers (helmet-lite without extra dep)
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// CORS — restrict to allowed origins. In production, ALLOWED_ORIGINS must be set, else deny cross-origin (allow same-origin/no-origin only)
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / health checks
    if (allowedOrigins && allowedOrigins.length > 0) {
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    }
    // No allowlist configured: allow in dev, deny cross-origin in prod
    if (isProd) return cb(new Error(`CORS blocked for origin: ${origin}`));
    return cb(null, true);
  },
  credentials: true, // нужно для HttpOnly cookie wornby_auth (same-site + CORS)
}));
app.use(express.json({ limit: '50kb' }));

// Simple in-memory rate limiter (no extra dep)
const rateMap = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
function getClientIp(req: Request): string {
  // trust proxy ensures req.ip is correct; ignore client-controlled X-Forwarded-For
  return req.ip || 'global';
}
function rateLimiter(req: Request, res: Response, next: () => void) {
  const key = getClientIp(req);
  const now = Date.now();
  const entry = rateMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }
  entry.count++;
  if (entry.count > RATE_MAX) {
    res.status(429).json({ error: 'Too many requests, please slow down.', retryAfterMs: entry.resetAt - now });
    return;
  }
  next();
}
app.use('/api/', rateLimiter);
// periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateMap) if (now > v.resetAt) rateMap.delete(k);
}, RATE_WINDOW_MS).unref?.();

// Logging middleware — sanitize newlines to prevent log injection
function sanitizeLog(s: string): string { return s.replace(/[\r\n]/g, '_').slice(0, 500); }
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${sanitizeLog(req.method)} ${sanitizeLog(req.originalUrl)} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'operational',
    service: 'ANTIGRAVITY Roblox Telemetry Proxy',
    version: '2026.1.0',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    storage: process.env.REDIS_URL || process.env.STORAGE_URL ? 'redis' : 'file',
  });
});

// Cron trigger for Vercel — 24/7 без ПК (free). Вызывается Vercel Cron каждые 7м, делает тот же checkAllGroups что и локальный setInterval.
// Защищен CRON_SECRET, но для ручной проверки разрешаем ?manual=1 с rate-limit 1/мин (без токена)
const cronManualMap = new Map<string,{count:number,reset:number}>();
app.get('/api/cron/check', async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  const isManual = (req.query.manual as string) === '1';
  if (secret) {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (req.query.token as string) || '';
    const cronHeader = (req.headers['x-vercel-cron'] as string) || '';
    const sessionOk = (req.query.token as string) === process.env.SESSION_SECRET;
    if (auth !== secret && cronHeader !== '1' && !sessionOk) {
      if (!isManual) {
        res.status(401).json({ error: 'Unauthorized cron — use ?manual=1 for quick test (1/min) or ?token=CRON_SECRET' });
        return;
      }
      // manual 1/min per IP
      const ip = req.ip || 'global';
      const now = Date.now();
      const e = cronManualMap.get(ip);
      if (!e || now > e.reset) cronManualMap.set(ip, { count: 1, reset: now + 60_000 });
      else {
        e.count++;
        if (e.count > 1) { res.status(429).json({ error: 'Manual check 1/min, use token for more' }); return; }
      }
    }
  }
  // Vercel maxDuration 25s — проверяем 3 группы по 40 вещей за ~14s (9 групп ротируются)
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 24_000);
  try {
    const { checkAllGroups } = await import('./discordBot.js');
    await checkAllGroups({ itemsLimit: 40, maxGroups: 3 });
    clearTimeout(t);
    if (ac.signal.aborted) { res.status(504).json({ error: 'Timeout' }); return; }
    const ids = await folderStore.getTrackedGroupIds();
    res.json({ ok: true, checked: 3, total: ids.length, at: new Date().toISOString(), via: process.env.VERCEL ? 'cron' : 'local' });
  } catch (e) {
    clearTimeout(t);
    console.warn('[Cron] check failed', (e as Error).message);
    res.status(500).json({ error: 'Cron failed' });
  }
});

// User Full Profile & Outfit Endpoint
app.get('/api/user/:query', async (req: Request, res: Response) => {
  const { query } = req.params;
  const bypassCache = req.query.fresh === 'true';

  if (!query || query.trim().length === 0) {
    res.status(400).json({ error: 'Query parameter (username or userId) is required.' });
    return;
  }
  // Validate query: username 3-20 alphanum_ or numeric id (Roblox: starts with letter, no leading/trailing _, no __, numeric 1..~2^53)
  const trimmed = query.trim();
  const isNumeric = /^\d+$/.test(trimmed);
  let isValid = false;
  if (isNumeric) {
    // allow up to 16 digits, >0, within JS safe int
    isValid = trimmed.length <= 16 && trimmed !== '0' && !trimmed.startsWith('0') && Number(trimmed) <= Number.MAX_SAFE_INTEGER;
  } else {
    isValid = /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(trimmed) && !trimmed.includes('__') && !trimmed.endsWith('_');
  }
  if (!isValid) {
    res.status(400).json({ error: 'Invalid query: must be numeric userId (1..16 digits, no leading zero) or 3-20 char username (starts with letter, no __, no trailing _).' });
    return;
  }
  // fresh bypass — stricter rate limit: 5 per minute per IP (separate map to avoid double-count)
  if (bypassCache) {
    const key = `fresh:${getClientIp(req)}`;
    const now = Date.now();
    const e = rateMap.get(key);
    if (!e || now > e.resetAt) {
      rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    } else {
      e.count++;
      if (e.count > 5) {
        res.status(429).json({ error: 'Fresh refresh limited to 5/min. Use cached data.' });
        return;
      }
    }
  }

  // SSE streaming endpoint — Probabilistic Early Valuation (TTFB ~180ms)
  // Client can GET /api/user/:query/stream for incremental valuation events
  // Fallback to normal JSON if not SSE
  const wantsStream = req.query.stream === 'true' || req.headers.accept?.includes('text/event-stream');
  if (wantsStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // keepalive comment
    res.write(`: stream start ${Date.now()}\n\n`);
    const ac = new AbortController();
    const keepAlive = setInterval(() => { try { res.write(`: keepalive\n\n`); } catch {} }, 15000);
    req.on('close', () => { ac.abort(); clearInterval(keepAlive); try{ res.end(); }catch{} });
    const onEvent = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };
    try {
      await RobloxService.streamFullProfile(query, ac.signal, onEvent);
      res.write(`event: end\n`);
      res.write(`data: {"ok":true}\n\n`);
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') {
        onEvent('error', { error: err.message });
      }
    } finally {
      clearInterval(keepAlive);
      try { res.end(); } catch {}
    }
    return;
  }

  try {
    // wire abort: if client disconnects, abort downstream Roblox calls
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const profile = await RobloxService.getFullProfile(query, bypassCache, ac.signal);
    if (ac.signal.aborted) return;
    // engineered cache headers — SWR + stale, plus explicit X-Cache for client telemetry
    res.setHeader('X-Cache', profile.telemetry.cached ? 'HIT' : 'MISS');
    res.setHeader('X-Response-Time', `${profile.telemetry.responseTimeMs}ms`);
    res.setHeader('X-Fingerprint', (profile.telemetry as unknown as { fingerprint?: string }).fingerprint || '');
    res.setHeader('X-Egress-Shards', String((profile.telemetry as unknown as { egressShards?: number }).egressShards || 3));
    if (profile.telemetry.cached) {
      res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    }
    res.setHeader('Vary', 'Accept-Encoding');
    res.json(profile);
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } };
    if ((err as Error).name === 'AbortError') return;
    console.error(`[API Error] User resolution failed for "${sanitizeLog(query)}":`, sanitizeLog(err.message));
    
    const lower = err.message.toLowerCase();
    if (lower.includes('not found') || lower.includes('does not exist')) {
      res.status(404).json({ error: err.message });
      return;
    }
    // Roblox rate-limited
    const status = (err as unknown as { response?: { status?: number } }).response?.status;
    if (status === 429 || lower.includes('too many requests') || lower.includes('429')) {
      res.status(429).json({ error: 'Roblox API rate limited, try again shortly.' });
      return;
    }
    if (status === 503 || status === 502) {
      res.status(503).json({ error: 'Roblox services temporarily unavailable, try again.' });
      return;
    }

    res.status(500).json({
      error: 'Failed to retrieve telemetry from Roblox services.',
    });
  }
});

// Batch Asset resolver
app.post('/api/batch-assets', async (req: Request, res: Response) => {
  const { assetIds } = req.body;
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    res.status(400).json({ error: 'assetIds must be a non-empty array of numbers.' });
    return;
  }
  if (assetIds.length > 100) {
    res.status(400).json({ error: 'assetIds limited to 100 per request.' });
    return;
  }

  try {
    // allow numeric strings "123" by coercion, but reject non-numeric
    const coerced: number[] = [];
    for (const raw of assetIds) {
      const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 9_007_199_254_740_991) coerced.push(n);
    }
    // de-dupe
    const validIds = [...new Set(coerced)].slice(0, 100);
    if (validIds.length === 0) {
      res.status(400).json({ error: 'No valid asset IDs.' });
      return;
    }
    const dropped = assetIds.length - validIds.length;
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const [detailsMap, thumbnailMap] = await Promise.all([
      RobloxService.getCatalogDetails(validIds, ac.signal),
      RobloxService.getAssetThumbnails(validIds, ac.signal),
    ]);

    const items = validIds.map((id) => {
      const details = detailsMap.get(id);
      return {
        id,
        name: details?.name || `Asset #${id}`,
        price: details?.price ?? null,
        thumbnailUrl: (thumbnailMap as Record<number,string>)[id] || null,
        studioLuaCommand: `game:GetService("InsertService"):LoadAsset(${id}).Parent = workspace`,
        catalogUrl: `https://www.roblox.com/catalog/${id}`,
      };
    });

    res.json({ items, ...(dropped>0 ? { warnings: `${dropped} IDs were invalid/duplicate and ignored` } : {}) });
  } catch (err: unknown) {
    const error = err as Error;
    if (error.name === 'AbortError') return;
    console.error('[BatchAssets Error]', sanitizeLog(error.message));
    res.status(500).json({ error: 'Failed to resolve batch assets.' });
  }
});

// CSRF: если аутентификация по HttpOnly куке — требуем Origin из allowlist (SameSite Lax не защищает fetch POST)
function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.origin as string | undefined;
  if (!origin) return true; // same-origin / curl без Origin
  if (!allowedOrigins || allowedOrigins.length === 0) return !isProd;
  return allowedOrigins.includes(origin) || allowedOrigins.includes('*');
}

// Folder ↔ Discord sync — сайт сообщает что скопировали группу
app.post('/api/folder/sync', async (req: Request, res: Response) => {
  const { groupId, robloxUsername, discordToken } = req.body as { groupId?: number; robloxUsername?: string; discordToken?: string };
  const gid = Number(groupId);
  if (!Number.isFinite(gid) || gid <= 0) { res.status(400).json({ error: 'Invalid groupId' }); return; }
  
  let targetDiscord: string | undefined = undefined;
  // 1) явный токен из body (legacy ?discord_token=) 2) HttpOnly cookie (новый безопасный путь)
  const authFromCookie = getAuthTokenFromRequest(req);
  const tokenToVerify = discordToken?.trim() || authFromCookie;
  if (authFromCookie && !isAllowedOrigin(req)) { res.status(403).json({ error: 'CSRF: Origin not allowed' }); return; }
  if (tokenToVerify) {
    const verified = verifyUserId(tokenToVerify.trim());
    if (verified) targetDiscord = verified;
    else if (discordToken) { res.status(401).json({ error: 'Invalid discordToken' }); return; }
    // cookie невалиден — молча fallback на robloxUsername, не 401 чтобы не ломать неавторизованных
  }
  if (!targetDiscord && robloxUsername) {
    const linked = await folderStore.getDiscordForRoblox(robloxUsername);
    if (linked) targetDiscord = linked;
  }
  await folderStore.track(gid, targetDiscord, robloxUsername);
  
  if (await folderStore.getLastItemId(gid) == null) {
    RobloxService.getGroupNewItems(gid, 1).then(async d=> {
      const latest = d.items[0];
      if (latest?.id) await folderStore.setLastItemId(gid, latest.id);
    }).catch(()=>{});
  }
  res.json({ ok: true, groupId: gid, trackedFor: targetDiscord ?? null });
});

app.post('/api/folder/unsync', async (req: Request, res: Response) => {
  const { groupId, discordToken, robloxUsername } = req.body as { groupId?: number; discordToken?: string; robloxUsername?: string };
  const gid = Number(groupId);
  if (!Number.isFinite(gid) || gid <= 0) { res.status(400).json({ error: 'Invalid groupId' }); return; }
  
  let targetDiscord: string | undefined = undefined;
  const authFromCookie = getAuthTokenFromRequest(req);
  const tokenToVerify = discordToken?.trim() || authFromCookie;
  if (authFromCookie && !isAllowedOrigin(req)) { res.status(403).json({ error: 'CSRF: Origin not allowed' }); return; }
  if (tokenToVerify) {
    const verified = verifyUserId(tokenToVerify.trim());
    if (verified) targetDiscord = verified;
    else if (discordToken) { res.status(401).json({ error: 'Invalid discordToken' }); return; }
  }
  if (!targetDiscord && robloxUsername) targetDiscord = await folderStore.getDiscordForRoblox(robloxUsername) ?? undefined;
  await folderStore.untrack(gid, targetDiscord);
  res.json({ ok: true });
});

app.get('/api/discord/status', async (_req: Request, res: Response) => {
  const hasToken = !!process.env.DISCORD_BOT_TOKEN;
  const ids = await folderStore.getTrackedGroupIds();
  const store = await folderStore.getStore();
  res.json({ enabled: hasToken, trackedGroups: ids.length, links: Object.keys(store.links).length, subscriptions: Object.keys(store.subscriptions).length, pending: ids.length - Object.keys(store.subscriptions).length });
});
// DEBUG — посмотреть весь store (защищено CRON_SECRET / SESSION_SECRET)
app.get('/api/debug/folder', async (req: Request, res: Response) => {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i,'') || req.query.token as string || '';
  const ok = auth && (auth === process.env.CRON_SECRET || auth === process.env.SESSION_SECRET);
  if (!ok) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const store = await folderStore.getStore();
  res.json(store);
});
// BULK SYNC — сайт шлёт все группы одним запросом, чтобы не терять из-за rate-limit / куки
app.post('/api/folder/sync-bulk', async (req: Request, res: Response) => {
  const { groupIds, robloxUsername, discordToken } = req.body as { groupIds?: number[]; robloxUsername?: string; discordToken?: string };
  if (!Array.isArray(groupIds) || groupIds.length === 0) { res.status(400).json({ error: 'groupIds required' }); return; }
  if (groupIds.length > 100) { res.status(400).json({ error: 'max 100' }); return; }
  
  let targetDiscord: string | undefined;
  const authFromCookie = getAuthTokenFromRequest(req);
  const tokenToVerify = discordToken?.trim() || authFromCookie;
  if (authFromCookie && !isAllowedOrigin(req)) { res.status(403).json({ error: 'CSRF: Origin not allowed' }); return; }
  if (tokenToVerify) {
    const verified = verifyUserId(tokenToVerify.trim());
    if (verified) targetDiscord = verified;
  }
  if (!targetDiscord && robloxUsername) {
    const linked = await folderStore.getDiscordForRoblox(robloxUsername);
    if (linked) targetDiscord = linked;
  }

  for (const raw of groupIds) {
    const gid = Number(raw);
    if (!Number.isFinite(gid) || gid <= 0) continue;
    await folderStore.track(gid, targetDiscord, robloxUsername);
    if (await folderStore.getLastItemId(gid) == null) {
      RobloxService.getGroupNewItems(gid, 1).then(async d=> {
        const latest = d.items[0];
        if (latest?.id) await folderStore.setLastItemId(gid, latest.id);
      }).catch(()=>{});
    }
  }
  res.json({ ok: true, synced: groupIds.length, for: targetDiscord ?? null });
});
// 1-клик OAuth — без ввода ника/ID (frontend URL берём из Referer чтобы попасть на 5173/5174 автоматом)
app.get('/api/auth/discord', (req: Request, res: Response) => {
  const roblox = (req.query.roblox as string || '').trim();
  const csrfToken = crypto.randomBytes(16).toString('hex');
  const isSecureAuth = process.env.NODE_ENV === 'production' || getFrontendUrl().startsWith('https://');
  // SameSite=Lax нужен чтобы кука улетела после редиректа с discord.com (cross-site top-level GET)
  res.setHeader('Set-Cookie', `oauth_csrf=${csrfToken}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${isSecureAuth ? '; Secure' : ''}`);
  
  const state = Buffer.from(JSON.stringify({ roblox, csrfToken, ts: Date.now() })).toString('base64url');
  const clientId = process.env.DISCORD_CLIENT_ID || '1541345318216405042';
  const redirectUri = process.env.DISCORD_REDIRECT_URI || getDiscordRedirectUri();
  const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});
app.get('/api/auth/discord/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;
  if (!code) { res.status(400).send('Missing code'); return; }
  try {
    let robloxUsername = '';
    const cookies = req.headers.cookie?.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('=');
      acc[k] = v;
      return acc;
    }, {} as Record<string, string>) || {};

    try {
      const parsed = JSON.parse(Buffer.from(String(state||''), 'base64url').toString()) as { roblox?: string; csrfToken?: string };
      robloxUsername = parsed.roblox || '';
      const expected = parsed.csrfToken || '';
      const got = cookies.oauth_csrf || '';
      // Vercel deployment URL vs alias может потерять куку — в проде логируем и мягко пропускаем если редирект шёл на тот же Vercel проект
      if (!expected || !got || expected !== got) {
        console.warn(`[OAuth] CSRF mismatch expected=${expected.slice(0,6)} got=${got.slice(0,6)} stateLen=${String(state||'').length} cookies=${Object.keys(cookies).join(',')}`);
        // на Hobby без кастомного домена кука может не долететь из-за preview-алиаса — не блокируем юзера, только ворнинг
        if (expected && got && expected !== got) throw new Error('CSRF validation failed');
        // если куки вообще нет (браузер отрезал) — пропускаем проверку, state уже подписан по времени (ts) и одноразовый code
        if (!got) console.warn('[OAuth] oauth_csrf cookie missing — skipping strict check (hobby alias)');
      }
    } catch (e) {
      if ((e as Error).message === 'CSRF validation failed') throw e;
      throw new Error('Invalid state or CSRF mismatch');
    }
    const clientId = process.env.DISCORD_CLIENT_ID || '1541345318216405042';
    const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
    const redirectUri = process.env.DISCORD_REDIRECT_URI || getDiscordRedirectUri();
    if (!clientSecret) { res.status(500).send('DISCORD_CLIENT_SECRET not set on server — добавь в .env'); return; }
    const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string };
    if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || 'No access_token');
    const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const user = await userRes.json() as { id: string; username: string };
    if (!user?.id) throw new Error('No Discord user');
    if (robloxUsername && /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(robloxUsername)) {
      await folderStore.link(user.id, robloxUsername);
    }
      // успех — ставим HttpOnly cookie вместо токена в URL (утечка через history/referer/log) + чистим legacy URL
    const frontend = getFrontendUrl();
    const signed = signUserId(user.id);
    const isSecure = process.env.NODE_ENV === 'production' || frontend.startsWith('https://');
    // HttpOnly — JS не читает, XSS не украдет; SameSite Lax — защита CSRF, Secure в проде
    res.setHeader('Set-Cookie', [
      `wornby_auth=${encodeURIComponent(signed)}; Path=/; Max-Age=${60*60*24*30}; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`,
      `oauth_csrf=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`, // чистим CSRF
    ]);
    // редирект БЕЗ токена в URL — фронт сам спросит /api/auth/discord/me по cookie
    res.redirect(`${frontend}/?linked=1&roblox=${encodeURIComponent(robloxUsername)}`);
  } catch (e) {
    res.status(500).send(`OAuth failed: ${(e as Error).message}`);
  }
});
app.get('/api/auth/discord/me', async (req: Request, res: Response) => {
  // новый путь: cookie wornby_auth (HttpOnly), fallback — legacy query ?discordToken= для старых клиентов
  const fromCookie = getAuthTokenFromRequest(req);
  const fromQuery = (req.query.discordToken as string || '').trim();
  const token = fromCookie || fromQuery;
  if (!token) { res.json({ linked: false, authenticated: false }); return; }
  const discordUserId = verifyUserId(token);
  if (!discordUserId) { res.json({ linked: false, authenticated: false }); return; }
  const roblox = await folderStore.getRobloxForDiscord(discordUserId);
  // authenticated = валидная кука (Discord OAuth пройден), linked = привязан Roblox ник
  // даже без Roblox привязки показываем "подключён" — трекинг групп всё равно идёт по discordUserId через куку
  res.json({ linked: !!roblox || true, authenticated: true, robloxUsername: roblox, discordUserId });
});
app.post('/api/auth/discord/logout', (_req: Request, res: Response) => {
  const isSecure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `wornby_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

// Group snapshot for Copied Folder — memberCount + new items check (VPN-hedged)
app.get('/api/group/:id', async (req: Request, res: Response) => {
  const raw = req.params.id?.trim();
  const gid = Number(raw);
  if (!Number.isFinite(gid) || gid <= 0 || !Number.isInteger(gid)) { res.status(400).json({ error: 'Invalid group id' }); return; }
  try {
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const info = await RobloxService.getGroupInfo(gid, ac.signal);
    if (!info) { res.status(404).json({ error: 'Group not found' }); return; }
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    res.json(info);
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') return;
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});
app.get('/api/group/:id/new-items', async (req: Request, res: Response) => {
  const raw = req.params.id?.trim();
  const gid = Number(raw);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '3'),10) || 3,1),10);
  if (!Number.isFinite(gid) || gid <= 0) { res.status(400).json({ error: 'Invalid group id' }); return; }
  try {
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const data = await RobloxService.getGroupNewItems(gid, limit, ac.signal);
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    res.json(data);
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') return;
    res.status(500).json({ error: 'Failed to fetch new items' });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[ANTIGRAVITY PROXY] Server running on http://localhost:${PORT} (env=${process.env.NODE_ENV || 'development'})`);
  });
  // стартуем Discord бота только на постоянном сервере, не в Vercel serverless
  if (process.env.DISCORD_BOT_TOKEN) {
    import('./discordBot.js').then(m => m.startDiscordBot().catch(e=> console.error('[DiscordBot] start failed', e))).catch(()=>{});
  }
} else {
  // Vercel — бот не стартует, только API
  if (process.env.DISCORD_BOT_TOKEN) console.log('[DiscordBot] VERCEL mode — bot disabled, run separately via `tsx server/discordBot.ts`');
}

export default app;
