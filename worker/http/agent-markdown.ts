import type { MiddlewareHandler } from 'hono';

import {
  COVER_UPLOAD_MIME_TYPES,
  MAX_COVER_UPLOAD_BYTES,
  MAX_EVENT_BYTES,
  MAX_EVENT_MEDIA,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from '../../shared/constants';
import {
  CREATE_INTRO,
  LANDING_CAPABILITIES,
  LANDING_FAQ,
  LANDING_HERO,
  LANDING_PRIVACY_NOTE,
  LANDING_QUESTIONS,
  LANDING_RETENTION_NOTE,
  LANDING_WORKFLOW,
  LEGAL_PENDING_NOTE,
  PRIVACY_PAGE,
  SITE_BLURB,
  SITE_NAME,
  SITE_ORIGIN,
  TERMS_PAGE,
} from '../../shared/site-content';
import type { SiteLegalPage } from '../../shared/site-content';
import type { AppBindings } from '../env';

/**
 * `Accept: text/markdown` answers for the four public pages, and nothing else.
 *
 * The site is client-rendered, so an agent that fetches a page gets the app shell
 * and none of the copy — and an HTML-to-markdown converter at the edge would get
 * exactly the same empty shell. The markdown is therefore built here, from the same
 * `shared/site-content.ts` strings the pages render and the same
 * `shared/constants.ts` numbers the Worker enforces.
 *
 * The registry is an allowlist of the four URLs in `sitemap.xml`. Every other path
 * falls through untouched: no event, manager, host, or entry surface has a markdown
 * form, and adding one would hand an agent a private page in a shape no
 * authorization check has ever been written for.
 */

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

interface MediaRange {
  readonly type: string;
  readonly quality: number;
}

function parseAccept(header: string): MediaRange[] {
  return header.split(',').map((entry) => {
    const [range, ...parameters] = entry.split(';').map((piece) => piece.trim());
    const declared = parameters
      .map((parameter) => /^q=(.+)$/iu.exec(parameter)?.[1])
      .find((value) => value !== undefined);
    const quality = declared === undefined ? 1 : Number.parseFloat(declared);
    return {
      type: (range ?? '').toLowerCase(),
      quality: Number.isFinite(quality) ? Math.min(Math.max(quality, 0), 1) : 0,
    };
  });
}

function bestQuality(ranges: readonly MediaRange[], pattern: RegExp): number {
  // `Math.max` of nothing is -Infinity, so the floor is part of the call: a type
  // the client never named scores zero rather than negative infinity.
  return Math.max(0, ...ranges.filter((range) => pattern.test(range.type)).map((range) => range.quality));
}

/**
 * True only when the client named markdown itself and did not rank HTML above it.
 *
 * Wildcards deliberately do not count. Every browser puts a catch-all range in its
 * navigation `Accept` header, so treating a wildcard as consent would serve markdown
 * to people, which is the one outcome this feature must never produce.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const ranges = parseAccept(accept);
  const markdown = bestQuality(ranges, /^text\/(?:x-)?markdown$/u);
  if (markdown <= 0) return false;
  return markdown >= bestQuality(ranges, /^text\/html$/u);
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

const PAGE_LINKS = [
  ['/', `[${SITE_NAME}](${SITE_ORIGIN}/)`],
  ['/create', `[Create an event](${SITE_ORIGIN}/create)`],
  ['/privacy', `[Privacy](${SITE_ORIGIN}/privacy)`],
  ['/terms', `[Terms](${SITE_ORIGIN}/terms)`],
] as const;

// The rest of the public site, from wherever the agent landed. A page does not
// list itself, so the index is the way onward rather than a repeated nav block.
function pageIndex(current: string): string {
  return [
    '## Pages',
    ...PAGE_LINKS.filter(([path]) => path !== current).map(([, link]) => `- ${link}`),
  ].join('\n');
}

const HOME_MARKDOWN = [
  `# ${SITE_NAME}`,
  `> ${SITE_BLURB}`,
  `## ${LANDING_HERO.headline.join(' ')}`,
  LANDING_HERO.lede,
  `[Create your event](${SITE_ORIGIN}/create)`,
  `## ${LANDING_WORKFLOW.title}`,
  LANDING_CAPABILITIES.map(({ title, body }) => `- **${title}** — ${body}`).join('\n'),
  LANDING_PRIVACY_NOTE,
  `## ${LANDING_FAQ.title}`,
  LANDING_QUESTIONS.map(({ question, answer }) => `### ${question}\n\n${answer}`).join('\n\n'),
  pageIndex('/'),
  LANDING_RETENTION_NOTE,
].join('\n\n');

// Every number here is read from `shared/constants.ts`, which is what the reserve
// and finalize routes enforce, so the page an agent is told about is the product.
// The cover ceiling stays decimal and the media ceilings stay binary, exactly as
// the two intakes measure them.
const CREATE_MARKDOWN = [
  `# ${CREATE_INTRO.title}`,
  CREATE_INTRO.lede,
  bullets(CREATE_INTRO.facts),
  '## What one event holds',
  bullets([
    `Up to ${MAX_EVENT_MEDIA.toLocaleString('en-US')} photos or ${MAX_EVENT_BYTES / GIBIBYTE} GiB per event`,
    `Up to ${MAX_IMAGE_BYTES / MEBIBYTE} MB per photo`,
    `Guests may send ${SUPPORTED_IMAGE_TYPES.join(', ')}`,
    `An optional cover photo up to ${Math.floor(MAX_COVER_UPLOAD_BYTES / 1_000_000)} MB, as ${COVER_UPLOAD_MIME_TYPES.join(', ')}`,
  ]),
  pageIndex('/create'),
].join('\n\n');

function legalMarkdown(path: string, page: SiteLegalPage): string {
  return [
    `# ${page.title}`,
    page.lede,
    bullets(page.facts),
    LEGAL_PENDING_NOTE,
    pageIndex(path),
  ].join('\n\n');
}

interface MarkdownDocument {
  readonly body: string;
  /**
   * The estimate an agent budgets context with, at the conventional four
   * characters per token. Named an estimate because that is what it is; the
   * Worker does not tokenize, and a page's markdown never changes at runtime.
   */
  readonly tokens: number;
}

function markdownDocument(body: string): MarkdownDocument {
  const text = `${body}\n`;
  return { body: text, tokens: Math.ceil(text.length / 4) };
}

const MARKDOWN_PAGES = new Map<string, MarkdownDocument>([
  ['/', markdownDocument(HOME_MARKDOWN)],
  ['/create', markdownDocument(CREATE_MARKDOWN)],
  ['/privacy', markdownDocument(legalMarkdown('/privacy', PRIVACY_PAGE))],
  ['/terms', markdownDocument(legalMarkdown('/terms', TERMS_PAGE))],
]);

export const MARKDOWN_PAGE_PATHS = [...MARKDOWN_PAGES.keys()];

function registryPath(pathname: string): string {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return trimmed === '' ? '/' : trimmed;
}

export const agentMarkdown: MiddlewareHandler<AppBindings> = async (context, next) => {
  const method = context.req.method;
  if (method !== 'GET' && method !== 'HEAD') return next();

  const pathname = registryPath(new URL(context.req.url).pathname);
  const document = MARKDOWN_PAGES.get(pathname);
  if (!document) return next();

  if (!prefersMarkdown(context.req.header('Accept'))) {
    await next();
    // The HTML shell is now one of two answers to this URL, so it has to say so:
    // a cache that stored it without `Vary` would hand it back to an agent that
    // asked for markdown. Appended, because the asset response may already vary.
    context.header('Vary', 'Accept', { append: true });
    return;
  }

  const headers = {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Vary': 'Accept',
    'Cache-Control': 'public, max-age=300',
    // An estimate, so an agent can size the document before spending a request on it.
    'X-Markdown-Tokens': String(document.tokens),
    'Link': `<${SITE_ORIGIN}${pathname}>; rel="canonical"`,
  };
  // Same headers either way; HEAD just stops before the body.
  return method === 'HEAD' ? context.body(null, 200, headers) : context.body(document.body, 200, headers);
};
