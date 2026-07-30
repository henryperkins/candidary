import { z } from 'zod';

import type {
  EventThemeConfigV1,
  EventThemeOverridesV1,
  EventThemePresetId,
  EventThemeTokens,
  HexColor,
  ResolvedEventTheme,
  RgbaColor,
} from './contracts';

export const EVENT_THEME_VERSION = 1 as const;

export const EVENT_THEME_PRESET_IDS = [
  'candidary-default',
  'garden-party',
  'midnight-film',
  'coastal-light',
] as const satisfies readonly EventThemePresetId[];

const hexColorSchema = z.string()
  .regex(/^#[0-9a-fA-F]{6}$/u)
  .transform((value) => value.toLowerCase() as HexColor);

const rawEventThemeConfigSchema = z.strictObject({
  version: z.literal(EVENT_THEME_VERSION),
  presetId: z.enum(EVENT_THEME_PRESET_IDS),
  overrides: z.strictObject({
    primaryColor: hexColorSchema.optional(),
    accentColor: hexColorSchema.optional(),
  }),
});

interface EventThemePreset {
  id: EventThemePresetId;
  name: string;
  description: string;
  tokens: EventThemeTokens;
}

const tokens = (value: EventThemeTokens) => value;

export const EVENT_THEME_PRESETS: readonly EventThemePreset[] = [
  {
    id: 'candidary-default',
    name: 'Candidary Default',
    description: 'Warm chestnut and denim, matching the Candidary guest experience.',
    tokens: tokens({
      page: '#f7f1e7', surface: '#fffaf3', raisedSurface: '#ffffff', text: '#352924', pageText: '#2b1d17', cardText: '#4a413e', mutedText: '#776e6a', secondaryMutedText: '#766c70', quietText: '#665c58', requiredText: '#8b4b31', selectionSummaryText: '#6f6561', primary: '#4a2415', primaryForeground: '#ffffff', primaryHover: '#31170c', primaryOnSurface: '#4a2415', primaryShadow: 'rgb(74 36 21 / 13%)', accent: '#3f6d95', accentForeground: '#ffffff', accentSoft: '#dde7f0', accentSoftForeground: '#4a2415', border: '#e3dcd8', sectionBorder: '#d9cec2', rememberedNameBorder: '#dfd7d4', reviewDivider: '#eae2df', inputBorder: '#928a84', focus: '#2c5c85', mediaPlaceholderStart: '#e9ddd5', mediaPlaceholderEnd: '#cbbbb5', mediaPlaceholderForeground: '#806d65', heroStart: '#634134', heroMid: '#a06e5a', heroEnd: '#d98b6a', heroOverlayTop: 'rgb(31 15 9 / 10%)', heroOverlayBottom: 'rgb(31 15 9 / 52%)', coverOverlayTop: 'rgb(31 15 9 / 5%)', coverOverlayBottom: 'rgb(31 15 9 / 62%)', coverTextScrim: 'rgb(31 15 9 / 64%)', fullscreenBackdrop: '#170e0a', fullscreenForeground: '#ffffff', inputShadow: 'rgb(43 29 23 / 4%)', frameShadow: 'rgb(54 37 30 / 13%)', inputRadius: '11px', actionRadius: '12px', cardRadius: '10px', frameRadius: '25px',
    }),
  },
  {
    id: 'garden-party',
    name: 'Garden Party',
    description: 'Verdant greens with soft terracotta accents.',
    tokens: tokens({
      page: '#f2f1e8', surface: '#fffcf5', raisedSurface: '#ffffff', text: '#1f3028', pageText: '#17271f', cardText: '#2b3e34', mutedText: '#5b6b62', secondaryMutedText: '#53675d', quietText: '#4d6258', requiredText: '#8a4036', selectionSummaryText: '#53675d', primary: '#245c46', primaryForeground: '#ffffff', primaryHover: '#194b38', primaryOnSurface: '#245c46', primaryShadow: 'rgb(36 92 70 / 13%)', accent: '#c36f42', accentForeground: '#111111', accentSoft: '#f8ebe0', accentSoftForeground: '#1f3028', border: '#d7d9ca', sectionBorder: '#cbd1c2', rememberedNameBorder: '#d3d8ce', reviewDivider: '#e1e2d7', inputBorder: '#788b80', focus: '#6f3e7c', mediaPlaceholderStart: '#dde1d2', mediaPlaceholderEnd: '#b9c6b5', mediaPlaceholderForeground: '#526d5c', heroStart: '#244d3e', heroMid: '#5f7a53', heroEnd: '#c18a58', heroOverlayTop: 'rgb(14 34 27 / 10%)', heroOverlayBottom: 'rgb(14 34 27 / 54%)', coverOverlayTop: 'rgb(14 34 27 / 8%)', coverOverlayBottom: 'rgb(14 34 27 / 64%)', coverTextScrim: 'rgb(14 34 27 / 64%)', fullscreenBackdrop: '#10231b', fullscreenForeground: '#ffffff', inputShadow: 'rgb(23 39 31 / 4%)', frameShadow: 'rgb(31 48 40 / 13%)', inputRadius: '14px', actionRadius: '16px', cardRadius: '16px', frameRadius: '28px',
    }),
  },
  {
    id: 'midnight-film',
    name: 'Midnight Film',
    description: 'Ink-blue evening tones with a cinematic warmth.',
    tokens: tokens({
      page: '#eef1f7', surface: '#fafbff', raisedSurface: '#ffffff', text: '#192136', pageText: '#11182c', cardText: '#283047', mutedText: '#5d667b', secondaryMutedText: '#566177', quietText: '#4f5a70', requiredText: '#8b3f5b', selectionSummaryText: '#566177', primary: '#263868', primaryForeground: '#ffffff', primaryHover: '#1d2b55', primaryOnSurface: '#263868', primaryShadow: 'rgb(38 56 104 / 13%)', accent: '#b7693f', accentForeground: '#111111', accentSoft: '#f2e9e8', accentSoftForeground: '#192136', border: '#d5d9e4', sectionBorder: '#c6ccdb', rememberedNameBorder: '#d4d9e5', reviewDivider: '#e1e4ed', inputBorder: '#7c879f', focus: '#7551a6', mediaPlaceholderStart: '#dce1eb', mediaPlaceholderEnd: '#b8c0d1', mediaPlaceholderForeground: '#59657f', heroStart: '#1d294e', heroMid: '#4a3e68', heroEnd: '#8b4e5a', heroOverlayTop: 'rgb(9 16 37 / 8%)', heroOverlayBottom: 'rgb(9 16 37 / 52%)', coverOverlayTop: 'rgb(9 16 37 / 6%)', coverOverlayBottom: 'rgb(9 16 37 / 62%)', coverTextScrim: 'rgb(9 16 37 / 64%)', fullscreenBackdrop: '#0b1020', fullscreenForeground: '#ffffff', inputShadow: 'rgb(17 24 44 / 4%)', frameShadow: 'rgb(25 33 54 / 13%)', inputRadius: '7px', actionRadius: '8px', cardRadius: '7px', frameRadius: '14px',
    }),
  },
  {
    id: 'coastal-light',
    name: 'Coastal Light',
    description: 'Sea-glass teal with a bright coral accent.',
    tokens: tokens({
      page: '#edf7f5', surface: '#fffefa', raisedSurface: '#ffffff', text: '#17343a', pageText: '#0d2a30', cardText: '#24464b', mutedText: '#526d72', secondaryMutedText: '#4b686d', quietText: '#456267', requiredText: '#913c46', selectionSummaryText: '#4b686d', primary: '#0c6370', primaryForeground: '#ffffff', primaryHover: '#08505a', primaryOnSurface: '#0c6370', primaryShadow: 'rgb(12 99 112 / 13%)', accent: '#c85f50', accentForeground: '#111111', accentSoft: '#f8ebe6', accentSoftForeground: '#17343a', border: '#cfe2df', sectionBorder: '#bdd7d4', rememberedNameBorder: '#c9dfdc', reviewDivider: '#dcebe8', inputBorder: '#748f92', focus: '#6c3c78', mediaPlaceholderStart: '#dcecea', mediaPlaceholderEnd: '#adcfcf', mediaPlaceholderForeground: '#48777b', heroStart: '#0b5965', heroMid: '#4a8c91', heroEnd: '#d27a62', heroOverlayTop: 'rgb(5 31 35 / 14%)', heroOverlayBottom: 'rgb(5 31 35 / 54%)', coverOverlayTop: 'rgb(5 31 35 / 8%)', coverOverlayBottom: 'rgb(5 31 35 / 64%)', coverTextScrim: 'rgb(5 31 35 / 64%)', fullscreenBackdrop: '#071d21', fullscreenForeground: '#ffffff', inputShadow: 'rgb(13 42 48 / 4%)', frameShadow: 'rgb(23 52 58 / 13%)', inputRadius: '12px', actionRadius: '14px', cardRadius: '12px', frameRadius: '20px',
    }),
  },
];

const presetById = new Map(EVENT_THEME_PRESETS.map((preset) => [preset.id, preset]));

function presetFor(presetId: EventThemePresetId): EventThemePreset {
  const preset = presetById.get(presetId);
  if (!preset) throw new Error(`Unknown event theme preset: ${presetId}`);
  return preset;
}

function canonicalConfig(
  presetId: EventThemePresetId,
  overrides: EventThemeOverridesV1 = {},
): EventThemeConfigV1 {
  const normalizedOverrides: EventThemeOverridesV1 = {};
  if (overrides.primaryColor) normalizedOverrides.primaryColor = overrides.primaryColor;
  if (overrides.accentColor) normalizedOverrides.accentColor = overrides.accentColor;
  return { version: EVENT_THEME_VERSION, presetId, overrides: normalizedOverrides };
}

export const DEFAULT_EVENT_THEME_CONFIG: EventThemeConfigV1 = canonicalConfig('candidary-default');

export function normalizeEventThemeConfig(input: EventThemeConfigV1): EventThemeConfigV1 {
  const preset = presetFor(input.presetId);
  const overrides: EventThemeOverridesV1 = {};
  if (input.overrides.primaryColor && input.overrides.primaryColor !== preset.tokens.primary) {
    overrides.primaryColor = input.overrides.primaryColor;
  }
  if (input.overrides.accentColor && input.overrides.accentColor !== preset.tokens.accent) {
    overrides.accentColor = input.overrides.accentColor;
  }
  return canonicalConfig(input.presetId, overrides);
}

export const eventThemeConfigSchema = rawEventThemeConfigSchema.transform(normalizeEventThemeConfig);

function freshDefaultConfig(): EventThemeConfigV1 {
  return canonicalConfig('candidary-default');
}

export function parseStoredEventThemeConfig(value: unknown): EventThemeConfigV1 {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return eventThemeConfigSchema.parse(parsed);
  } catch {
    return freshDefaultConfig();
  }
}

export function serializeEventThemeConfig(config: EventThemeConfigV1): string {
  const normalized = eventThemeConfigSchema.parse(config);
  const overrides: EventThemeOverridesV1 = {};
  if (normalized.overrides.primaryColor) overrides.primaryColor = normalized.overrides.primaryColor;
  if (normalized.overrides.accentColor) overrides.accentColor = normalized.overrides.accentColor;
  return JSON.stringify({
    version: EVENT_THEME_VERSION,
    presetId: normalized.presetId,
    overrides,
  });
}

function parseHex(value: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) throw new Error(`Expected six-digit hex color, received ${value}`);
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

function serializeHex(channels: readonly number[]): HexColor {
  return `#${channels.map((channel) => Math.min(255, Math.max(0, Math.round(channel))).toString(16).padStart(2, '0')).join('')}` as HexColor;
}

function blend(source: HexColor, target: HexColor, targetWeight: number): HexColor {
  const [sourceRed, sourceGreen, sourceBlue] = parseHex(source);
  const [targetRed, targetGreen, targetBlue] = parseHex(target);
  return serializeHex([
    sourceRed * (1 - targetWeight) + targetRed * targetWeight,
    sourceGreen * (1 - targetWeight) + targetGreen * targetWeight,
    sourceBlue * (1 - targetWeight) + targetBlue * targetWeight,
  ]);
}

function rgba(color: HexColor, alpha: number): RgbaColor {
  const [red, green, blue] = parseHex(color);
  return `rgb(${red} ${green} ${blue} / ${alpha}%)` as RgbaColor;
}

function luminance(color: string): number {
  const linearize = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = parseHex(color);
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function highestContrast(candidates: readonly HexColor[], background: HexColor): HexColor {
  return candidates.reduce((best, candidate) => (
    contrastRatio(candidate, background) > contrastRatio(best, background) ? candidate : best
  ));
}

function passingForeground(candidates: readonly HexColor[], background: HexColor): HexColor | undefined {
  const candidate = highestContrast(candidates, background);
  return contrastRatio(candidate, background) >= 4.5 ? candidate : undefined;
}

function passesAgainstSurfaces(color: HexColor, tokens: EventThemeTokens): boolean {
  return [tokens.page, tokens.surface, tokens.raisedSurface]
    .every((surface) => contrastRatio(color, surface) >= 4.5);
}

function resolvePrimaryOnSurface(primary: HexColor, tokens: EventThemeTokens): HexColor {
  if (passesAgainstSurfaces(primary, tokens)) return primary;
  for (let weight = 0.05; weight < 1; weight += 0.05) {
    const candidate = blend(primary, tokens.text, weight);
    if (passesAgainstSurfaces(candidate, tokens)) return candidate;
  }
  return tokens.text;
}

export class EventThemeResolutionError extends Error {
  constructor(
    public readonly field: 'overrides.primaryColor' | 'overrides.accentColor',
    message: string,
  ) {
    super(message);
    this.name = 'EventThemeResolutionError';
  }
}

export function resolveEventTheme(input: EventThemeConfigV1): ResolvedEventTheme {
  const config = normalizeEventThemeConfig(input);
  const preset = presetFor(config.presetId);
  const resolvedTokens: EventThemeTokens = { ...preset.tokens };

  if (config.overrides.primaryColor) {
    const primary = config.overrides.primaryColor;
    const foreground = passingForeground(['#ffffff', '#111111'], primary);
    if (!foreground) {
      throw new EventThemeResolutionError('overrides.primaryColor', 'Primary color needs a 4.5:1 foreground contrast ratio.');
    }
    resolvedTokens.primary = primary;
    resolvedTokens.primaryForeground = foreground;
    resolvedTokens.primaryHover = blend(primary, foreground === '#ffffff' ? '#000000' : '#ffffff', 0.1);
    resolvedTokens.primaryOnSurface = resolvePrimaryOnSurface(primary, resolvedTokens);
    resolvedTokens.primaryShadow = rgba(primary, 13);
  }

  if (config.overrides.accentColor) {
    const accent = config.overrides.accentColor;
    const accentForeground = contrastRatio(resolvedTokens.accentForeground, accent) >= 4.5
      ? resolvedTokens.accentForeground
      : passingForeground(['#ffffff', '#111111'], accent);
    if (!accentForeground) {
      throw new EventThemeResolutionError('overrides.accentColor', 'Accent color needs a 4.5:1 foreground contrast ratio.');
    }
    const [softRed, softGreen, softBlue] = parseHex(preset.tokens.accentSoft);
    const [accentRed, accentGreen, accentBlue] = parseHex(accent);
    const [presetAccentRed, presetAccentGreen, presetAccentBlue] = parseHex(preset.tokens.accent);
    const soft = serializeHex([
      softRed + 0.12 * (accentRed - presetAccentRed),
      softGreen + 0.12 * (accentGreen - presetAccentGreen),
      softBlue + 0.12 * (accentBlue - presetAccentBlue),
    ]);
    const softForeground = contrastRatio(resolvedTokens.accentSoftForeground, soft) >= 4.5
      ? resolvedTokens.accentSoftForeground
      : passingForeground([preset.tokens.text, '#111111', '#ffffff'], soft);
    if (!softForeground) {
      throw new EventThemeResolutionError('overrides.accentColor', 'Accent soft treatment needs a 4.5:1 foreground contrast ratio.');
    }
    resolvedTokens.accent = accent;
    resolvedTokens.accentForeground = accentForeground;
    resolvedTokens.accentSoft = soft;
    resolvedTokens.accentSoftForeground = softForeground;
  }

  return { config, tokens: resolvedTokens };
}

export function resolvedThemeView(input: EventThemeConfigV1): ResolvedEventTheme {
  try {
    return resolveEventTheme(input);
  } catch (error) {
    if (error instanceof EventThemeResolutionError) {
      return resolveEventTheme(freshDefaultConfig());
    }
    throw error;
  }
}
