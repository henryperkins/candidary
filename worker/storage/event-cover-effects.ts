import type {
  EventCoverEffectId,
  EventCoverTonalEffectVersion,
} from '../../shared/event-cover';

/** Immutable recipe 1, retained for legacy bare render-set rows. */
const TONAL_EFFECTS_V1: Record<EventCoverEffectId, ImageTransform> = {
  natural: { sharpen: 1 },
  warm: { gamma: 1.05, saturation: 1.08, contrast: 0.96, sharpen: 1 },
  film: { contrast: 1.12, saturation: 0.88, sharpen: 1 },
  soft: { brightness: 1.06, contrast: 0.9, sharpen: 0.6 },
  monochrome: { saturation: 0, contrast: 1.05, sharpen: 1 },
};

/** Calibrated recipe 2. Film grain remains a separate runtime CSS layer. */
const TONAL_EFFECTS_V2: Record<EventCoverEffectId, ImageTransform> = {
  natural: { sharpen: 1 },
  warm: { saturation: 1.04, contrast: 0.99, sharpen: 1 },
  film: { contrast: 0.95, saturation: 0.8, sharpen: 1 },
  soft: { saturation: 0.96, contrast: 0.92, sharpen: 0.6 },
  monochrome: { saturation: 0, contrast: 1.02, sharpen: 1 },
};

const TONAL_EFFECTS: Record<
  EventCoverTonalEffectVersion,
  Record<EventCoverEffectId, ImageTransform>
> = {
  1: TONAL_EFFECTS_V1,
  2: TONAL_EFFECTS_V2,
};

// Valid 1x1 RGBA PNG: the sole opaque pixel is exactly #e7b78d.
const WARM_WASH_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0xda, 0x63, 0x78, 0xbe, 0xbd, 0xf7,
  0x3f, 0x00, 0x07, 0xdf, 0x03, 0x2b, 0x3d, 0x10,
  0x80, 0xaa, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function warmWashStream(): ReadableStream<Uint8Array> {
  const bytes = WARM_WASH_PNG.buffer.slice(
    WARM_WASH_PNG.byteOffset,
    WARM_WASH_PNG.byteOffset + WARM_WASH_PNG.byteLength,
  ) as ArrayBuffer;
  return new Response(bytes).body!;
}

export function applyCoverTonalEffect(
  transformer: ImageTransformer,
  effect: EventCoverEffectId,
  tonalEffectVersion: EventCoverTonalEffectVersion,
): ImageTransformer {
  const transformed = transformer.transform(TONAL_EFFECTS[tonalEffectVersion][effect]);
  if (effect !== 'warm' || tonalEffectVersion !== 2) return transformed;
  return transformed.draw(warmWashStream(), {
    opacity: 0.05,
    repeat: true,
    composite: 'over',
  });
}
