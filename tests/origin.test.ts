import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';

process.env.VERCEL = '1'; // production mode, and no app.listen on import
process.env.ALLOWED_ORIGINS = 'https://partner.example';

let server: Server;
let base = '';

before(async () => {
  const { default: app } = await import('../server/index');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.close(); });

// An empty ID list is rejected with 400 before any Roblox call, so the status shows whether the origin passed.
const post = (origin?: string) => fetch(`${base}/api/asset-thumbnails`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  body: '{"assetIds":[]}',
});

test('same-origin POSTs pass even when the origin is not in ALLOWED_ORIGINS', async () => {
  assert.equal((await post(base)).status, 400);
});

test('requests without an Origin header pass', async () => {
  assert.equal((await post()).status, 400);
});

test('allow-listed cross origins pass', async () => {
  const res = await post('https://partner.example');
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://partner.example');
});

test('other cross origins get 403 instead of a server error', async () => {
  assert.equal((await post('https://evil.example')).status, 403);
});
