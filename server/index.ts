import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { RobloxService } from './robloxService.js';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

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
  });
});

// User Full Profile & Outfit Endpoint
app.get('/api/users/search', async (req: Request, res: Response) => {
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
  if (keyword.length < 2 || keyword.length > 20) {
    res.json({ users: [] });
    return;
  }
  const controller = new AbortController();
  req.once('close', () => controller.abort());
  try {
    const users = await RobloxService.searchUsers(keyword, controller.signal);
    if (controller.signal.aborted) return;
    res.json({ users });
  } catch (err: unknown) {
    if (controller.signal.aborted) return;
    console.warn('[User Search] failed', sanitizeLog((err as Error).message || 'unknown error'));
    const status = (err as { response?: { status?: number } }).response?.status === 429 ? 429 : 502;
    res.status(status).json({ users: [], error: status === 429 ? 'Roblox user search is rate limited.' : 'User search is unavailable right now.' });
  }
});

// Maps a profile pipeline failure to the HTTP status and message the client shows.
function profileError(err: Error & { response?: { status?: number } }): { status: number; error: string } {
  const lower = (err.message || '').toLowerCase();
  const status = err.response?.status;
  if (status === 404 || lower.includes('not found') || lower.includes('does not exist')) {
    return { status: 404, error: status === 404 ? 'User not found.' : err.message };
  }
  if (status === 429 || lower.includes('too many requests') || lower.includes('429')) {
    return { status: 429, error: 'Roblox API rate limited, try again shortly.' };
  }
  if (status === 503 || status === 502) {
    return { status: 503, error: 'Roblox services temporarily unavailable, try again.' };
  }
  return { status: 500, error: 'Failed to retrieve telemetry from Roblox services.' };
}

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
    const ac = new AbortController();
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    // Headers go out with the first event, so early failures (unknown user, rate limit) still get a real HTTP status.
    const startStream = () => {
      if (res.headersSent) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      keepAlive = setInterval(() => { try { res.write(`: keepalive\n\n`); } catch {} }, 15000);
    };
    res.on('close', () => { if (!res.writableEnded) ac.abort(); clearInterval(keepAlive); });
    const onEvent = (event: string, data: unknown) => {
      startStream();
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };
    try {
      await RobloxService.streamFullProfile(query, ac.signal, onEvent, bypassCache);
      onEvent('end', { ok: true });
      res.end();
    } catch (e) {
      const err = e as Error & { response?: { status?: number } };
      if (ac.signal.aborted) return;
      console.error(`[API Error] Stream failed for "${sanitizeLog(query)}":`, sanitizeLog(err.message || 'unknown error'));
      const { status, error } = profileError(err);
      if (res.headersSent) {
        onEvent('error', { error, status });
        res.end();
      } else {
        res.status(status).json({ error });
      }
    } finally {
      clearInterval(keepAlive);
    }
    return;
  }

  // wire abort: if client disconnects, abort downstream Roblox calls
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
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
    if (ac.signal.aborted) return;
    console.error(`[API Error] User resolution failed for "${sanitizeLog(query)}":`, sanitizeLog(err.message));
    const { status, error: message } = profileError(err);
    res.status(status).json({ error: message });
  }
});

// Lightweight second stage for progressive group-store rendering.
app.post('/api/asset-thumbnails', async (req: Request, res: Response) => {
  const rawIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
  const assetIds: number[] = Array.from(new Set<number>(rawIds.map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0))).slice(0, 120);
  if (assetIds.length === 0) {
    res.status(400).json({ error: 'assetIds must contain valid asset IDs.' });
    return;
  }

  const ac = new AbortController();
  req.on('aborted', () => ac.abort());
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const thumbnails: Record<number, string> = {};
    let missingIds = assetIds;

    // Roblox can answer with a temporary "Pending" thumbnail state. Retry only
    // missing IDs so ready images still appear immediately and pending ones follow.
    for (let attempt = 0; attempt < 3 && missingIds.length > 0; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 350 * attempt);
          ac.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      Object.assign(thumbnails, await RobloxService.getAssetThumbnails(missingIds, ac.signal));
      missingIds = missingIds.filter((id) => !thumbnails[id]);
    }
    res.setHeader('Cache-Control', missingIds.length > 0 ? 'no-store' : 'public, max-age=300, stale-while-revalidate=1800');
    res.json({ thumbnails });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    res.status(502).json({ error: 'Failed to fetch asset thumbnails' });
  }
});

// Group snapshot for Copied Folder — memberCount + new items check (VPN-hedged)
app.get('/api/outfits/:id', async (req: Request, res: Response) => {
  const outfitId = Number(req.params.id);
  if (!Number.isSafeInteger(outfitId) || outfitId <= 0) {
    res.status(400).json({ error: 'Invalid outfit id' });
    return;
  }
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const result = await RobloxService.getSavedOutfitDetails(outfitId, controller.signal);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(result);
  } catch {
    if (controller.signal.aborted) return;
    res.status(502).json({ error: 'Outfit details are unavailable right now' });
  }
});

app.get('/api/users/:id/outfits', async (req: Request, res: Response) => {
  const userId = Number(req.params.id);
  const token = typeof req.query.pageToken === 'string' ? req.query.pageToken : '';
  if (!Number.isSafeInteger(userId) || userId <= 0 || token.length > 1024) {
    res.status(400).json({ error: 'Invalid outfit request' });
    return;
  }
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const result = await RobloxService.getSavedOutfits(userId, token, controller.signal);
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    res.json(result);
  } catch (error) {
    if (controller.signal.aborted) return;
    res.status(502).json({ error: 'Saved outfits are unavailable right now' });
  }
});

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
app.get('/api/group/:id/store', async (req: Request, res: Response) => {
  const raw = req.params.id?.trim();
  const gid = Number(raw);
  if (!Number.isFinite(gid) || gid <= 0 || !Number.isInteger(gid)) {
    res.status(400).json({ error: 'Invalid group id' });
    return;
  }
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';
  const parsedLimit = parseInt(String(req.query.limit || '100'), 10) || 100;
  const limit = Math.min(Math.max(parsedLimit, 10), 120);
  const sortType = (['RecentlyCreated', 'PriceAsc', 'PriceDesc', 'Relevance'].includes(String(req.query.sortType))
    ? req.query.sortType
    : 'RecentlyCreated') as 'RecentlyCreated' | 'PriceAsc' | 'PriceDesc' | 'Relevance';
  const sortOrder = (String(req.query.sortOrder).toLowerCase() === 'asc' ? 'Asc' : 'Desc') as 'Asc' | 'Desc';
  const includeThumbnails = String(req.query.fast) !== '1';

  try {
    const ac = new AbortController();
    req.on('aborted', () => ac.abort());
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
    const data = await RobloxService.getGroupStore(gid, cursor, limit, sortType, sortOrder, ac.signal, includeThumbnails);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=180');
    res.json(data);
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') return;
    res.status(500).json({ error: 'Failed to fetch group store' });
  }
});

app.get('/api/group/:id/store-status', async (req: Request, res: Response) => {
  const gid = Number(req.params.id?.trim());
  if (!Number.isFinite(gid) || gid <= 0 || !Number.isInteger(gid)) {
    res.status(400).json({ error: 'Invalid group id' });
    return;
  }

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    const status = await RobloxService.getGroupStoreStatus(gid, ac.signal);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(status);
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    res.status(502).json({ error: 'Failed to check group store' });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[ANTIGRAVITY PROXY] Server running on http://localhost:${PORT} (env=${process.env.NODE_ENV || 'development'})`);
  });
}

export default app;
