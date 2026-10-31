import { RobloxGroupMembership } from '../types/roblox';

export interface CopiedGroupEntry extends RobloxGroupMembership {
  copiedAt: number;
  sourceUserName?: string;
  sourceUserId?: number;
  memberCountAtCopy: number;
  /** Migrated from the old ID-only list; name and size still need fetching. */
  needsDetails?: boolean;
}

/** Folds IDs from the old ID-only list into the folder as placeholder entries, so no saved group is lost. */
export function mergeLegacyIds(entries: CopiedGroupEntry[], legacyIds: unknown, now = Date.now()): CopiedGroupEntry[] {
  if (!Array.isArray(legacyIds)) return entries;
  const known = new Set(entries.map((e) => e.id));
  const added: CopiedGroupEntry[] = [];
  for (const raw of legacyIds) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0 || known.has(id)) continue;
    known.add(id);
    added.push({ id, name: `Group #${id}`, memberCount: 0, hasVerifiedBadge: false, roleName: '', roleRank: 0, iconUrl: null, copiedAt: now, memberCountAtCopy: 0, needsDetails: true });
  }
  return added.length ? [...entries, ...added] : entries;
}
