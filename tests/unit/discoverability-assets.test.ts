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

// The markdown answer to each of these URLs is built in the Worker, so each one has
// to reach the Worker at all. Read from the same manifest `static-headers.test.ts`
// parses, and kept comment-free for the same reason.
const wranglerConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'wrangler.jsonc'), 'utf8')) as {
  assets?: { run_worker_first?: string[] };
};

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

  it('declares one content-signal preference, inside the group it applies to', () => {
    const robots = readFileSync(publicFile('robots.txt'), 'utf8');
    const lines = robots.split(/\r?\n/u);
    const group = lines.findIndex((line) => /^User-agent:[ \t]*\*$/iu.test(line));
    const signal = lines.findIndex((line) => /^Content-Signal:/iu.test(line));

    expect(lines.filter((line) => /^Content-Signal:/iu.test(line))).toHaveLength(1);
    expect(signal).toBeGreaterThan(group);
    // A blank line ends a robots group, so a directive parked past one applies to
    // nobody. Every line between the user-agent and the signal must be a directive.
    expect(lines.slice(group, signal).every((line) => line.trim() !== '')).toBe(true);
    expect(lines[signal]).toBe('Content-Signal: search=yes, ai-input=yes, ai-train=no');
  });

  it('routes every negotiable public page through the Worker', () => {
    const patterns = wranglerConfig.assets?.run_worker_first ?? [];
    for (const url of indexableUrls) {
      expect(patterns).toContain(new URL(url).pathname);
    }
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
