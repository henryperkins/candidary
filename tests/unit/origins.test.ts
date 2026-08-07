import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  KNOWN_APPLICATION_ORIGINS,
  isKnownApplicationOrigin,
  normalizeOrigin,
  parseOriginList,
} from '../../shared/origins';

// Strict JSON on purpose, for the same reason `static-headers.test.ts` does it:
// `wrangler.jsonc` may legally carry comments, but tooling reads this manifest
// without stripping them, so it is kept comment-free and this fails loudly if
// it ever is not.
const wranglerConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'wrangler.jsonc'), 'utf8')) as {
  vars?: { APP_ORIGIN?: string; ALTERNATE_ORIGINS?: string };
};

describe('origin normalization', () => {
  it('reduces the forms a browser and a config file disagree about to one', () => {
    expect(normalizeOrigin('https://candidary.app/')).toBe('https://candidary.app');
    expect(normalizeOrigin('  https://candidary.app  ')).toBe('https://candidary.app');
    expect(normalizeOrigin('https://candidary.app:443')).toBe('https://candidary.app');
    expect(normalizeOrigin('https://candidary.app/manage/abc')).toBe('https://candidary.app');
    expect(normalizeOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
  });

  // A bare hostname is not an origin, and returning it unchanged would let it
  // compare equal to one.
  it('refuses anything that is not an absolute http(s) origin', () => {
    for (const value of ['candidary.app', '', '   ', '/manage/abc', 'javascript:alert(1)',
      'data:text/html,x', 'file:///etc/passwd', undefined, null]) {
      expect(normalizeOrigin(value)).toBeNull();
    }
  });
});

describe('origin list parsing', () => {
  it('accepts the separators a single Wrangler var can carry', () => {
    expect(parseOriginList('https://a.test,https://b.test')).toEqual(['https://a.test', 'https://b.test']);
    expect(parseOriginList('https://a.test, https://b.test')).toEqual(['https://a.test', 'https://b.test']);
    expect(parseOriginList(' https://a.test \n https://b.test ')).toEqual(['https://a.test', 'https://b.test']);
  });

  it('is empty when the var is unset or blank', () => {
    expect(parseOriginList(undefined)).toEqual([]);
    expect(parseOriginList('')).toEqual([]);
    expect(parseOriginList('   ')).toEqual([]);
  });

  // A typo should cost that one origin, not become a token an `Origin` header
  // could match.
  it('drops entries that are not origins and keeps the ones that are', () => {
    expect(parseOriginList('https://a.test, nonsense, https://b.test')).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
  });
});

describe('known application origins', () => {
  // The browser cannot read `ALTERNATE_ORIGINS`, so it carries its own copy of
  // the list. This is the only thing keeping the two from drifting: adding a
  // hostname to the deployment without adding it here leaves a host unable to
  // paste a management link they were mailed.
  it('matches the origins the Worker is configured to answer on', () => {
    const configured = [
      wranglerConfig.vars?.APP_ORIGIN,
      ...parseOriginList(wranglerConfig.vars?.ALTERNATE_ORIGINS),
    ].map(normalizeOrigin).filter((origin): origin is string => origin !== null);
    expect([...KNOWN_APPLICATION_ORIGINS].sort()).toEqual([...new Set(configured)].sort());
  });

  it('names the canonical origin first', () => {
    expect(KNOWN_APPLICATION_ORIGINS[0]).toBe(normalizeOrigin(wranglerConfig.vars?.APP_ORIGIN));
  });

  it('recognizes each configured origin and nothing else', () => {
    for (const origin of KNOWN_APPLICATION_ORIGINS) {
      expect(isKnownApplicationOrigin(origin)).toBe(true);
      expect(isKnownApplicationOrigin(`${origin}/`)).toBe(true);
    }
    expect(isKnownApplicationOrigin('https://candidary.app.evil.test')).toBe(false);
    expect(isKnownApplicationOrigin('http://candidary.app')).toBe(false);
    expect(isKnownApplicationOrigin('candidary.app')).toBe(false);
    expect(isKnownApplicationOrigin(undefined)).toBe(false);
  });
});
