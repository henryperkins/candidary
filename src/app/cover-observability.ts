import type { EventCoverProfileId } from '../../shared/event-cover';

export interface CoverUnavailableObservation {
  audience: 'manager' | 'guest';
  profile: EventCoverProfileId;
  revision: number;
}

const emitted = new Set<string>();

/** Emits one allowlisted observation per audience/revision/profile tuple. */
export function emitCoverUnavailable(observation: CoverUnavailableObservation): boolean {
  const key = `${observation.audience}:${observation.revision}:${observation.profile}`;
  if (emitted.has(key)) return false;
  emitted.add(key);
  console.warn('cover_unavailable', {
    audience: observation.audience,
    profile: observation.profile,
    revision: observation.revision,
  });
  return true;
}
