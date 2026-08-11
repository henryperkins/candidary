/** The four independent facts that must all be zero before phase 3 can open. */
export const ZERO_LEGACY_PROOF_NAMES = [
  'legacyRows',
  'blockingJobs',
  'incompleteActiveSets',
  'uploadsWithoutActiveSet',
] as const;

export type ZeroLegacyProofName = typeof ZERO_LEGACY_PROOF_NAMES[number];

export interface ZeroLegacyProofCounts {
  legacyRows: number;
  blockingJobs: number;
  incompleteActiveSets: number;
  uploadsWithoutActiveSet: number;
}

interface ProofPredicate {
  name: ZeroLegacyProofName;
  /** Begins with FROM and contains the complete red-row predicate. */
  fromSql: string;
}

/**
 * One source for the operator counts and both guarded transition predicates.
 *
 * These fragments are deliberately static. The launcher displays them and the
 * Worker embeds them in the statement that changes a run's status; neither side
 * is allowed to maintain a near-copy of what "zero legacy" means.
 */
const PROOF_PREDICATES: readonly ProofPredicate[] = [
  {
    name: 'legacyRows',
    fromSql: `FROM events e
      WHERE e.deleted_at IS NULL
        AND e.cover_object_key IS NOT NULL
        AND e.cover_render_set_id IS NULL`,
  },
  {
    name: 'blockingJobs',
    fromSql: `FROM event_cover_backfill_jobs j
      JOIN events e ON e.id = j.event_id
      WHERE j.status IN ('needs_replacement', 'failed')
        AND e.deleted_at IS NULL
        AND e.cover_object_key IS NOT NULL
        AND e.cover_render_set_id IS NULL`,
  },
  {
    name: 'incompleteActiveSets',
    fromSql: `FROM event_cover_render_sets s
      WHERE s.state = 'active'
        AND (
          s.manifest_sha256 IS NULL
          OR s.required_slots <> (
            SELECT count(*) FROM event_cover_render_objects o
            WHERE o.render_set_id = s.id
          )
          OR s.required_slots <> (
            SELECT count(*) FROM event_cover_render_objects o
            WHERE o.render_set_id = s.id AND o.event_id = s.event_id
          )
        )`,
  },
  {
    name: 'uploadsWithoutActiveSet',
    fromSql: `FROM events e
      WHERE e.deleted_at IS NULL
        AND json_extract(e.cover_config, '$.source.kind') = 'upload'
        AND (
          e.cover_object_key IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM event_cover_render_sets s
            JOIN event_cover_masters m ON m.id = s.master_id
            WHERE s.id = e.cover_render_set_id
              AND s.event_id = e.id
              AND s.state = 'active'
              AND m.event_id = e.id
              AND m.object_key = e.cover_object_key
          )
        )`,
  },
] as const;

/** One four-row query suitable for `wrangler d1 execute --json`. */
export function zeroLegacyProofRowsSql(): string {
  return PROOF_PREDICATES.map(({ name, fromSql }, index) => (
    `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} '${name}' AS name, count(*) AS value ${fromSql}`
  )).join('\n');
}

/** SQL boolean embedded directly in the only authoritative verified UPDATE. */
export function zeroLegacyProofAllZeroSql(): string {
  return PROOF_PREDICATES
    .map(({ fromSql }) => `NOT EXISTS (SELECT 1 ${fromSql})`)
    .join('\n      AND ');
}

/** SQL boolean embedded directly in the guarded red-to-failed UPDATE. */
export function zeroLegacyProofAnyRedSql(): string {
  return PROOF_PREDICATES
    .map(({ fromSql }) => `EXISTS (SELECT 1 ${fromSql})`)
    .join('\n      OR ');
}
