import {
  allCover2xProfiles,
  coverHasSource,
  coverSurfaceTreatment,
  EVENT_COVER_PROFILES,
  type EventCoverPreparationView,
  type EventCoverProfileId,
  type EventCoverView,
  type GuestEventCoverView,
  parseStoredCoverConfig,
} from '../../shared/event-cover';
import type { EventRecord } from '../db/types';

const PROFILE_IDS = new Set<EventCoverProfileId>(
  EVENT_COVER_PROFILES.map((profile) => profile.id),
);

type ProjectionInvariantReason =
  | 'stored-config-invalid'
  | 'revision-invalid'
  | 'semantic-pointer-mismatch'
  | 'upload-pointer-missing'
  | 'active-set-mismatch'
  | 'render-profile-invalid';

function projectionInvariant(reason: ProjectionInvariantReason): never {
  // No event ID, object key, recipe, Workflow ID, or database error belongs in
  // this observation. The reason is a closed product enum and the request ID in
  // the ordinary 500 response remains the correlation handle.
  console.error(JSON.stringify({ event: 'cover_projection_invariant_failed', reason }));
  throw new Error('Event cover projection invariant failed.');
}

function storedConfig(event: EventRecord) {
  let value: unknown;
  try {
    value = JSON.parse(event.coverConfig);
  } catch {
    return projectionInvariant('stored-config-invalid');
  }
  return parseStoredCoverConfig(value) ?? projectionInvariant('stored-config-invalid');
}

/**
 * Builds the manager-owned cover projection from the durable semantic row and
 * the inventory belonging to its one current active set.
 *
 * D1 pointers remain private. Optional 2x capability is proven from paired
 * WebP/JPEG rows in the current set, never inferred from source geometry and
 * never assembled across sets.
 */
export async function selectManagerEventCoverView(
  db: D1Database,
  event: EventRecord,
  preparation: EventCoverPreparationView | null,
): Promise<EventCoverView> {
  const config = storedConfig(event);
  if (!Number.isSafeInteger(event.coverRevision) || event.coverRevision < 0) {
    return projectionInvariant('revision-invalid');
  }

  if (config.source.kind !== 'upload') {
    if (event.coverObjectKey !== null || event.coverRenderSetId !== null) {
      return projectionInvariant('semantic-pointer-mismatch');
    }
    return {
      config,
      revision: event.coverRevision,
      hasCover: coverHasSource(config),
      available2xProfiles: config.source.kind === 'preset' ? allCover2xProfiles() : [],
      surfaceTreatment: coverSurfaceTreatment(config),
      preparation,
    };
  }

  if (!event.coverObjectKey || !event.coverRenderSetId) {
    return projectionInvariant('upload-pointer-missing');
  }

  const active = await db.prepare(`
    SELECT s.id
    FROM event_cover_render_sets s
    JOIN event_cover_masters m
      ON m.id = s.master_id AND m.event_id = s.event_id
    WHERE s.id = ? AND s.event_id = ? AND s.state = 'active'
      AND s.manifest_sha256 IS NOT NULL
      AND s.published_revision = ?
      AND m.object_key = ?
    LIMIT 1
  `).bind(
    event.coverRenderSetId,
    event.id,
    event.coverRevision,
    event.coverObjectKey,
  ).first<{ id: string }>();
  if (!active) return projectionInvariant('active-set-mismatch');

  const inventory = await db.prepare(`
    SELECT profile_id
    FROM event_cover_render_objects
    WHERE render_set_id = ? AND event_id = ? AND density = '2x'
    GROUP BY profile_id
    HAVING count(*) = 2
      AND sum(CASE WHEN format = 'webp' THEN 1 ELSE 0 END) = 1
      AND sum(CASE WHEN format = 'jpeg' THEN 1 ELSE 0 END) = 1
    ORDER BY profile_id COLLATE BINARY
  `).bind(event.coverRenderSetId, event.id).all<{ profile_id: string }>();

  const available2xProfiles = inventory.results.map(({ profile_id: profileId }) => {
    if (!PROFILE_IDS.has(profileId as EventCoverProfileId)) {
      return projectionInvariant('render-profile-invalid');
    }
    return profileId as EventCoverProfileId;
  });

  return {
    config,
    revision: event.coverRevision,
    hasCover: true,
    available2xProfiles,
    surfaceTreatment: coverSurfaceTreatment(config),
    preparation,
  };
}

/** An explicit allowlist, so manager-only fields cannot drift into guest JSON. */
export function guestCoverView(managerCover: EventCoverView): GuestEventCoverView {
  return {
    revision: managerCover.revision,
    hasCover: managerCover.hasCover,
    available2xProfiles: managerCover.available2xProfiles,
    surfaceTreatment: managerCover.surfaceTreatment,
  };
}
