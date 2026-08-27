import type { GalleryMode, ManagerLocation } from './manager-location';

export type PublicationFilter = 'all' | 'unpublished' | 'published' | 'hidden';
export type GalleryAnchor =
  | { kind: 'media'; mediaId: string; viewportOffset: number; fallbackScrollY: number; before: string[]; after: string[] }
  | { kind: 'album-entry'; entryId: string; viewportOffset: number; fallbackScrollY: number; before: string[]; after: string[] };
export type ManagerNavigationIntent =
  | { kind: 'focus-complete-export' }
  | { kind: 'focus-intake-heading' }
  | { kind: 'open-recently-deleted'; focusMediaId: string }
  | { kind: 'edit-guest-gallery-availability'; returnTo: { section: 'gallery'; mode: 'guest-gallery'; publicationFilter: PublicationFilter } };
export type ManagerHistoryStateV1 = {
  version: 1; eventId: string;
  anchors?: Partial<Record<GalleryMode, GalleryAnchor>>;
  intent?: ManagerNavigationIntent;
};
export type RouterHistoryState = Record<string, unknown> & { __candidaryManager?: ManagerHistoryStateV1 };

type PlainRecord = Record<string, unknown>;
const modes = new Set<GalleryMode>(['library', 'album', 'guest-gallery']);
const filters = new Set<PublicationFilter>(['all', 'unpublished', 'published', 'hidden']);
const isRecord = (value: unknown): value is PlainRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readAnchor(value: unknown): GalleryAnchor | null {
  if (!isRecord(value) || (value.kind !== 'media' && value.kind !== 'album-entry')) return null;
  const id = value.kind === 'media' ? value.mediaId : value.entryId;
  if (!nonempty(id) || !finite(value.viewportOffset) || !finite(value.fallbackScrollY)) return null;
  if (!Array.isArray(value.before) || !Array.isArray(value.after)) return null;
  if (![...value.before, ...value.after].every(nonempty)) return null;
  return {
    kind: value.kind,
    ...(value.kind === 'media' ? { mediaId: id } : { entryId: id }),
    viewportOffset: value.viewportOffset,
    fallbackScrollY: value.fallbackScrollY,
    before: value.before.slice(0, 20), after: value.after.slice(0, 20),
  } as GalleryAnchor;
}

function readIntent(value: unknown): ManagerNavigationIntent | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'focus-complete-export' || value.kind === 'focus-intake-heading') {
    return Object.keys(value).length === 1 ? { kind: value.kind } : null;
  }
  if (value.kind === 'open-recently-deleted' && nonempty(value.focusMediaId)
    && Object.keys(value).length === 2) return { kind: value.kind, focusMediaId: value.focusMediaId };
  if (value.kind === 'edit-guest-gallery-availability' && isRecord(value.returnTo)
    && value.returnTo.section === 'gallery' && value.returnTo.mode === 'guest-gallery'
    && filters.has(value.returnTo.publicationFilter as PublicationFilter)
    && Object.keys(value).length === 2 && Object.keys(value.returnTo).length === 3) {
    return { kind: value.kind, returnTo: { section: 'gallery', mode: 'guest-gallery', publicationFilter: value.returnTo.publicationFilter as PublicationFilter } };
  }
  return null;
}

function compatible(intent: ManagerNavigationIntent, location: ManagerLocation): boolean {
  if (intent.kind === 'focus-intake-heading' || intent.kind === 'open-recently-deleted') return location.section === 'intake';
  if (intent.kind === 'edit-guest-gallery-availability') return location.section === 'settings' || (location.section === 'gallery' && location.mode === 'guest-gallery');
  return location.section === 'gallery' && location.mode === 'library';
}

function envelopeFrom(raw: unknown, eventId: string, location: ManagerLocation): ManagerHistoryStateV1 | null {
  if (!nonempty(eventId) || !isRecord(raw) || raw.version !== 1 || raw.eventId !== eventId) return null;
  const result: ManagerHistoryStateV1 = { version: 1, eventId };
  if (raw.anchors !== undefined) {
    if (!isRecord(raw.anchors)) return null;
    const anchors: Partial<Record<GalleryMode, GalleryAnchor>> = {};
    for (const mode of modes) {
      const anchor = readAnchor(raw.anchors[mode]);
      if (!anchor) {
        if (raw.anchors[mode] !== undefined) return null;
        continue;
      }
      const shouldKeep = mode === 'album' ? anchor.kind === 'album-entry' : anchor.kind === 'media';
      if (shouldKeep) anchors[mode] = anchor;
    }
    if (Object.keys(anchors).length) result.anchors = anchors;
  }
  if (raw.intent !== undefined) {
    const intent = readIntent(raw.intent);
    if (!intent) return null;
    if (compatible(intent, location)) result.intent = intent;
  }
  if (result.anchors === undefined && result.intent === undefined) return null;
  return result;
}

export function sanitizeManagerHistoryState(rawState: unknown, eventId: string, location: ManagerLocation): { state: RouterHistoryState; envelope: ManagerHistoryStateV1 | null; needsReplace: boolean } {
  const foreign = isRecord(rawState) ? { ...rawState } : {};
  const envelope = envelopeFrom(isRecord(rawState) ? rawState.__candidaryManager : undefined, eventId, location);
  if (envelope) foreign.__candidaryManager = envelope;
  else delete foreign.__candidaryManager;
  const inputEnvelope = isRecord(rawState) ? rawState.__candidaryManager : undefined;
  const hasEnvelope = isRecord(rawState) && Object.prototype.hasOwnProperty.call(rawState, '__candidaryManager');
  const needsReplace = hasEnvelope && (!envelope || !isCanonicalEnvelope(inputEnvelope, envelope));
  return { state: foreign, envelope, needsReplace };
}

function isCanonicalEnvelope(raw: unknown, envelope: ManagerHistoryStateV1): boolean {
  if (!isRecord(raw)) return false;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== 'version' && key !== 'eventId' && key !== 'anchors' && key !== 'intent')) return false;
  if (raw.version !== envelope.version || raw.eventId !== envelope.eventId) return false;
  if (raw.intent !== undefined && envelope.intent === undefined) return false;
  if (raw.anchors !== undefined && envelope.anchors === undefined) return false;
  if (raw.intent !== undefined && envelope.intent !== undefined && !sameIntent(raw.intent, envelope.intent)) return false;
  if (raw.anchors !== undefined && envelope.anchors !== undefined) {
    if (!isRecord(raw.anchors) || Object.keys(raw.anchors).some((key) => !modes.has(key as GalleryMode))) return false;
    for (const mode of modes) {
      const source = raw.anchors[mode];
      const target = envelope.anchors[mode];
      if (source === undefined && target === undefined) continue;
      if (!target || !sameAnchor(source, target)) return false;
    }
  }
  return true;
}

function sameAnchor(raw: unknown, target: GalleryAnchor): boolean {
  if (!isRecord(raw)) return false;
  const keys = Object.keys(raw);
  const expected = target.kind === 'media' ? ['kind', 'mediaId', 'viewportOffset', 'fallbackScrollY', 'before', 'after'] : ['kind', 'entryId', 'viewportOffset', 'fallbackScrollY', 'before', 'after'];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) return false;
  if (!Array.isArray(raw.before) || !Array.isArray(raw.after) || raw.before.length > 20 || raw.after.length > 20) return false;
  const source = readAnchor(raw);
  return !!source && JSON.stringify(source) === JSON.stringify(target);
}

function sameIntent(raw: unknown, target: ManagerNavigationIntent): boolean {
  const source = readIntent(raw);
  return !!source && JSON.stringify(source) === JSON.stringify(target);
}

export function withGalleryAnchor(rawState: unknown, eventId: string, mode: GalleryMode, anchor: GalleryAnchor | null): RouterHistoryState {
  const base = sanitizeManagerHistoryState(rawState, eventId, { section: 'gallery', mode }).state;
  const current = base.__candidaryManager ?? { version: 1 as const, eventId };
  const anchors = { ...(current.anchors ?? {}) };
  const validAnchor = anchor && readAnchor(anchor);
  if (validAnchor && (mode === 'album' ? validAnchor.kind === 'album-entry' : validAnchor.kind === 'media')) anchors[mode] = validAnchor;
  else if (!anchor) delete anchors[mode];
  const next: ManagerHistoryStateV1 = { ...current, version: 1, eventId };
  if (Object.keys(anchors).length) next.anchors = anchors; else delete next.anchors;
  if (!next.intent && !next.anchors) delete base.__candidaryManager; else base.__candidaryManager = next;
  return base;
}

export function withManagerIntent(rawState: unknown, eventId: string, intent: ManagerNavigationIntent): RouterHistoryState {
  const base = sanitizeManagerHistoryState(rawState, eventId, { section: 'gallery', mode: 'library' }).state;
  if (isRecord(rawState) && isRecord(rawState.__candidaryManager)) {
    const preserved = envelopeFrom(rawState.__candidaryManager, eventId, { section: 'gallery', mode: 'album' });
    if (preserved?.anchors) {
      const anchors: Partial<Record<GalleryMode, GalleryAnchor>> = {};
      for (const mode of modes) {
        const anchor = readAnchor((rawState.__candidaryManager.anchors as PlainRecord | undefined)?.[mode]);
        if (anchor && (mode === 'album' ? anchor.kind === 'album-entry' : anchor.kind === 'media')) anchors[mode] = anchor;
      }
      if (Object.keys(anchors).length) base.__candidaryManager = { ...(base.__candidaryManager ?? { version: 1, eventId }), anchors };
    }
  }
  const current = base.__candidaryManager ?? { version: 1 as const, eventId };
  const validIntent = readIntent(intent);
  if (validIntent) base.__candidaryManager = { ...current, version: 1, eventId, intent: validIntent };
  return base;
}

export function consumeManagerIntent(rawState: unknown, eventId: string, location: ManagerLocation): { state: RouterHistoryState; intent: ManagerNavigationIntent | null } {
  const clean = sanitizeManagerHistoryState(rawState, eventId, location);
  const intent = clean.envelope?.intent && compatible(clean.envelope.intent, location) ? clean.envelope.intent : null;
  const envelope = clean.envelope ? { ...clean.envelope } : null;
  if (envelope) delete envelope.intent;
  if (envelope?.anchors || intent === null && clean.envelope?.anchors) clean.state.__candidaryManager = envelope!;
  else delete clean.state.__candidaryManager;
  return { state: clean.state, intent };
}

export function anchorCandidateIds(anchor: GalleryAnchor): string[] {
  const exact = anchor.kind === 'media' ? anchor.mediaId : anchor.entryId;
  const after = anchor.after.slice(0, 20);
  const before = anchor.before.slice(0, 20);
  const nearby = Array.from({ length: Math.max(after.length, before.length) }, (_, index) => [after[index], before[index]].filter((value): value is string => typeof value === 'string'));
  return [exact, ...nearby.flat()];
}
