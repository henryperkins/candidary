import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EVENT_THEME_CONFIG,
  EVENT_THEME_PRESET_IDS,
  EVENT_THEME_PRESETS,
  assertOverridesLegible,
  contrastRatio,
  eventThemeConfigSchema,
  parseStoredEventThemeConfig,
  resolveEventTheme,
  resolvedThemeView,
  serializeEventThemeConfig,
} from '../../shared/event-theme';
import type { EventThemeResolutionError } from '../../shared/event-theme';
import type { EventThemeConfigV1, HexColor } from '../../shared/contracts';

const EXPECTED_TOKENS = {
  'candidary-default': {
    page: '#f7f1e7', surface: '#fffaf3', raisedSurface: '#ffffff', text: '#352924', pageText: '#2b1d17', cardText: '#4a413e', mutedText: '#776e6a', secondaryMutedText: '#766c70', quietText: '#665c58', requiredText: '#8b4b31', selectionSummaryText: '#6f6561', primary: '#4a2415', primaryForeground: '#ffffff', primaryHover: '#31170c', primaryOnSurface: '#4a2415', primaryShadow: 'rgb(74 36 21 / 13%)', accent: '#3f6d95', accentForeground: '#ffffff', accentSoft: '#dde7f0', accentSoftForeground: '#4a2415', border: '#e3dcd8', sectionBorder: '#d9cec2', rememberedNameBorder: '#dfd7d4', reviewDivider: '#eae2df', inputBorder: '#928a84', focus: '#2c5c85', mediaPlaceholderStart: '#e9ddd5', mediaPlaceholderEnd: '#cbbbb5', mediaPlaceholderForeground: '#806d65', heroStart: '#634134', heroMid: '#a06e5a', heroEnd: '#d98b6a', heroOverlayTop: 'rgb(31 15 9 / 10%)', heroOverlayBottom: 'rgb(31 15 9 / 52%)', coverOverlayTop: 'rgb(31 15 9 / 5%)', coverOverlayBottom: 'rgb(31 15 9 / 62%)', coverTextScrim: 'rgb(31 15 9 / 64%)', fullscreenBackdrop: '#170e0a', fullscreenForeground: '#ffffff', inputShadow: 'rgb(43 29 23 / 4%)', frameShadow: 'rgb(54 37 30 / 13%)', inputRadius: '11px', actionRadius: '12px', cardRadius: '10px', frameRadius: '25px',
  },
  'garden-party': {
    page: '#f2f1e8', surface: '#fffcf5', raisedSurface: '#ffffff', text: '#1f3028', pageText: '#17271f', cardText: '#2b3e34', mutedText: '#5b6b62', secondaryMutedText: '#53675d', quietText: '#4d6258', requiredText: '#8a4036', selectionSummaryText: '#53675d', primary: '#245c46', primaryForeground: '#ffffff', primaryHover: '#194b38', primaryOnSurface: '#245c46', primaryShadow: 'rgb(36 92 70 / 13%)', accent: '#c36f42', accentForeground: '#111111', accentSoft: '#f8ebe0', accentSoftForeground: '#1f3028', border: '#d7d9ca', sectionBorder: '#cbd1c2', rememberedNameBorder: '#d3d8ce', reviewDivider: '#e1e2d7', inputBorder: '#788b80', focus: '#6f3e7c', mediaPlaceholderStart: '#dde1d2', mediaPlaceholderEnd: '#b9c6b5', mediaPlaceholderForeground: '#526d5c', heroStart: '#244d3e', heroMid: '#5f7a53', heroEnd: '#c18a58', heroOverlayTop: 'rgb(14 34 27 / 10%)', heroOverlayBottom: 'rgb(14 34 27 / 54%)', coverOverlayTop: 'rgb(14 34 27 / 8%)', coverOverlayBottom: 'rgb(14 34 27 / 64%)', coverTextScrim: 'rgb(14 34 27 / 64%)', fullscreenBackdrop: '#10231b', fullscreenForeground: '#ffffff', inputShadow: 'rgb(23 39 31 / 4%)', frameShadow: 'rgb(31 48 40 / 13%)', inputRadius: '14px', actionRadius: '16px', cardRadius: '16px', frameRadius: '28px',
  },
  'midnight-film': {
    page: '#eef1f7', surface: '#fafbff', raisedSurface: '#ffffff', text: '#192136', pageText: '#11182c', cardText: '#283047', mutedText: '#5d667b', secondaryMutedText: '#566177', quietText: '#4f5a70', requiredText: '#8b3f5b', selectionSummaryText: '#566177', primary: '#263868', primaryForeground: '#ffffff', primaryHover: '#1d2b55', primaryOnSurface: '#263868', primaryShadow: 'rgb(38 56 104 / 13%)', accent: '#b7693f', accentForeground: '#111111', accentSoft: '#f2e9e8', accentSoftForeground: '#192136', border: '#d5d9e4', sectionBorder: '#c6ccdb', rememberedNameBorder: '#d4d9e5', reviewDivider: '#e1e4ed', inputBorder: '#7c879f', focus: '#7551a6', mediaPlaceholderStart: '#dce1eb', mediaPlaceholderEnd: '#b8c0d1', mediaPlaceholderForeground: '#59657f', heroStart: '#1d294e', heroMid: '#4a3e68', heroEnd: '#8b4e5a', heroOverlayTop: 'rgb(9 16 37 / 8%)', heroOverlayBottom: 'rgb(9 16 37 / 52%)', coverOverlayTop: 'rgb(9 16 37 / 6%)', coverOverlayBottom: 'rgb(9 16 37 / 62%)', coverTextScrim: 'rgb(9 16 37 / 64%)', fullscreenBackdrop: '#0b1020', fullscreenForeground: '#ffffff', inputShadow: 'rgb(17 24 44 / 4%)', frameShadow: 'rgb(25 33 54 / 13%)', inputRadius: '7px', actionRadius: '8px', cardRadius: '7px', frameRadius: '14px',
  },
  'coastal-light': {
    page: '#edf7f5', surface: '#fffefa', raisedSurface: '#ffffff', text: '#17343a', pageText: '#0d2a30', cardText: '#24464b', mutedText: '#526d72', secondaryMutedText: '#4b686d', quietText: '#456267', requiredText: '#913c46', selectionSummaryText: '#4b686d', primary: '#0c6370', primaryForeground: '#ffffff', primaryHover: '#08505a', primaryOnSurface: '#0c6370', primaryShadow: 'rgb(12 99 112 / 13%)', accent: '#c85f50', accentForeground: '#111111', accentSoft: '#f8ebe6', accentSoftForeground: '#17343a', border: '#cfe2df', sectionBorder: '#bdd7d4', rememberedNameBorder: '#c9dfdc', reviewDivider: '#dcebe8', inputBorder: '#748f92', focus: '#6c3c78', mediaPlaceholderStart: '#dcecea', mediaPlaceholderEnd: '#adcfcf', mediaPlaceholderForeground: '#48777b', heroStart: '#0b5965', heroMid: '#4a8c91', heroEnd: '#d27a62', heroOverlayTop: 'rgb(5 31 35 / 14%)', heroOverlayBottom: 'rgb(5 31 35 / 54%)', coverOverlayTop: 'rgb(5 31 35 / 8%)', coverOverlayBottom: 'rgb(5 31 35 / 64%)', coverTextScrim: 'rgb(5 31 35 / 64%)', fullscreenBackdrop: '#071d21', fullscreenForeground: '#ffffff', inputShadow: 'rgb(13 42 48 / 4%)', frameShadow: 'rgb(23 52 58 / 13%)', inputRadius: '12px', actionRadius: '14px', cardRadius: '12px', frameRadius: '20px',
  },
} as const;

const RGBA = /^rgb\([0-9]{1,3} [0-9]{1,3} [0-9]{1,3} \/ [0-9]{1,3}%\)$/u;
const HEX = /^#[0-9a-f]{6}$/u;

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function composite(foreground: string, background: [number, number, number], alpha: number): [number, number, number] {
  const [foregroundRed, foregroundGreen, foregroundBlue] = rgb(foreground);
  const [backgroundRed, backgroundGreen, backgroundBlue] = background;
  return [
    Math.round(foregroundRed * alpha + backgroundRed * (1 - alpha)),
    Math.round(foregroundGreen * alpha + backgroundGreen * (1 - alpha)),
    Math.round(foregroundBlue * alpha + backgroundBlue * (1 - alpha)),
  ];
}

function toHex(channels: [number, number, number]) {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function noCoverPixel(tokens: (typeof EXPECTED_TOKENS)[keyof typeof EXPECTED_TOKENS], x: number, y: number, width: number, height: number) {
  // CSS linear-gradient(145deg): project each pixel onto its gradient line, then
  // interpolate the 0%, 53%, and 100% stops before compositing the 180deg overlay.
  const radians = 145 * Math.PI / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const corners = [[0, 0], [width, 0], [0, height], [width, height]] as const;
  const projections = corners.map(([cornerX, cornerY]) => cornerX * dx + cornerY * dy);
  const minimum = Math.min(...projections);
  const maximum = Math.max(...projections);
  const position = ((x * dx + y * dy) - minimum) / (maximum - minimum);
  const [start, mid, end] = [rgb(tokens.heroStart), rgb(tokens.heroMid), rgb(tokens.heroEnd)];
  const mix = (from: [number, number, number], to: [number, number, number], weight: number): [number, number, number] => [
    Math.round(from[0] * (1 - weight) + to[0] * weight),
    Math.round(from[1] * (1 - weight) + to[1] * weight),
    Math.round(from[2] * (1 - weight) + to[2] * weight),
  ];
  const gradient = position <= 0.53 ? mix(start, mid, position / 0.53) : mix(mid, end, (position - 0.53) / 0.47);
  const match = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/u.exec(y / height < 0.5 ? tokens.heroOverlayTop : tokens.heroOverlayBottom)!;
  const overlay = `#${[match[1], match[2], match[3]].map((value) => Number(value).toString(16).padStart(2, '0')).join('')}`;
  const alpha = Number(match[4]) / 100;
  // The 180 degree overlay changes continuously rather than as a hard split.
  const top = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/u.exec(tokens.heroOverlayTop)!;
  const bottom = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/u.exec(tokens.heroOverlayBottom)!;
  const overlayChannels = [0, 1, 2].map((index) => Math.round(Number(top[index + 1]) * (1 - y / height) + Number(bottom[index + 1]) * (y / height))) as [number, number, number];
  const overlayAlpha = Number(top[4]) / 100 * (1 - y / height) + Number(bottom[4]) / 100 * (y / height);
  void overlay;
  void alpha;
  return toHex(composite(toHex(overlayChannels), gradient, overlayAlpha));
}

describe('event theme contract', () => {
  it('serializes the canonical default deterministically', () => {
    expect(serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG)).toBe(
      '{"version":1,"presetId":"candidary-default","overrides":{}}',
    );
  });

  it('canonicalizes and validates direct serialization input', () => {
    expect(serializeEventThemeConfig({
      version: 1,
      presetId: 'coastal-light',
      overrides: { primaryColor: '#0C6370', accentColor: '#C85F50' },
    })).toBe('{"version":1,"presetId":"coastal-light","overrides":{}}');
    expect(() => serializeEventThemeConfig({
      version: 1,
      presetId: 'coastal-light',
      overrides: { primaryColor: '#0c6370' },
      evil: 'x',
    } as unknown as EventThemeConfigV1)).toThrow();
  });

  it('normalizes case and removes redundant overrides', () => {
    const parsed = eventThemeConfigSchema.parse({
      version: 1,
      presetId: 'coastal-light',
      overrides: { primaryColor: '#0C6370', accentColor: '#C85F50' },
    });
    expect(parsed).toEqual({ version: 1, presetId: 'coastal-light', overrides: {} });
  });

  it.each([
    { version: 1, presetId: 'coastal-light', overrides: {}, evil: 'x' },
    { version: 1, presetId: 'coastal-light', overrides: { evil: '#000000' } },
    { version: 1, presetId: 'coastal-light', overrides: { primaryColor: 'url(x)' } },
    { version: 1, presetId: 'coastal-light', overrides: { accentColor: 'var(--x)' } },
  ])('rejects unknown or injection-shaped input', (input) => {
    expect(eventThemeConfigSchema.safeParse(input).success).toBe(false);
  });

  it('keeps structural stored parsing cheap and resolves semantic failures safely', () => {
    const config = parseStoredEventThemeConfig(JSON.stringify({
      version: 1,
      presetId: 'candidary-default',
      overrides: { primaryColor: '#777777' },
    }));
    expect(config.overrides.primaryColor).toBe('#777777');
    expect(resolvedThemeView(config).config).toEqual(DEFAULT_EVENT_THEME_CONFIG);
  });

  /* These two lists reach here by different routes — the tuple is hand-written for `z.enum`, the
     registry comes off the preset table — so holding them to the same members closes the last gap the
     type system leaves: a preset that exists but is offered to nobody. The other three directions are
     compile errors. */
  it('publishes the fixed registry in stable display order', () => {
    expect(EVENT_THEME_PRESETS.map((preset) => preset.id)).toEqual([...EVENT_THEME_PRESET_IDS]);
    expect(EVENT_THEME_PRESET_IDS).toEqual([
      'candidary-default', 'garden-party', 'midnight-film', 'coastal-light',
    ]);
    expect(EVENT_THEME_PRESETS.map((preset) => [preset.id, preset.name])).toEqual([
      ['candidary-default', 'Candidary Default'],
      ['garden-party', 'Garden Party'],
      ['midnight-film', 'Midnight Film'],
      ['coastal-light', 'Coastal Light'],
    ]);
  });

  it.each(EVENT_THEME_PRESET_IDS)('reproduces every version-1 token for %s', (presetId) => {
    const preset = EVENT_THEME_PRESETS.find((candidate) => candidate.id === presetId)!;
    expect(preset.tokens).toEqual(EXPECTED_TOKENS[presetId]);
    for (const [key, value] of Object.entries(preset.tokens)) {
      if (key.endsWith('Shadow') || key.endsWith('OverlayTop') || key.endsWith('OverlayBottom') || key === 'coverTextScrim') {
        expect(value).toMatch(RGBA);
      } else if (key.endsWith('Radius')) {
        expect(value).toMatch(/^\d+px$/u);
      } else {
        expect(value).toMatch(HEX);
      }
    }
  });

  it('keeps Candidary Default compatibility orphan values exact', () => {
    const tokens = EVENT_THEME_PRESETS[0]!.tokens;
    expect(tokens).toMatchObject({
      pageText: '#2b1d17', cardText: '#4a413e', secondaryMutedText: '#766c70',
      quietText: '#665c58', requiredText: '#8b4b31', selectionSummaryText: '#6f6561',
      inputBorder: '#928a84', primaryHover: '#31170c',
    });
  });

  /* Resolution only ever promised these three: a label that clears its button, an on-surface variant
     that clears the grounds, and a shadow of the right shape. Whether the button itself can be seen
     is `assertOverridesLegible`, below — this list deliberately still runs the extremes that floor
     refuses, because a value already saved must keep resolving. */
  it.each(['#000000', '#ffffff', '#112233', '#f8d4c4'] as const)('derives label, on-surface, and shadow tokens for primary %s', (primaryColor) => {
    const theme = resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: { primaryColor } });
    expect(contrastRatio(theme.tokens.primaryForeground, theme.tokens.primary)).toBeGreaterThanOrEqual(4.5);
    expect(Math.min(
      contrastRatio(theme.tokens.primaryOnSurface, theme.tokens.page),
      contrastRatio(theme.tokens.primaryOnSurface, theme.tokens.surface),
      contrastRatio(theme.tokens.primaryOnSurface, theme.tokens.raisedSurface),
    )).toBeGreaterThanOrEqual(4.5);
    expect(theme.tokens.primaryShadow).toMatch(RGBA);
  });

  /* Both poles used to blend toward the side they already sat on, so the hover state resolved to the
     button itself. Every primary now moves somewhere, whichever end it starts from. */
  it.each(['#000000', '#010101', '#0c0c0c', '#ffffff', '#fcfcfc', '#f5f5f5'] as const)('keeps a hover step on the extreme primary %s', (primaryColor) => {
    const theme = resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: { primaryColor } });
    expect(theme.tokens.primaryHover).not.toBe(theme.tokens.primary);
    expect(contrastRatio(theme.tokens.primaryHover, theme.tokens.primary)).toBeGreaterThanOrEqual(1.02);
  });

  /* `#000000` is the one extreme a host can still choose — it clears the surface floor at 21:1 — so
     the reversal has to hold for a color that reaches the write path, not only for stored history. */
  it('lets a host save pure black and still answer the pointer', () => {
    const theme = resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#000000' } });
    expect(() => assertOverridesLegible(theme)).not.toThrow();
    expect(theme.tokens.primaryHover).toBe('#1a1a1a');
  });

  /* The flip is a last resort, not a new direction of travel: an ordinary primary still deepens under
     a white label and lightens under dark ink, exactly as every authored preset hover does. */
  it.each(EVENT_THEME_PRESET_IDS)('keeps the authored %s primary deepening on hover', (presetId) => {
    const preset = EVENT_THEME_PRESETS.find((candidate) => candidate.id === presetId)!;
    const theme = resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: preset.tokens.primary },
    });
    expect(theme.tokens.primaryForeground).toBe('#ffffff');
    expect(contrastRatio(theme.tokens.primaryHover, '#ffffff'))
      .toBeGreaterThan(contrastRatio(theme.tokens.primary, '#ffffff'));
  });

  it('lightens a light primary under dark ink', () => {
    const theme = resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#c85f50' },
    });
    expect(() => assertOverridesLegible(theme)).not.toThrow();
    expect(theme.tokens.primaryForeground).toBe('#111111');
    expect(theme.tokens.primaryHover).toBe('#ce6f62');
  });

  it('keeps the hover of a write-eligible primary above the surface and label floors', () => {
    const theme = resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#8b8b8b' },
    });

    expect(() => assertOverridesLegible(theme)).not.toThrow();
    expect(Math.min(
      contrastRatio(theme.tokens.primaryHover, theme.tokens.page),
      contrastRatio(theme.tokens.primaryHover, theme.tokens.surface),
      contrastRatio(theme.tokens.primaryHover, theme.tokens.raisedSurface),
    )).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(theme.tokens.primaryForeground, theme.tokens.primaryHover)).toBeGreaterThanOrEqual(4.5);
    expect(theme.tokens.primaryHover).not.toBe(theme.tokens.primary);
  });

  it('rejects a primary override with no allowlisted 4.5:1 foreground', () => {
    expect(() => resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#777777' },
    })).toThrow(expect.objectContaining({ field: 'overrides.primaryColor' } satisfies Partial<EventThemeResolutionError>));
  });

  /* `accentForeground` reaches no rule: nothing fills a surface with accent and sets text on it. So
     the retired gate refused colors over a pairing that is never drawn, and because both #ffffff and
     #111111 sit under 4.5:1 across a narrow band of mid luminances, the colors it refused were
     ordinary mid greys. #797979 is inside that band. */
  it('resolves a mid-luminance accent that the retired foreground gate refused', () => {
    expect(Math.max(contrastRatio('#ffffff', '#797979'), contrastRatio('#111111', '#797979')))
      .toBeLessThan(4.5);
    expect(resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { accentColor: '#797979' },
    }).tokens.accent).toBe('#797979');
  });

  /* What accent is actually drawn as: a mark on the event's own grounds. The floor belongs where a
     host picks a color, never on the read path — so a theme saved before the floor existed keeps
     resolving, and is only refused when that host next edits it. */
  it('refuses an accent that cannot be seen on the event surfaces', () => {
    const resolved = resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { accentColor: '#f5efe6' },
    });
    expect(resolved.tokens.accent).toBe('#f5efe6');
    expect(() => assertOverridesLegible(resolved))
      .toThrow(expect.objectContaining({ field: 'overrides.accentColor' } satisfies Partial<EventThemeResolutionError>));
  });

  /* `primaryForeground` only ever promised the label inside the button. These three clear it — the
     resolver pairs each with `#111111` above 4.5:1 — and still leave the send button itself at
     roughly 1:1 against the surface it sits on, which is what the surface floor is for. */
  it.each(['#ffffff', '#e8f0d0', '#f8d4c4'] as const)('refuses a primary %s that dissolves into the event surfaces', (primaryColor) => {
    const resolved = resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: { primaryColor } });
    expect(contrastRatio(resolved.tokens.primaryForeground, resolved.tokens.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(resolved.tokens.primary, resolved.tokens.surface)).toBeLessThan(3);
    expect(() => assertOverridesLegible(resolved))
      .toThrow(expect.objectContaining({ field: 'overrides.primaryColor' } satisfies Partial<EventThemeResolutionError>));
  });

  it('names the primary first when both overridden colors sit below the floor', () => {
    const resolved = resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#ffffff', accentColor: '#f5efe6' },
    });
    expect(() => assertOverridesLegible(resolved))
      .toThrow(expect.objectContaining({ field: 'overrides.primaryColor' } satisfies Partial<EventThemeResolutionError>));
  });

  it.each(EVENT_THEME_PRESET_IDS)('keeps the authored %s primary legible on its own surfaces', (presetId) => {
    const { tokens } = EVENT_THEME_PRESETS.find((candidate) => candidate.id === presetId)!;
    expect(Math.min(
      contrastRatio(tokens.primary, tokens.page),
      contrastRatio(tokens.primary, tokens.surface),
      contrastRatio(tokens.primary, tokens.raisedSurface),
    )).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['{"version":1,"presetId":"candidary-default","overrides":{"accentColor":"#f5efe6"}}', 'accent', '#f5efe6'],
    ['{"version":1,"presetId":"candidary-default","overrides":{"primaryColor":"#ffffff"}}', 'primary', '#ffffff'],
  ] as const)('keeps a stored %#: below-floor color resolving instead of reverting to Default', (stored, token, value) => {
    const config = parseStoredEventThemeConfig(stored);
    expect(resolvedThemeView(config).tokens[token]).toBe(value);
    expect(resolvedThemeView(config).config.presetId).toBe('candidary-default');
  });

  it.each(EVENT_THEME_PRESET_IDS)('keeps the authored %s accent legible on its own surfaces', (presetId) => {
    const { tokens } = EVENT_THEME_PRESETS.find((candidate) => candidate.id === presetId)!;
    expect(Math.min(
      contrastRatio(tokens.accent, tokens.page),
      contrastRatio(tokens.accent, tokens.surface),
      contrastRatio(tokens.accent, tokens.raisedSurface),
    )).toBeGreaterThanOrEqual(3);
  });

  it.each(EVENT_THEME_PRESET_IDS)('keeps accent continuity around the authored %s accent', (presetId) => {
    const preset = EVENT_THEME_PRESETS.find((candidate) => candidate.id === presetId)!;
    const [red, green, blue] = rgb(preset.tokens.accent);
    const below = `#${[red, green, Math.max(0, blue - 1)].map((channel) => channel.toString(16).padStart(2, '0')).join('')}` as HexColor;
    const above = `#${[red, green, Math.min(255, blue + 1)].map((channel) => channel.toString(16).padStart(2, '0')).join('')}` as HexColor;
    expect(resolveEventTheme({ version: 1, presetId, overrides: { accentColor: preset.tokens.accent } }).tokens.accentSoft).toBe(preset.tokens.accentSoft);
    const lower = resolveEventTheme({ version: 1, presetId, overrides: { accentColor: below } }).tokens.accentSoft;
    const upper = resolveEventTheme({ version: 1, presetId, overrides: { accentColor: above } }).tokens.accentSoft;
    expect(Math.abs(rgb(lower)[2] - rgb(preset.tokens.accentSoft)[2])).toBeLessThanOrEqual(1);
    expect(Math.abs(rgb(upper)[2] - rgb(preset.tokens.accentSoft)[2])).toBeLessThanOrEqual(1);
  });

  it('derives Candidary Default accent soft exactly at the authored accent', () => {
    expect(resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { accentColor: '#3f6d95' },
    }).tokens.accentSoft).toBe('#dde7f0');
  });

  it.each(EVENT_THEME_PRESET_IDS)('satisfies text, focus, and action contrast for %s', (presetId) => {
    const tokens = EVENT_THEME_PRESETS.find((preset) => preset.id === presetId)!.tokens;
    expect(Math.min(
      contrastRatio(tokens.inputBorder, tokens.page), contrastRatio(tokens.inputBorder, tokens.surface), contrastRatio(tokens.inputBorder, tokens.raisedSurface),
    )).toBeGreaterThanOrEqual(3);
    expect(Math.min(
      contrastRatio(tokens.focus, tokens.page), contrastRatio(tokens.focus, tokens.surface), contrastRatio(tokens.focus, tokens.raisedSurface),
    )).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens.primaryForeground, tokens.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.accentForeground, tokens.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.accentSoftForeground, tokens.accentSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.mutedText, tokens.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.pageText, tokens.page)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.fullscreenForeground, tokens.fullscreenBackdrop)).toBeGreaterThanOrEqual(4.5);
  });

  it('retains documented decorative-border exemptions without treating them as controls', () => {
    const tokens = EVENT_THEME_PRESETS[0]!.tokens;
    expect(contrastRatio(tokens.border, tokens.surface)).toBeLessThan(3);
    expect(contrastRatio(tokens.sectionBorder, tokens.surface)).toBeLessThan(3);
  });

  it('measures the corrected default input border against all applicable surfaces', () => {
    const tokens = EVENT_THEME_PRESETS[0]!.tokens;
    expect(contrastRatio(tokens.inputBorder, tokens.raisedSurface)).toBeCloseTo(3.39, 2);
    expect(contrastRatio(tokens.inputBorder, tokens.surface)).toBeCloseTo(3.27, 2);
    expect(contrastRatio(tokens.inputBorder, tokens.page)).toBeCloseTo(3.02, 2);
  });

  it.each(EVENT_THEME_PRESET_IDS)('keeps no-cover hero pixels readable at required viewport sizes for %s', (presetId) => {
    const tokens = EXPECTED_TOKENS[presetId];
    for (const [width, height] of [[390, 205], [390, 420], [620, 265]] as const) {
      let minimumRatio = Number.POSITIVE_INFINITY;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        minimumRatio = Math.min(minimumRatio, contrastRatio('#ffffff', noCoverPixel(tokens, x, y, width, height)));
      }
      expect(minimumRatio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('round-trips only canonical stored configuration and falls back for malformed input', () => {
    const parsed = eventThemeConfigSchema.parse({
      version: 1, presetId: 'garden-party', overrides: { primaryColor: '#123456', accentColor: '#654321' },
    });
    expect(parseStoredEventThemeConfig(serializeEventThemeConfig(parsed))).toEqual(parsed);
    expect(parseStoredEventThemeConfig('{')).toEqual(DEFAULT_EVENT_THEME_CONFIG);
    expect(parseStoredEventThemeConfig('{"version":2,"presetId":"garden-party","overrides":{}}')).toEqual(DEFAULT_EVENT_THEME_CONFIG);
    expect(parseStoredEventThemeConfig('{"version":1,"presetId":"garden-party","overrides":{"evil":"#000000"}}')).toEqual(DEFAULT_EVENT_THEME_CONFIG);
  });
});
