import type {
  EventCoverDensity,
  EventCoverEffectId,
  EventCoverFormat,
  EventCoverPresetId,
  EventCoverProfileId,
} from './event-cover';

export interface EventCoverAssetSlot {
  profile: EventCoverProfileId;
  density: EventCoverDensity;
  format: EventCoverFormat;
}

/**
 * The one static preset path contract used by generation, verification,
 * delivery, and browser preview code.
 *
 * Preset assets are global release data. The path therefore contains the
 * immutable asset version and semantic recipe, but never an event identifier.
 */
export function presetCoverAssetPath(
  assetVersion: number,
  presetId: EventCoverPresetId,
  effect: EventCoverEffectId,
  profile: EventCoverProfileId,
  density: EventCoverDensity,
  format: EventCoverFormat,
): string {
  return `/assets/event-covers/v${assetVersion}/${presetId}/${effect}/${profile}-${density}.${format}`;
}
