// Outfit archive state: live Roblox outfits, Wayback snapshots and this browser's earlier visits,
// merged without duplicates (outfits by id, worn looks by their exact set of item ids).

export type OutfitStatus = 'available' | 'recovered' | 'deleted' | 'partial' | 'checking';
export type ArchiveSource = 'roblox' | 'wayback' | 'browser';

export interface ArchiveItem {
  id: number;
  name?: string;
  assetTypeName?: string;
  kind?: 'clothing' | 'accessory' | 'gear';
  thumbnailUrl?: string | null;
}

export interface ArchiveOutfit {
  id: number;
  name: string;
  status: OutfitStatus;
  thumbnailUrl: string | null;
  /** Earliest date (YYYY-MM-DD) this outfit was seen in any source. */
  firstSeen: string;
  lastSeen: string;
  /** Earliest Wayback capture that lists it, the only real dating outfits have. */
  archivedSince?: string;
  sources: ArchiveSource[];
  /** Contents kept from an archived capture, for outfits Roblox no longer has. */
  assets?: ArchiveItem[];
}

export interface ArchiveLook {
  key: string;
  assetIds: number[];
  items: ArchiveItem[];
  renderUrl: string | null;
  firstSeen: string;
  lastSeen: string;
  sightings: number;
  sources: ArchiveSource[];
}

export interface ArchiveState {
  version: 1;
  outfits: Record<number, ArchiveOutfit>;
  looks: Record<string, ArchiveLook>;
  /** Snapshots already merged (`ts|url`), so later visits only fetch new ones. */
  processed: string[];
}

export interface SnapshotRef { kind: 'outfits' | 'wearing' | 'avatar' | 'profile'; ts: string; url: string }
export interface SnapshotContent {
  kind: SnapshotRef['kind'];
  date: string;
  outfits?: { id: number; name: string }[];
  look?: { assetIds: number[]; items: ArchiveItem[]; renderUrl: string | null };
}

export const emptyArchive = (): ArchiveState => ({ version: 1, outfits: {}, looks: {}, processed: [] });
export const snapshotKey = (s: SnapshotRef) => `${s.ts}|${s.url}`;
export const lookKey = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b).join(',');

const minDate = (a: string | undefined, b: string) => (a && a < b ? a : b);
const maxDate = (a: string | undefined, b: string) => (a && a > b ? a : b);
const withSource = (sources: ArchiveSource[], s: ArchiveSource) => (sources.includes(s) ? sources : [...sources, s]);
const CLOTHING = /^(T-?Shirt|Shirt|Pants|.*(Shirt|Pants|Jacket|Sweater|Shorts|Shoe|Skirt)Accessory)$/i;
const ACCESSORY = /(Hat|Accessory)$/i;

/** Clothing/accessory/gear from a Roblox asset type name, for the "copy clothing IDs" action. */
export function itemKind(assetTypeName?: string): ArchiveItem['kind'] {
  if (!assetTypeName) return undefined;
  if (CLOTHING.test(assetTypeName.replace(/\s+/g, ''))) return 'clothing';
  if (ACCESSORY.test(assetTypeName.replace(/\s+/g, ''))) return 'accessory';
  return assetTypeName === 'Gear' ? 'gear' : undefined;
}

/** Outfits the player lists right now. Earlier-listed outfits missing from a complete list need a recheck. */
export function mergeLive(state: ArchiveState, live: { id: number; name: string; thumbnailUrl: string | null }[], complete: boolean, today: string): ArchiveState {
  const outfits = { ...state.outfits };
  const listed = new Set(live.map((o) => o.id));
  for (const o of live) {
    const prev = outfits[o.id];
    outfits[o.id] = {
      ...prev, id: o.id, name: o.name, status: 'available', thumbnailUrl: o.thumbnailUrl ?? prev?.thumbnailUrl ?? null,
      firstSeen: minDate(prev?.firstSeen, today), lastSeen: today, sources: withSource(prev?.sources ?? [], 'roblox'),
    };
  }
  if (complete) {
    for (const o of Object.values(outfits)) {
      if (!listed.has(o.id) && o.status === 'available') outfits[o.id] = { ...o, status: 'checking', sources: withSource(o.sources, 'browser') };
    }
  }
  return { ...state, outfits };
}

function mergeLook(state: ArchiveState, look: NonNullable<SnapshotContent['look']>, date: string, source: ArchiveSource): ArchiveState {
  if (look.assetIds.length === 0) return state;
  const key = lookKey(look.assetIds);
  const prev = state.looks[key];
  const names = new Map((prev?.items ?? []).map((i) => [i.id, i]));
  for (const i of look.items) names.set(i.id, { ...names.get(i.id), ...i, kind: itemKind(i.assetTypeName) ?? names.get(i.id)?.kind });
  const items = key.split(',').map(Number).map((id) => names.get(id) ?? { id });
  return {
    ...state,
    looks: {
      ...state.looks,
      [key]: {
        key, assetIds: key.split(',').map(Number), items,
        renderUrl: prev?.renderUrl ?? look.renderUrl ?? null,
        firstSeen: minDate(prev?.firstSeen, date), lastSeen: maxDate(prev?.lastSeen, date),
        sightings: (prev?.sightings ?? 0) + 1, sources: withSource(prev?.sources ?? [], source),
      },
    },
  };
}

/** What the player wears now (from the profile); counted once per day. */
export function mergeCurrentLook(state: ArchiveState, items: ArchiveItem[], renderUrl: string | null, today: string): ArchiveState {
  const prev = state.looks[lookKey(items.map((i) => i.id))];
  if (prev && prev.lastSeen === today) return state;
  const merged = mergeLook(state, { assetIds: items.map((i) => i.id), items, renderUrl: null }, today, 'roblox');
  const key = lookKey(items.map((i) => i.id));
  // The live render shows exactly this look; archived renders stay with older looks.
  return merged.looks[key] ? { ...merged, looks: { ...merged.looks, [key]: { ...merged.looks[key], renderUrl: renderUrl ?? merged.looks[key].renderUrl } } } : merged;
}

/** One Wayback snapshot: outfit names it lists, or the look it shows. Idempotent per snapshot. */
export function mergeSnapshot(state: ArchiveState, ref: SnapshotRef, snap: SnapshotContent): ArchiveState {
  const key = snapshotKey(ref);
  if (state.processed.includes(key)) return state;
  let next: ArchiveState = { ...state, processed: [...state.processed, key] };
  if (snap.outfits?.length) {
    const outfits = { ...next.outfits };
    for (const o of snap.outfits) {
      const prev = outfits[o.id];
      outfits[o.id] = prev
        ? { ...prev, firstSeen: minDate(prev.firstSeen, snap.date), archivedSince: minDate(prev.archivedSince, snap.date), sources: withSource(prev.sources, 'wayback') }
        : { id: o.id, name: o.name, status: 'checking', thumbnailUrl: null, firstSeen: snap.date, lastSeen: snap.date, archivedSince: snap.date, sources: ['wayback'] };
    }
    next = { ...next, outfits };
  }
  if (snap.look) next = mergeLook(next, snap.look, snap.date, 'wayback');
  return next;
}

export type CheckResult =
  | { exists: true; thumbnailUrl?: string | null }
  | { exists: false; archived: { name?: string; assets: ArchiveItem[] | null } | null };

/** Outcome of rechecking an outfit that is not in the live list: still on Roblox, or deleted. */
export function applyCheck(state: ArchiveState, id: number, result: CheckResult): ArchiveState {
  const prev = state.outfits[id];
  if (!prev || prev.status === 'available') return state;
  const next: ArchiveOutfit = result.exists
    ? { ...prev, status: 'recovered', thumbnailUrl: result.thumbnailUrl ?? prev.thumbnailUrl }
    : result.archived?.assets?.length
      ? { ...prev, status: 'deleted', assets: result.archived.assets, name: prev.name || result.archived.name || prev.name }
      : { ...prev, status: prev.assets?.length ? 'deleted' : 'partial' };
  return { ...state, outfits: { ...state.outfits, [id]: next } };
}

export const needsCheck = (state: ArchiveState) => Object.values(state.outfits).filter((o) => o.status === 'checking').map((o) => o.id);

export interface ArchiveFilter { status: OutfitStatus | 'all' | 'looks'; query: string }

const matches = (query: string, name: string | undefined, items: ArchiveItem[] = []) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (name ?? '').toLowerCase().includes(q) || items.some((i) => String(i.id) === q || (i.name ?? '').toLowerCase().includes(q));
};

/** Outfits newest first (ids grow with creation time); hidden entirely while the inventory is private. */
export function visibleOutfits(state: ArchiveState, filter: ArchiveFilter, inventoryPublic: boolean): ArchiveOutfit[] {
  if (!inventoryPublic || filter.status === 'looks') return [];
  return Object.values(state.outfits)
    .filter((o) => filter.status === 'all' || o.status === filter.status)
    .filter((o) => matches(filter.query, o.name, o.assets) || String(o.id) === filter.query.trim())
    .sort((a, b) => b.id - a.id);
}

/** Worn looks grouped by the year they were last seen, newest first. */
export function lookYears(state: ArchiveState, filter: ArchiveFilter): [string, ArchiveLook[]][] {
  if (filter.status !== 'all' && filter.status !== 'looks') return [];
  const groups = new Map<string, ArchiveLook[]>();
  for (const look of Object.values(state.looks).filter((l) => matches(filter.query, undefined, l.items))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.firstSeen.localeCompare(a.firstSeen))) {
    const year = look.lastSeen.slice(0, 4);
    groups.set(year, [...(groups.get(year) ?? []), look]);
  }
  return [...groups];
}

export function counts(state: ArchiveState, inventoryPublic: boolean) {
  const c: Record<OutfitStatus, number> = { available: 0, recovered: 0, deleted: 0, partial: 0, checking: 0 };
  if (inventoryPublic) for (const o of Object.values(state.outfits)) c[o.status]++;
  return { ...c, looks: Object.keys(state.looks).length };
}
