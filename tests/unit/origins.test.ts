import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  KNOWN_APPLICATION_ORIGINS,
  PREVIEW_APPLICATION_ROOT_ORIGIN,
  isKnownApplicationOrigin,
  normalizeOrigin,
  parseOriginList,
} from '../../shared/origins';

// Strict JSON on purpose, for the same reason `static-headers.test.ts` does it:
// `wrangler.jsonc` may legally carry comments, but tooling reads this manifest
// without stripping them, so it is kept comment-free and this fails loudly if
// it ever is not.
const wranglerConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'wrangler.jsonc'), 'utf8')) as {
  workers_dev?: boolean;
  preview_urls?: boolean;
  vars?: { APP_ORIGIN?: string; ALTERNATE_ORIGINS?: string };
};
const r2Cors = JSON.parse(readFileSync(resolve(process.cwd(), 'config/r2-cors.json'), 'utf8')) as {
  rules?: { allowed?: { origins?: string[] } }[];
};

function configuredOrigins(): string[] {
  return [...new Set([
    wranglerConfig.vars?.APP_ORIGIN,
    ...parseOriginList(wranglerConfig.vars?.ALTERNATE_ORIGINS),
  ].map(normalizeOrigin).filter((value): value is string => value !== null))];
}

describe('origin normalization', () => {
  it('reduces equivalent root-origin spellings to one', () => {
    expect(normalizeOrigin('https://candidary.app/')).toBe('https://candidary.app');
    expect(normalizeOrigin('  https://candidary.app  ')).toBe('https://candidary.app');
    expect(normalizeOrigin('https://candidary.app:443')).toBe('https://candidary.app');
    expect(normalizeOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
  });

  // A bare hostname is not an origin, and returning it unchanged would let it
  // compare equal to one.
  it('refuses anything that is not an absolute http(s) origin', () => {
    for (const value of ['candidary.app', '', '   ', '/manage/abc', 'javascript:alert(1)',
      'data:text/html,x', 'file:///etc/passwd', 'https://user:pass@candidary.app',
      'https://candidary.app/manage/abc', 'https://candidary.app?token=secret',
      'https://candidary.app#fragment', undefined, null]) {
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
  it('does not expose production bindings through public Workers development routes', () => {
    expect(wranglerConfig.workers_dev).toBe(false);
    expect(wranglerConfig.preview_urls).toBe(false);
  });

  // The browser cannot read `ALTERNATE_ORIGINS`, so it carries its own copy of
  // the list. This is the only thing keeping the two from drifting: adding a
  // hostname to the deployment without adding it here leaves a host unable to
  // paste a management link they were mailed.
  it('matches the origins the Worker is configured to answer on', () => {
    expect([...KNOWN_APPLICATION_ORIGINS].sort()).toEqual(configuredOrigins().sort());
  });

  // The third copy of the same deployment fact, and the one whose omission is
  // hardest to read: a signed browser `PUT` goes to R2 rather than the Worker, so
  // a missing entry here leaves every page working and every upload failing.
  it('matches the R2 CORS policy the browser uploads against', () => {
    const allowed = (r2Cors.rules ?? []).flatMap((rule) => rule.allowed?.origins ?? []);
    expect(allowed.sort()).toEqual(configuredOrigins().sort());
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

  it('recognizes only the exact isolated preview Worker hostname family', () => {
    expect(isKnownApplicationOrigin(PREVIEW_APPLICATION_ROOT_ORIGIN)).toBe(true);
    expect(isKnownApplicationOrigin(
      'https://feature-release-candidary-preview.lfd.workers.dev',
    )).toBe(true);
    expect(isKnownApplicationOrigin(
      'https://feature-release-candidary-preview.lfd.workers.dev.evil.test',
    )).toBe(false);
    expect(isKnownApplicationOrigin(
      'https://candidary-preview.other-account.workers.dev',
    )).toBe(false);
    expect(isKnownApplicationOrigin(
      'http://feature-release-candidary-preview.lfd.workers.dev',
    )).toBe(false);
  });
});
