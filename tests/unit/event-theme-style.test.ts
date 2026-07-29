import { describe, expect, it } from 'vitest';

import { EVENT_THEME_PRESETS } from '../../shared/event-theme';
import type { EventThemeTokens } from '../../shared/contracts';
import { EVENT_THEME_CSS_PROPERTIES, eventThemeStyle } from '../../src/app/event-theme-style';

describe('event theme style adapter', () => {
  it('maps exactly the fixed resolved token contract to event CSS custom properties', () => {
    const tokens = EVENT_THEME_PRESETS.find((preset) => preset.id === 'coastal-light')!.tokens;
    const style = eventThemeStyle({ ...tokens, unexpectedResponseKey: '#000000' } as EventThemeTokens);

    expect(Object.keys(EVENT_THEME_CSS_PROPERTIES).sort()).toEqual(Object.keys(tokens).sort());
    expect(Object.values(EVENT_THEME_CSS_PROPERTIES)).toHaveLength(Object.keys(tokens).length);
    expect(Object.values(EVENT_THEME_CSS_PROPERTIES).every((property) => /^--event-[a-z0-9-]+$/u.test(property))).toBe(true);
    expect(Object.keys(style).sort()).toEqual(Object.values(EVENT_THEME_CSS_PROPERTIES).sort());
    expect(style['--event-page']).toBe('#edf7f5');
    expect(style['--event-primary']).toBe('#0c6370');
    expect(style['--event-cover-text-scrim']).toBe('rgb(5 31 35 / 64%)');
    expect(style['--event-frame-radius']).toBe('20px');
    expect(style).not.toHaveProperty('--event-unexpected-response-key');
  });
});
