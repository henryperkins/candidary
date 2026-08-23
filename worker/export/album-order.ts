interface FrozenAlbumPhotoEntry {
  kind: 'photo';
  mediaId: string;
}

function isFrozenPhotoEntry(value: unknown): value is FrozenAlbumPhotoEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'photo'
    && typeof candidate.mediaId === 'string'
    && candidate.mediaId.length > 0;
}

/**
 * Resolves one immutable album-export snapshot without consulting the live album.
 * Stored photo positions win; stale/duplicate positions disappear; snapshot rows
 * absent from the stored order are appended by their frozen timeline rank.
 */
export function resolveFrozenAlbumOrder<
  T extends { id: string; albumTailPosition: number | null },
>(rawEntries: string, media: readonly T[]): T[] {
  const tail = [...media].sort((left, right) => {
    const leftPosition = left.albumTailPosition ?? Number.POSITIVE_INFINITY;
    const rightPosition = right.albumTailPosition ?? Number.POSITIVE_INFINITY;
    return leftPosition - rightPosition || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
  const byId = new Map<string, T>();
  for (const entry of tail) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  let storedEntries: unknown = null;
  try {
    storedEntries = JSON.parse(rawEntries) as unknown;
  } catch {
    // A historical malformed value cannot make order nondeterministic. The
    // immutable tail rank is the complete fallback order.
  }

  const ordered: T[] = [];
  const placed = new Set<string>();
  if (Array.isArray(storedEntries)) {
    for (const stored of storedEntries) {
      if (!isFrozenPhotoEntry(stored) || placed.has(stored.mediaId)) continue;
      const snapshotEntry = byId.get(stored.mediaId);
      if (!snapshotEntry) continue;
      placed.add(snapshotEntry.id);
      ordered.push(snapshotEntry);
    }
  }
  for (const snapshotEntry of tail) {
    if (placed.has(snapshotEntry.id)) continue;
    placed.add(snapshotEntry.id);
    ordered.push(snapshotEntry);
  }
  return ordered;
}
