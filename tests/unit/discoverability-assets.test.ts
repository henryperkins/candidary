import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const canonicalOrigin = 'https://candidary.app';
const indexableUrls = [
  `${canonicalOrigin}/`,
  `${canonicalOrigin}/create`,
  `${canonicalOrigin}/privacy`,
  `${canonicalOrigin}/terms`,
];

function publicFile(name: string) {
  return resolve(process.cwd(), 'public', name);
}

describe('crawler discoverability assets', () => {
  it('defines one wildcard robots group with public access and private-route exclusions', () => {
    const path = publicFile('robots.txt');
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const robots = readFileSync(path, 'utf8');
    expect(robots.charCodeAt(0)).not.toBe(0xfeff);
    expect(robots.match(/^User-agent:[ \t]*\*$/gimu)).toHaveLength(1);
    expect(robots.match(/^Allow:[ \t]*\/$/gimu)).toHaveLength(1);
    expect(robots.match(/^Disallow:[ \t]*(\S+)$/gimu)?.map((line) => (
      line.replace(/^Disallow:[ \t]*/iu, '')
    ))).toEqual(['/api/', '/event/', '/manage/', '/join', '/recover/', '/host/']);
    expect(robots.match(/^Sitemap:[ \t]*(\S+)$/gimu)).toEqual([
      `Sitemap: ${canonicalOrigin}/sitemap.xml`,
    ]);
  });

  it('defines valid UTF-8 sitemap XML with only the approved canonical public URLs', () => {
    const path = publicFile('sitemap.xml');
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const sitemap = readFileSync(path, 'utf8');
    expect(sitemap.charCodeAt(0)).not.toBe(0xfeff);

    const document = new DOMParser().parseFromString(sitemap, 'application/xml');
    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.documentElement.localName).toBe('urlset');
    expect(document.documentElement.namespaceURI)
      .toBe('http://www.sitemaps.org/schemas/sitemap/0.9');

    const urls = [...document.getElementsByTagNameNS(
      'http://www.sitemaps.org/schemas/sitemap/0.9',
      'url',
    )];
    expect(urls.map((url) => url.getElementsByTagNameNS(
      'http://www.sitemaps.org/schemas/sitemap/0.9',
      'loc',
    ).item(0)?.textContent)).toEqual(indexableUrls);
    expect(urls.every((url) => url.children.length === 1)).toBe(true);
  });
});
