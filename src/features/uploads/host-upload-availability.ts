import type { EventView } from '../../../shared/contracts';
import type { LoadFailure } from '../../components/States';

export function resolveHostUploadAvailability(
  projected: EventView['hostUploadAvailability'],
  failure: LoadFailure | null,
): EventView['hostUploadAvailability'] {
  return failure?.kind === 'ended-event'
    ? { enabled: false, reason: 'event-unavailable' }
    : projected;
}
