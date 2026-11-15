// Field-by-field comparison of every /api endpoint: original Node backend vs the Rust backend, both against real Roblox.
// Usage: run the original server (git worktree of the pre-migration commit: `PORT=3011 npx tsx server/index.ts`)
// and the Rust one (`PORT=3002 cargo run --release --bin main`), then: node scripts/compare-api.mjs
const NODE = process.env.NODE_API || 'http://localhost:3011';
const RUST = process.env.RUST_API || 'http://127.0.0.1:3002';
const GAP_MS = Number(process.env.GAP_MS || 3000); // spacing between upstream-heavy calls (Roblox rate limits)
// Protected Vercel previews: pass the bypass secret via env (never logged).
const withAuth = (base, init = {}) => base === RUST && process.env.RUST_BYPASS
  ? { ...init, headers: { ...(init.headers || {}), 'x-vercel-protection-bypass': process.env.RUST_BYPASS } }
  : init;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const short = (v) => JSON.stringify(v)?.slice(0, 70);

async function call(base, path, init) {
  const started = performance.now();
  const res = await fetch(base + path, withAuth(base, init));
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ms: Math.round(performance.now() - started), body, headers: res.headers };
}
// Rust first: Node's fallback paths fire dozens of Roblox calls and would exhaust the shared quota.
async function both(path, init, fn = call) {
  const rust = await fn(RUST, path, init);
  await sleep(GAP_MS);
  const node = await fn(NODE, path, init);
  await sleep(GAP_MS);
  return { node, rust };
}

const report = [];
const timings = [];
function note(name, ok, lines = []) {
  report.push({ name, ok, lines });
  console.log(`${ok ? 'PASS' : 'DIFF'}  ${name}${lines.length ? `\n      ${lines.join('\n      ')}` : ''}`);
}
function diffFields(nodeList, rustList, key = 'id', ignore = []) {
  const lines = [];
  const nIds = nodeList.map((i) => i[key]);
  const rIds = rustList.map((i) => i[key]);
  if (!same(nIds, rIds)) lines.push(`${key}s/order differ (node ${nIds.length}, rust ${rIds.length})`);
  const rustBy = new Map(rustList.map((i) => [i[key], i]));
  const fields = new Map();
  for (const n of nodeList) {
    const r = rustBy.get(n[key]);
    if (!r) continue;
    for (const f of new Set([...Object.keys(n), ...Object.keys(r)])) {
      if (ignore.includes(f) || same(n[f], r[f])) continue;
      const list = fields.get(f) || [];
      list.push(`${n[key]}: node=${short(n[f])} rust=${short(r[f])}`);
      fields.set(f, list);
    }
  }
  for (const [f, list] of fields) lines.push(`field ${f}: ${list.length}/${nIds.length} differ, e.g. ${list.slice(0, 2).join(' | ')}`);
  return lines;
}
function statusLine(node, rust) {
  return node.status === rust.status ? [] : [`status node=${node.status} rust=${rust.status} rust=${short(rust.body)} node=${short(node.body)}`];
}
function headerLines(node, rust, names) {
  return names.filter((h) => node.headers.get(h) !== rust.headers.get(h)).map((h) => `header ${h}: node=${node.headers.get(h)} rust=${rust.headers.get(h)}`);
}

// ── Simple endpoints ──
{
  const { node, rust } = await both('/api/health');
  const keys = (b) => Object.keys(b).sort().join(',');
  note('health', node.status === rust.status && keys(node.body) === keys(rust.body) && node.body.service === rust.body.service, statusLine(node, rust));
}
for (const keyword of ['builder', 'x']) {
  const { node, rust } = await both(`/api/users/search?keyword=${keyword}`);
  timings.push({ name: `users/search ${keyword}`, node: node.ms, rust: rust.ms });
  const lines = [...statusLine(node, rust), ...(node.status === 200 && rust.status === 200 ? diffFields(node.body.users, rust.body.users) : [])];
  note(`users/search "${keyword}" (node ${node.ms}ms, rust ${rust.ms}ms)`, lines.length === 0, lines);
}

// ── Profiles (JSON) ──
const PROFILE_IGNORE = ['telemetry'];
function compareProfile(name, node, rust) {
  timings.push({ name, node: node.ms, rust: rust.ms });
  const lines = statusLine(node, rust);
  if (node.status !== 200 || rust.status !== 200) {
    if (node.status === rust.status && !same(node.body, rust.body)) lines.push(`error body node=${short(node.body)} rust=${short(rust.body)}`);
    return lines;
  }
  const n = node.body, r = rust.body;
  for (const part of ['user', 'thumbnails']) if (!same(n[part], r[part])) lines.push(`${part} differs: node=${short(n[part])} rust=${short(r[part])}`);
  lines.push(...diffFields(n.groups, r.groups).map((l) => `groups ${l}`));
  const summary = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'items'));
  if (!same(summary(n.outfit), summary(r.outfit))) lines.push(`outfit summary node=${short(summary(n.outfit))} rust=${short(summary(r.outfit))}`);
  lines.push(...diffFields(n.outfit.items, r.outfit.items).map((l) => `items ${l}`));
  for (const t of ['fingerprint', 'wearingAssetCount', 'egressShards']) {
    if (n.telemetry[t] !== r.telemetry[t]) lines.push(`telemetry.${t} node=${n.telemetry[t]} rust=${r.telemetry[t]}`);
  }
  return lines;
}
for (const q of ['Roblox', '156', 'Shedletsky', 'zzqqxxnonexist123', 'a__b']) {
  const { node, rust } = await both(`/api/user/${q}`);
  const lines = compareProfile(`user ${q}`, node, rust);
  if (node.status === 200 && rust.status === 200) lines.push(...headerLines(node, rust, ['cache-control', 'x-cache', 'x-fingerprint', 'x-egress-shards']));
  note(`user ${q} (node ${node.ms}ms, rust ${rust.ms}ms)`, lines.length === 0, lines);
}

// ── Profile (SSE stream) ──
async function stream(base, path) {
  const started = performance.now();
  const res = await fetch(base + path, withAuth(base, { headers: { Accept: 'text/event-stream' } }));
  const text = await res.text();
  const events = text.split('\n\n').filter((b) => b.startsWith('event:')).map((block) => {
    const [ev, data] = block.split('\n');
    return { event: ev.slice(7).trim(), data: JSON.parse(data.slice(5)) };
  });
  const done = events.find((e) => e.event === 'done');
  return { status: res.status, ms: Math.round(performance.now() - started), events, body: done?.data, headers: res.headers };
}
{
  // Fresh user (not cached by the JSON test above) so the whole pipeline streams.
  const { node, rust } = await both('/api/user/Builderman?stream=true', undefined, stream);
  const kinds = (s) => [...new Set(s.events.map((e) => e.event))].sort().join(',');
  const lines = [];
  if (kinds(node) !== kinds(rust)) lines.push(`event kinds node=[${kinds(node)}] rust=[${kinds(rust)}]`);
  for (const s of [node, rust]) if (s.events.at(-1)?.event !== 'end' || s.events[0]?.event !== 'user') lines.push(`bad event order ${s === node ? 'node' : 'rust'}: ${s.events.map((e) => e.event).join(',').slice(0, 120)}`);
  if (node.headers.get('content-type') !== rust.headers.get('content-type')) lines.push(`content-type node=${node.headers.get('content-type')} rust=${rust.headers.get('content-type')}`);
  lines.push(...compareProfile('stream Builderman', node, rust).map((l) => `done: ${l}`));
  note(`user Builderman stream (${rust.events.length} rust events, ${node.events.length} node events)`, lines.length === 0, lines);
  const unknown = await both('/api/user/zzqqxxnonexist123?stream=true', undefined, call);
  note('user unknown stream -> plain HTTP error', unknown.node.status === unknown.rust.status && same(unknown.node.body, unknown.rust.body), statusLine(unknown.node, unknown.rust));
}

// ── Outfits ──
for (const [label, path] of [['outfits user 156', '/api/users/156/outfits'], ['outfits user 2207291', '/api/users/2207291/outfits'], ['outfits bad id', '/api/users/abc/outfits']]) {
  const { node, rust } = await both(path);
  timings.push({ name: label, node: node.ms, rust: rust.ms });
  const lines = statusLine(node, rust);
  if (node.status === 200 && rust.status === 200) {
    lines.push(...diffFields(node.body.outfits, rust.body.outfits));
    if (node.body.nextPageToken !== rust.body.nextPageToken) lines.push(`nextPageToken differs`);
    if (rust.body.nextPageToken) {
      const page2 = await both(`${path}?pageToken=${encodeURIComponent(rust.body.nextPageToken)}`);
      lines.push(...statusLine(page2.node, page2.rust), ...(page2.rust.status === 200 ? diffFields(page2.node.body.outfits, page2.rust.body.outfits).map((l) => `page 2 ${l}`) : []));
    }
  }
  note(`${label} (node ${node.ms}ms, rust ${rust.ms}ms)`, lines.length === 0, lines);
}
for (const id of ['6505210781156933', '3189608587', 'xyz']) {
  const { node, rust } = await both(`/api/outfits/${id}`);
  timings.push({ name: `outfit ${id}`, node: node.ms, rust: rust.ms });
  const lines = statusLine(node, rust);
  if (node.status === 200 && rust.status === 200) {
    if (node.body.name !== rust.body.name) lines.push(`name node=${node.body.name} rust=${rust.body.name}`);
    lines.push(...diffFields(node.body.assets, rust.body.assets));
  }
  note(`outfit details ${id} (node ${node.ms}ms, rust ${rust.ms}ms)`, lines.length === 0, lines);
}

// ── Groups ──
for (const gid of [6589372, 999999999999]) {
  const { node, rust } = await both(`/api/group/${gid}`);
  note(`group info ${gid}`, node.status === rust.status && same(node.body, rust.body), statusLine(node, rust));
}
for (const gid of [6589372, 7]) {
  const { node, rust } = await both(`/api/group/${gid}/store-status`);
  note(`store-status ${gid}`, node.status === rust.status && same(node.body, rust.body), [...statusLine(node, rust), ...(same(node.body, rust.body) ? [] : [`node=${short(node.body)} rust=${short(rust.body)}`])]);
}
{
  const { node, rust } = await both('/api/group/8637765/new-items?limit=5');
  note(`new-items 8637765 (node ${node.body.items?.length} items, rust ${rust.body.items?.length})`, same(node.body, rust.body), [`node=${short(node.body)}`, `rust=${short(rust.body)}`]);
}
// Store: Rust serves a short first page (30) and chains later pages, so compare the first 120 items.
async function firstItems(base, path) {
  const started = performance.now();
  let res = await call(base, path);
  const first = res;
  const items = [];
  while (res.status === 200) {
    items.push(...res.body.items);
    if (items.length >= 120 || !res.body.nextPageCursor) break;
    res = await call(base, `${path}&cursor=${encodeURIComponent(res.body.nextPageCursor)}`);
  }
  return { status: res.status, body: { items: items.slice(0, 120) }, ms: Math.round(performance.now() - started), firstMs: first.ms, headers: first.headers };
}
for (const gid of [3533332, 6712731]) {
  const { node, rust } = await both(`/api/group/${gid}/store?limit=120&sortType=RecentlyCreated&sortOrder=Desc&fast=1`, undefined, firstItems);
  timings.push({ name: `store ${gid} first 120`, node: node.ms, rust: rust.ms, rustFirstPaint: rust.firstMs });
  const lines = [...statusLine(node, rust), ...(node.status === 200 && rust.status === 200 ? diffFields(node.body.items, rust.body.items) : [])];
  note(`store ${gid} first 120 (node ${node.ms}ms, rust ${rust.ms}ms, rust first paint ${rust.firstMs}ms)`, lines.length === 0, lines);
}
{
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: [6554200369, 6067501477, 11164834217, 'bad', -1] }) };
  const { node, rust } = await both('/api/asset-thumbnails', init);
  note('asset-thumbnails', node.status === rust.status && same(node.body, rust.body), statusLine(node, rust));
  for (const [label, body] of [['thumbnails empty', '{"assetIds":[]}'], ['thumbnails bad json', '{nope']]) {
    const r = await both('/api/asset-thumbnails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    note(label, r.node.status === r.rust.status, statusLine(r.node, r.rust));
  }
}
{
  const { node, rust } = await both('/api/does-not-exist');
  note('unknown route -> 404', node.status === 404 && rust.status === 404, statusLine(node, rust));
}

console.log('\nTimings (ms):');
console.table(timings);
const diffs = report.filter((r) => !r.ok).length;
console.log(`${report.length - diffs}/${report.length} checks identical`);
