# Candidary Per-Event Theming Implementation Plan

> **Integration note (2026-07-29):** This plan was executed on its isolated historical base. The
> later Chestnut/Denim migration supersedes its Candidary Default palette values and screenshot
> hashes; current values and evidence live in `design/design-system.md`,
> `shared/event-theme.ts`, and `design/fidelity-ledger.md`. The original base/branch constraints
> below remain as execution history rather than instructions for the integrated tree.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every event a versioned, isolated, accessible visual theme while
preserving Candidary's fast private guest photo-drop journey and globally
branded host chrome.

**Architecture:** Store one canonical versioned JSON configuration on the
`events` row, parse it into an internal `themeConfig`, and resolve semantic
tokens only at event-view response boundaries. Share the pure resolver between
the Worker and the inert Manager preview, then install its fixed CSS-variable
allowlist only on guest, full-screen, and preview scopes.

**Tech Stack:** TypeScript 6, Zod 4, Hono, React 19, Cloudflare Workers and D1,
Vitest with workerd, Testing Library, Playwright, Vite preview, and the existing
bundled Manrope and DM Sans fonts.

## Global Constraints

- Work only in the isolated `codex/event-theming` worktree based on
  `051478a5e575e0849ac75bbef08a1850dbc2526a`.
- Do not modify, extract, delete, or stage the unrelated HSTS work,
  `CandidaryDesignSystem.zip`, or the iOS/PWA worktree.
- Do not deploy, push, merge, open a pull request, or apply migration 0007 to a
  remote database.
- Persist only canonical `EventThemeConfigV1` JSON; never persist raw CSS,
  resolved tokens, arbitrary property names, font URLs, image URLs, HTML, or
  external resources.
- Version 1 exposes exactly four stable presets and only `primaryColor` and
  `accentColor` overrides.
- Every missing, legacy, malformed, unsupported, or semantically invalid stored
  configuration fails safe to canonical Candidary Default.
- New writes are strict and fail closed. The existing top-level create-envelope
  unknown-key behavior stays unchanged; strictness applies to `theme`,
  `theme.overrides`, and the direct update configuration.
- Resolve tokens only for JSON event views, not during upload reservation,
  finalization, account lookup, or other authentication-only `mapEvent()` calls.
- Preserve the guest route's explicit field allowlist. Never spread an internal
  `EventRecord` into a response.
- Danger/failure and successful-delivery semantics remain fixed. Ordinary
  progress chrome follows event primary, while labels, icons, retry behavior,
  and spinner geometry remain fixed.
- `inputBorder` and focus must clear `3:1` against page, surface, and raised
  surface. Normal text and control text must clear `4.5:1`.
- Global landing, account, create-shell, manager-navigation, manager-workspace,
  and host-list styling remains globally branded. Only the Manager preview
  receives event variables.
- Preserve 44 x 44 CSS-pixel targets, keyboard operation, reduced motion, 200%
  zoom behavior, 320 px reflow, 390 px mobile layout, long-content containment,
  and the approved first-fold hierarchy.
- Keep the existing event-cover upload and storage pipeline. The new manager
  cover read is a second authorized read path, not a second image system.
- Use a failing behavioral test before each production change and commit each
  independently reviewable task.
- Run browser tests against `npm run build` plus Vite preview through the
  repository's Playwright configuration; do not substitute the Vite dev server.
- `vitest.worker.config.ts` already discovers migration files with
  `readD1Migrations()`. Do not add a hardcoded migration filename.

## Execution Setup

Before Task 1, run `npm ci` in the isolated worktree and verify that it changes
only ignored dependency/install artifacts. Recheck that 0006 remains the
highest migration and that no concurrent branch has claimed 0007. Do not reuse
or modify the primary HSTS checkout's dependency tree.

---

### Task 1: Build the canonical theme contract and deterministic resolver

**Files:**

- Modify: `shared/contracts.ts`
- Create: `shared/event-theme.ts`
- Create: `tests/unit/event-theme.test.ts`

**Interfaces:**

- Produces: `EVENT_THEME_VERSION`
- Produces: `EVENT_THEME_PRESET_IDS`
- Produces: `DEFAULT_EVENT_THEME_CONFIG`
- Produces: `EVENT_THEME_PRESETS`
- Produces: `eventThemeConfigSchema`
- Produces: `normalizeEventThemeConfig(input): EventThemeConfigV1`
- Produces: `parseStoredEventThemeConfig(value): EventThemeConfigV1`
- Produces: `serializeEventThemeConfig(config): string`
- Produces: `resolveEventTheme(config): ResolvedEventTheme`
- Produces: `resolvedThemeView(config): ResolvedEventTheme`
- Produces: `contrastRatio(foreground, background): number`
- Produces: `EventThemeResolutionError.field`
- Produces: shared `EventView` and `GuestEventView` wire contracts

- [ ] **Step 1: Write failing schema, normalization, and registry tests**

Create `tests/unit/event-theme.test.ts` with exact public-contract assertions:

```ts
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EVENT_THEME_CONFIG,
  EVENT_THEME_PRESETS,
  contrastRatio,
  eventThemeConfigSchema,
  parseStoredEventThemeConfig,
  resolveEventTheme,
  resolvedThemeView,
  serializeEventThemeConfig,
} from '../../shared/event-theme';

describe('event theme contract', () => {
  it('serializes the canonical default deterministically', () => {
    expect(serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG)).toBe(
      '{"version":1,"presetId":"candidary-default","overrides":{}}',
    );
  });

  it('normalizes case and removes redundant overrides', () => {
    const parsed = eventThemeConfigSchema.parse({
      version: 1,
      presetId: 'coastal-light',
      overrides: { primaryColor: '#0C6370', accentColor: '#C85F50' },
    });
    expect(parsed).toEqual({
      version: 1,
      presetId: 'coastal-light',
      overrides: {},
    });
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
});
```

Add table-driven assertions for all four preset identifiers, names, exact 45
tokens from design-spec section 9, lowercase six-digit hex, allowlisted RGBA and
radius grammars, and the exact Candidary Default orphan values.

- [ ] **Step 2: Run the unit test and verify the missing module failure**

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-theme.test.ts
```

Expected: FAIL because `shared/event-theme.ts` and the shared theme types do not
exist.

- [ ] **Step 3: Define the shared wire types**

Add the approved `EventThemePresetId`, `HexColor`, `RgbaColor`,
`EventThemeOverridesV1`, `EventThemeConfigV1`, 45-field `EventThemeTokens`,
`ResolvedEventTheme`, `EventView`, and `GuestEventView` definitions to
`shared/contracts.ts`. `EventView` enumerates the current full event response
fields plus `theme`; `GuestEventView` is the approved narrow `Pick` including
`theme`.

- [ ] **Step 4: Implement strict structural parsing and canonical serialization**

In `shared/event-theme.ts`, use two nested `z.strictObject()` schemas and this
normalization order:

```ts
export const EVENT_THEME_PRESET_IDS = [
  'candidary-default',
  'garden-party',
  'midnight-film',
  'coastal-light',
] as const;

const hexColorSchema = z.string()
  .regex(/^#[0-9a-fA-F]{6}$/u)
  .transform((value) => value.toLowerCase() as HexColor);

const rawEventThemeConfigSchema = z.strictObject({
  version: z.literal(1),
  presetId: z.enum(EVENT_THEME_PRESET_IDS),
  overrides: z.strictObject({
    primaryColor: hexColorSchema.optional(),
    accentColor: hexColorSchema.optional(),
  }),
});
```

Export the transform body as `normalizeEventThemeConfig(input)` and use it from
`eventThemeConfigSchema` to remove overrides identical to the selected preset.
Serialize only the normalized, newly constructed object in
`version`, `presetId`, `overrides` order and construct override keys in
`primaryColor`, `accentColor` order.

`parseStoredEventThemeConfig()` catches JSON and structural failures and returns
a fresh canonical default object. It must not call `resolveEventTheme()`.

- [ ] **Step 5: Implement the 45-token registry and resolver**

Transcribe the approved version-1 registry from design-spec section 9 exactly.
Export UI metadata with stable ID, textual name, description, and resolved base
tokens. Implement:

```ts
export class EventThemeResolutionError extends Error {
  constructor(
    public readonly field: 'overrides.primaryColor' | 'overrides.accentColor',
    message: string,
  ) {
    super(message);
  }
}

export function resolveEventTheme(
  input: EventThemeConfigV1,
): ResolvedEventTheme;

export function resolvedThemeView(
  input: EventThemeConfigV1,
): ResolvedEventTheme;
```

Use WCAG sRGB luminance. For a primary override choose `#ffffff` or `#111111`,
derive the 10% hover, resolve on-surface color against page, surface, and raised
surface in 5% steps toward preset text, and derive 13% `primaryShadow`. For an
accent override use the approved anchored formula
`presetSoft + 0.12 * (customAccent - presetAccent)` and resolve both foregrounds.
Throw `EventThemeResolutionError` when an allowlisted foreground cannot clear
`4.5:1`. `resolvedThemeView()` catches only semantic resolution failure
and returns the canonical default config and tokens together.

- [ ] **Step 6: Complete contrast, derivation, and serialization tests**

Cover:

- `#777777` rejection for representative foreground gaps;
- black, white, dark, light, and mid-tone accepted colors;
- exact `#f9ddc4` Candidary Default anchored soft color;
- continuity one channel above and below every preset accent;
- exact `#92848c` input-border ratios against all three surfaces;
- every preset focus ratio;
- primary/action, accent, soft-accent, muted-text, page-text, and full-screen
  foreground contrast;
- decorative-border exemptions;
- stable parse/serialize/parse round trips; and
- malformed, unsupported-version, and semantically invalid stored fallback.

Use a test-local raster sampler for the documented 145 degree, 53% no-cover
gradient plus its 180 degree overlay at 390 x 205, 390 x 420, and 620 x 265.
Assert every sampled pixel clears `4.5:1` against white.

- [ ] **Step 7: Run focused verification and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-theme.test.ts
npm run typecheck
git add shared/contracts.ts shared/event-theme.ts tests/unit/event-theme.test.ts
git commit -m "feat: define event theme contract"
```

Expected: focused unit tests and typecheck pass.

---

### Task 2: Persist canonical configuration on each event

**Files:**

- Create: `migrations/0007_event_theme.sql`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/events.ts`
- Modify: `worker/services/events.ts`
- Modify: `worker/routes/public.ts`
- Create: `tests/worker/migration-0007.test.ts`
- Modify: `tests/worker/core-journey.test.ts`
- Modify: `tests/worker/repositories.test.ts`

**Interfaces:**

- Consumes: `EventThemeConfigV1`
- Consumes: `DEFAULT_EVENT_THEME_CONFIG`
- Consumes: `parseStoredEventThemeConfig()`
- Consumes: `serializeEventThemeConfig()`
- Produces: `EventRow.theme_config`
- Produces: internal `EventRecord.themeConfig`
- Produces: `CreateEventInput.theme: EventThemeConfigV1`
- Produces: `CreateEventRecord.themeConfig: string`
- Produces: `EventsRepository.updateTheme(id, serializedTheme)`

- [ ] **Step 1: Write the populated migration regression**

Create `tests/worker/migration-0007.test.ts` following
`migration-0006.test.ts`. Apply migrations through 0006, insert an event with an
event token, session, media row, guest message, and host membership, apply only
0007, and assert every row remains.

Assert both the legacy row and a post-migration row contain exactly:

```json
{"version":1,"presetId":"candidary-default","overrides":{}}
```

Also assert malformed JSON, valid non-object JSON, and values longer than 512
characters fail the column CHECK.

- [ ] **Step 2: Run the migration test and verify 0007 is absent**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0007.test.ts
```

Expected: FAIL because migration `0007_event_theme.sql` cannot be found.

- [ ] **Step 3: Add the additive D1 migration**

Create exactly:

```sql
ALTER TABLE events
ADD COLUMN theme_config TEXT NOT NULL
DEFAULT '{"version":1,"presetId":"candidary-default","overrides":{}}'
CHECK (
  length(theme_config) <= 512
  AND json_valid(theme_config)
  AND json_type(theme_config) = 'object'
);
```

Do not edit `vitest.worker.config.ts`; its `readD1Migrations()` call discovers
0007.

Run the migration test again and require it to pass before adding repository
behavior:

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0007.test.ts
```

- [ ] **Step 4: Write failing repository mapping and isolation tests**

Extend `tests/worker/repositories.test.ts` to assert:

```ts
const coastal = {
  version: 1,
  presetId: 'coastal-light',
  overrides: { primaryColor: '#125f6b' },
} as const;

await repository.updateTheme(
  'event-a',
  serializeEventThemeConfig(coastal),
);
expect((await repository.getById('event-a'))?.themeConfig).toEqual(coastal);
expect((await repository.getById('event-b'))?.themeConfig)
  .toEqual(DEFAULT_EVENT_THEME_CONFIG);
```

Add malformed stored JSON fallback and a no-row/deleted-row update expectation
with the exact error `Event theme was not updated.`. Extend the existing core
creation journey to read the new DB column and prove an event created without a
client theme currently stores the exact canonical Default string.

- [ ] **Step 5: Map and write canonical configuration**

Add `theme_config` to `EventRow` and a normalized `themeConfig` to
`EventRecord`. `mapEvent()` calls only `parseStoredEventThemeConfig()`.

Add `themeConfig: string` to `CreateEventRecord`; the repository binds that
already-canonical string unchanged in the existing event INSERT.
`CreateEventInput` receives a required normalized `theme:
EventThemeConfigV1`; `EventService.create()` serializes it with
`serializeEventThemeConfig()` before constructing the existing D1 batch. The
public route supplies `DEFAULT_EVENT_THEME_CONFIG` when the request omits
`theme`, so the event, theme, links, session, and optional ownership remain one
atomic service operation.

At this persistence stage, keep the public request schema unchanged but pass
`{ ...parsed.data, theme: DEFAULT_EVENT_THEME_CONFIG }` to the service. Task 3
then adds the optional validated request field without leaving an intermediate
commit that fails typecheck or creates a row without explicit canonical JSON.

Implement:

```ts
async updateTheme(
  id: string,
  serializedTheme: string,
): Promise<EventRecord> {
  const result = await this.db.prepare(`
    UPDATE events
    SET theme_config = ?
    WHERE id = ? AND deleted_at IS NULL
  `).bind(serializedTheme, id).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error('Event theme was not updated.');
  }
  return (await this.getById(id))!;
}
```

- [ ] **Step 6: Run focused Worker tests and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0007.test.ts tests/worker/repositories.test.ts tests/worker/core-journey.test.ts
npm run typecheck
git add migrations/0007_event_theme.sql worker/db/types.ts worker/db/events.ts worker/services/events.ts worker/routes/public.ts tests/worker/migration-0007.test.ts tests/worker/core-journey.test.ts tests/worker/repositories.test.ts
git commit -m "feat: persist per-event themes"
```

Expected: migration, repository, and type checks pass.

---

### Task 3: Add safe event-view serialization and authorized theme APIs

**Files:**

- Create: `worker/http/event-view.ts`
- Create: `worker/http/validation.ts`
- Modify: `worker/routes/public.ts`
- Modify: `worker/routes/event.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `worker/routes/content.ts`
- Create: `tests/worker/event-theme-api.test.ts`
- Modify: `tests/worker/core-journey.test.ts`
- Modify: `tests/worker/manage-api.test.ts`

**Interfaces:**

- Consumes: `eventThemeConfigSchema`
- Consumes: `resolveEventTheme()`
- Consumes: `resolvedThemeView()`
- Consumes: `serializeEventThemeConfig()`
- Produces: `fieldErrors(error, prefix?)`
- Produces: `eventView(event)`
- Produces: `guestEventView(event)`
- Produces: `PUT /api/manage/events/:eventId/theme`
- Produces: `GET /api/manage/events/:eventId/cover`

- [ ] **Step 1: Write failing create/read contract tests**

In `tests/worker/event-theme-api.test.ts`, cover:

- omitted create theme returns canonical default config and all 45 tokens;
- valid Coastal Light plus normalized overrides persists and reads identically;
- an unrelated create-root key retains existing strip behavior;
- create `theme.evil` and `theme.overrides.evil` are rejected;
- declarations, `url()`, `var()`, HTML, external-resource strings, shorthand
  hex, alpha hex, unknown presets, and unknown versions return 422;
- ordinary Zod paths remain dotted; and
- every `unrecognized_keys` entry names the exact rejected key.

Assert guest JSON contains only the existing guest fields plus `theme`, while
manager/create views contain the enumerated `EventView`; neither contains
`themeConfig` or `theme_config`.

- [ ] **Step 2: Run the focused API test and verify the old response**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-theme-api.test.ts
```

Expected: FAIL because create does not accept `theme` and responses do not
contain a resolved theme.

- [ ] **Step 3: Add exact Zod field-path formatting**

Create `worker/http/validation.ts`:

```ts
import { z } from 'zod';

export function fieldErrors(
  error: z.ZodError,
  prefix: readonly PropertyKey[] = [],
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const field = [...prefix, ...issue.path, key].map(String).join('.');
        fields[field || 'form'] ??= issue.message;
      }
      continue;
    }
    const field = [...prefix, ...issue.path].map(String).join('.');
    fields[field || 'form'] ??= issue.message;
  }
  return fields;
}
```

Use it in `public.ts` without making the top-level create schema strict. Prefix
semantic `EventThemeResolutionError.field` with `theme.` for create errors and
leave it unprefixed for the direct update body.

- [ ] **Step 4: Add strict create handling and explicit response mappers**

Create `worker/http/event-view.ts`. `eventView()` must explicitly enumerate the
current 18 public event fields and append
`theme: resolvedThemeView(event.themeConfig)`. `guestEventView()` explicitly
enumerates only ID, slug, name, date, welcome, cover key, three flags, and
theme. Do not use object rest or spread on `EventRecord`.

Extend `public.ts`'s existing non-strict create object with `theme:
eventThemeConfigSchema.default(DEFAULT_EVENT_THEME_CONFIG)`. Successfully
resolve the normalized configuration before calling `EventService.create()` so
new writes never use a stored-data fallback. Map structural and semantic errors
to the exact dotted create paths.

Use the full mapper for create, manager read, cover finalize, settings update,
and theme update. Use the guest mapper for `GET /api/event/:slug`. Update each
existing route at the point it forms the response; do not change
`host-auth.ts`'s narrow host-event-list mapper or expose theme there.

Run the create/read subset and require it to pass before adding update-route
tests:

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-theme-api.test.ts -t "create|guest read|manager read|serialization"
```

- [ ] **Step 5: Add failing update authorization and isolation tests**

Cover both link-manager and owning-account updates. When both credentials exist,
an owning account wins and requires host CSRF; an unrelated account falls
through to the matching manager link and requires that event's CSRF. Cover
missing/wrong/foreign-origin CSRF, missing manager authorization,
unrelated-account denial, cross-event denial, reset payload, unknown update-root
keys, malicious values, event isolation, the repository zero-change guard, and
a D1-triggered update refusal that leaves the prior theme unchanged.

Exercise all six event serialization paths and assert stored semantic-invalid
config defaults only on a view response. Spy on or structurally separate the
resolver so an upload reservation/finalization authentication path proves it
does not resolve tokens.

For the manager cover read, cover owning-account and matching-link success,
verify GET requires no CSRF, and reject a missing session, unrelated account,
guest credential, and cross-event credential. Preserve stable errors for an
event with no cover and a missing R2 object.

- [ ] **Step 6: Implement the update route**

After `requireManager(context, { write: true })`, structurally parse and
normalize the body, resolve it server-side, canonically serialize
`resolved.config`, call
`updateTheme(auth.event.id, serializedTheme)`, and return:

```ts
return context.json({
  data: { event: eventView(updated) },
  requestId: context.get('requestId'),
});
```

Reset is the same route with `DEFAULT_EVENT_THEME_CONFIG`. Do not add a DELETE
route or account-level theme route.

- [ ] **Step 7: Add the manager-authorized cover read**

Refactor the existing guest-cover object response into one private/no-store
helper in `worker/routes/content.ts`. Add
`GET /manage/events/:eventId/cover`, call `requireManager(context)`, read only
`auth.event.coverObjectKey`, and reuse the same body and headers. Preserve
`EVENT_NOT_FOUND` for no cover and `UPLOAD_OBJECT_MISSING` for a missing object.
Successful reads are binary; error responses keep the JSON envelope.

- [ ] **Step 8: Run focused Worker verification and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-theme-api.test.ts tests/worker/core-journey.test.ts tests/worker/manage-api.test.ts
npm run typecheck
git add worker/http/event-view.ts worker/http/validation.ts worker/routes/public.ts worker/routes/event.ts worker/routes/manage.ts worker/routes/content.ts tests/worker/event-theme-api.test.ts tests/worker/core-journey.test.ts tests/worker/manage-api.test.ts
git commit -m "feat: expose authorized event themes"
```

Expected: theme API, existing journey, manager-cover, and type checks pass.

---

### Task 4: Create exhaustive client theme primitives

**Files:**

- Modify: `src/app/types.ts`
- Modify: `src/app/api.ts`
- Create: `src/app/event-theme-style.ts`
- Create: `src/app/use-event-cover.ts`
- Create: `src/components/EventThemePresetSelector.tsx`
- Create: `src/components/EventAppearancePreview.tsx`
- Modify: `src/styles.css`
- Create: `tests/unit/event-theme-style.test.ts`
- Create: `tests/ui/event-theme-rendering.test.tsx`

**Interfaces:**

- Consumes: shared `EventView`, `GuestEventView`, and `EventThemeTokens`
- Produces: `EVENT_THEME_CSS_PROPERTIES`
- Produces: `eventThemeStyle(tokens): CSSProperties`
- Produces: `guestEventCoverPath(slug)` and `managerEventCoverPath(eventId)`
- Produces: `useEventCover(path): string | null`
- Produces: `EventThemePresetSelector`
- Produces: `EventAppearancePreview`

- [ ] **Step 1: Write the failing exhaustive-style test**

Assert that `EVENT_THEME_CSS_PROPERTIES` has exactly the same keys as a resolved
token object, that every value matches `^--event-[a-z0-9-]+$`, and that
`eventThemeStyle()` emits no additional property.

Assert representative mappings:

```ts
expect(style['--event-page']).toBe('#edf7f5');
expect(style['--event-primary']).toBe('#0c6370');
expect(style['--event-cover-text-scrim']).toBe('rgb(5 31 35 / 64%)');
expect(style['--event-frame-radius']).toBe('20px');
```

- [ ] **Step 2: Run the unit test and verify the missing adapter**

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-theme-style.test.ts
```

Expected: FAIL because the client adapter does not exist.

- [ ] **Step 3: Re-export shared event types and implement the fixed map**

Remove the local `EventView` declaration from `src/app/types.ts` and re-export
`EventView` and `GuestEventView` from `shared/contracts.ts`.

In `event-theme-style.ts`, explicitly list all 45 key/property pairs and declare
the object with:

```ts
export const EVENT_THEME_CSS_PROPERTIES = {
  page: '--event-page',
  surface: '--event-surface',
  raisedSurface: '--event-raised-surface',
} as const satisfies Record<
  keyof EventThemeTokens,
  `--event-${string}`
>;
```

Continue the literal map through `frameRadius`; do not derive property names
from request keys or camel-case conversion. `eventThemeStyle()` must iterate
this fixed map rather than `Object.entries(tokens)`, so an unexpected response
key can never become a CSS custom property.

Run the adapter test and require it to pass before adding component tests:

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-theme-style.test.ts
```

- [ ] **Step 4: Write failing selector, preview, and private-cover tests**

Render `EventThemePresetSelector` and assert four native radios with textual
names, descriptions, visible palette samples, and checked state. Render
`EventAppearancePreview` with Coastal Light and assert its wrapper carries the
resolved variables while the document root and an adjacent manager element do
not.

Assert the preview contains event identity, welcome/body text, a primary action,
a secondary action, surface treatment, and no interactive button, link, form
control, or heading landmark. Assert selector swatches do not create a theme
scope.

Test a same-origin successful cover read, non-OK response, replaced path, and
unmount. A successful response returns one blob URL and revokes it exactly once;
a failed response leaves the no-cover hero and never installs the cover
modifier. Verify the encoded guest and manager helpers produce only the
authorized route paths.

- [ ] **Step 5: Implement the fixed adapter and private-cover lifecycle**

Re-export the shared event view types from `src/app/types.ts`. Add encoded cover
path helpers to `src/app/api.ts`.

Implement:

```ts
export function useEventCover(path: string | null): string | null;
```

Fetch with same-origin credentials and an `AbortController`. Require `response.ok`,
convert the binary body to one blob URL, ignore stale completions, and revoke
the previous URL on replacement and unmount. Return `null` for a missing path,
non-OK response, abort, or read failure. Do not log the private path or object
key.

- [ ] **Step 6: Implement reusable selector and inert preview**

`EventThemePresetSelector` accepts:

```ts
interface EventThemePresetSelectorProps {
  value: EventThemePresetId;
  onChange(value: EventThemePresetId): void;
  name: string;
  disabled?: boolean;
}
```

Use one `fieldset`, one `legend`, and four labelled native radios. Use preset
metadata from `EVENT_THEME_PRESETS`; swatches supplement rather than replace
text.

`EventAppearancePreview` accepts the event identity/content/cover fields and a
`ResolvedEventTheme`. It treats `coverObjectKey` only as a presence flag, calls
`useEventCover(managerEventCoverPath(event.id))`, and installs `--event-cover`
and the cover modifier only after that read succeeds. Use non-interactive spans
for sample actions, keep the visual subtree `aria-hidden`, provide a concise
figure caption, avoid duplicate heading landmarks, and install
`eventThemeStyle()` only on `.event-appearance-preview`.

- [ ] **Step 7: Add globally branded selector and scoped preview CSS**

Style the selector with fixed global Candidary tokens because it appears in
creation and Manager chrome. Style `.event-appearance-preview` entirely with
the explicit event roles and their Candidary Default fallbacks; keep every child
inside the preview wrapper. Preserve 44 px radio-card targets and 320 px
containment.

- [ ] **Step 8: Run focused verification and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-theme-style.test.ts tests/ui/event-theme-rendering.test.tsx
npm run typecheck
git add src/app/types.ts src/app/api.ts src/app/event-theme-style.ts src/app/use-event-cover.ts src/components/EventThemePresetSelector.tsx src/components/EventAppearancePreview.tsx src/styles.css tests/unit/event-theme-style.test.ts tests/ui/event-theme-rendering.test.tsx
git commit -m "feat: add event theme UI primitives"
```

Expected: adapter, selector, preview, and type checks pass.

---

### Task 5: Add theme selection to one-step event creation

**Files:**

- Modify: `src/pages/CreatePage.tsx`
- Modify: `src/styles.css`
- Create: `tests/ui/event-theme-creation.test.tsx`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**

- Consumes: `EventThemePresetSelector`
- Consumes: `DEFAULT_EVENT_THEME_CONFIG`
- Produces: optional canonical `theme` in `POST /api/events`

- [ ] **Step 1: Write failing creation-selector tests**

Render `/create` and assert:

- Candidary Default is initially selected;
- all four named choices are keyboard-operable radios;
- the fieldset follows Welcome message and precedes Cover photo;
- choosing Coastal Light changes the checked radio without adding a route or
  step; and
- the POST body contains
  `{"version":1,"presetId":"coastal-light","overrides":{}}`.

Retain the existing first-invalid-field focus tests and assert the new selector
does not alter their order.

- [ ] **Step 2: Run the UI test and verify the selector is missing**

```powershell
npx vitest run --config vitest.config.ts tests/ui/event-theme-creation.test.tsx tests/ui/app.test.tsx -t "theme|creates an event|invalid field"
```

Expected: FAIL because no Event theme fieldset or theme payload exists.

- [ ] **Step 3: Add controlled preset state and canonical submit data**

Initialize:

```ts
const [themePresetId, setThemePresetId] =
  useState<EventThemePresetId>('candidary-default');
```

Render the shared selector immediately after the Welcome message field and
before Cover photo. Submit:

```ts
theme: {
  version: EVENT_THEME_VERSION,
  presetId: themePresetId,
  overrides: {},
},
```

Do not expose custom colors or introduce another screen.

- [ ] **Step 4: Run creation UI verification and commit**

```powershell
npx vitest run --config vitest.config.ts tests/ui/event-theme-creation.test.tsx tests/ui/app.test.tsx
npm run typecheck
git add src/pages/CreatePage.tsx src/styles.css tests/ui/event-theme-creation.test.tsx tests/ui/app.test.tsx
git commit -m "feat: choose a theme during event creation"
```

Expected: creation, error focus, and type checks pass.

---

### Task 6: Add the Manager Event appearance editor

**Files:**

- Create: `src/components/EventAppearanceEditor.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/styles.css`
- Create: `tests/ui/event-appearance-editor.test.tsx`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**

- Consumes: `EventThemePresetSelector`
- Consumes: `EventAppearancePreview`
- Consumes: `resolveEventTheme()`
- Produces: local `savedTheme` and `draftTheme`
- Produces: `PUT /api/manage/events/:eventId/theme`
- Produces: `onEventSaved(event: EventView)`

- [ ] **Step 1: Write failing local-preview and save tests**

Render the editor with a default event and assert:

- selecting Garden Party updates only preview variables;
- no theme mutation request occurs before Save; an authorized preview-cover GET
  is allowed when the event has a cover;
- primary and accent text fields accept strict six-digit values;
- invalid syntax or contrast keeps the previous valid preview and renders an
  associated inline error;
- Use preset primary/accent removes only the matching override;
- changing preset clears both overrides;
- Reset to Candidary default changes only local state;
- Save sends the canonical configuration;
- successful Save adopts the server-normalized response;
- failed Save retains raw input, the draft, preview, dirty/unsaved status,
  Settings position, and a retryable Save;
- saved and unsaved status text changes at the correct boundaries; and
- Save is disabled for no change, invalid state, and an active request.

- [ ] **Step 2: Run the editor tests and verify the component is missing**

```powershell
npx vitest run --config vitest.config.ts tests/ui/event-appearance-editor.test.tsx -t "appearance|preview|Save|Reset"
```

Expected: FAIL because `EventAppearanceEditor` does not exist.

- [ ] **Step 3: Implement explicit saved/draft state**

The component receives:

```ts
interface EventAppearanceEditorProps {
  event: EventView;
  onEventSaved(event: EventView): void;
}
```

Own the saved configuration, last-valid draft configuration, raw primary and
accent strings, resolved preview, field errors, busy state, save error, and
saved/unsaved status. Keep raw color text separate from the last valid resolved
preview. Validate syntax with six-digit hex before calling strict
`resolveEventTheme()`; never use the stored-data fail-safe for a draft. Compare
canonical serialized configurations for dirty state. Pair each labelled
`type="color"` well with a labelled text field.

Changing preset clears both overrides. Each `Use preset` control removes only
its matching override and has `type="button"`. Reset also has `type="button"`
and changes local state to `DEFAULT_EVENT_THEME_CONFIG`; it does not mutate the
server until Save. Use the normalized server response as the only source for
replacing `savedTheme`.

Catch `ClientApiError` inside the editor so a failed save remains beside the
draft instead of refreshing the whole manager. Preserve field errors for
`overrides.primaryColor` and `overrides.accentColor`.

- [ ] **Step 4: Insert Event appearance inside Settings**

In `ManagerPage`, render the editor after the existing settings form and before
`EventAccountCard` and `.danger-zone`:

```tsx
<EventAppearanceEditor
  key={event.id}
  event={event}
  onEventSaved={(updated) => setEvent(updated)}
/>
```

Keep exactly five navigation destinations. Do not nest forms, route the
appearance Save through `runManagerAction`, or call the full `refresh()` after
Save; adopt the returned event directly. The preview constructs its authorized
cover path from the event ID and never uses the raw object key as a URL. Do not
install event variables on `.manager-shell`, `.manager-main`, or
`.manager-panel`.

- [ ] **Step 5: Add responsive editor CSS**

Keep selector, paired color controls, preview, status, Save, and Reset contained
at 320 px. Make Save and Reset at least 44 px, preserve visible focus, and keep
Reset visually secondary. The preview receives event shape tokens; editor
controls and manager surroundings retain global tokens.

- [ ] **Step 6: Run focused Manager verification and commit**

```powershell
npx vitest run --config vitest.config.ts tests/ui/event-appearance-editor.test.tsx tests/ui/app.test.tsx
npm run typecheck
git add src/components/EventAppearanceEditor.tsx src/pages/ManagerPage.tsx src/styles.css tests/ui/event-appearance-editor.test.tsx tests/ui/app.test.tsx
git commit -m "feat: edit event appearance in manager settings"
```

Expected: editor behavior, existing manager behavior, and type checks pass.

---

### Task 7: Apply semantic themes to every guest-facing state

**Files:**

- Modify: `src/pages/EventPage.tsx`
- Modify: `src/features/uploads/GuestUploadFlow.tsx`
- Modify: `src/styles.css`
- Modify: `tests/ui/event-theme-rendering.test.tsx`
- Modify: `tests/ui/guest-upload-flow.test.tsx`

**Interfaces:**

- Consumes: `GuestEventView.theme`
- Consumes: `eventThemeStyle()`
- Consumes: `guestEventCoverPath()` and `useEventCover()`
- Produces: scoped variables on `.guest-shell--drop` and `.fullscreen`
- Produces: `.photo-drop__hero-copy` cover-only scrim

- [ ] **Step 1: Write failing guest-scope tests**

Cover Default, Garden Party, Midnight Film, Coastal Light, and representative
custom primary/accent configurations. Assert:

- `.guest-shell--drop` and `.fullscreen` receive only allowlisted variables;
- loading and authorization errors remain globally branded;
- host/create elements outside the scope retain global values;
- required marker, remembered-name border, review divider, placeholder icon,
  selection summary, and page/form ink map to their exact semantic variables;
- failure/danger and delivery colors do not change across presets;
- terminal delivery remains the existing done receipt with no promotional copy
  or new call to action;
- text buttons, New badge, spinner foreground, progress fill, and active send
  use event primary;
- Notes placeholder and divider use accessible event tokens; and
- full-screen backdrop, foreground, Brand mark, close focus, and caption
  readability treatment remain correct;
- a successful authorized cover read installs one blob URL and cover modifier;
  and
- refused, missing, stale, or aborted cover reads retain the exact no-cover
  gradient with no cover modifier or scrim.

- [ ] **Step 2: Run the focused UI tests and verify literal styling remains**

```powershell
npx vitest run --config vitest.config.ts tests/ui/event-theme-rendering.test.tsx tests/ui/guest-upload-flow.test.tsx
```

Expected: FAIL because EventPage does not install theme variables and guest CSS
still uses global/literal paint.

- [ ] **Step 3: Install one scope per rendered guest route**

Type EventPage data as `GuestEventView`. Compute the style once from
`event.theme.tokens` and attach it to the loaded guest wrapper or loaded
full-screen `<main>`. Defensively use the canonical resolved default only when a
runtime response lacks `theme`; the shared wire type remains required.

Do not theme `LoadingState` or pre-event `ErrorState`.

- [ ] **Step 4: Add the cover-copy wrapper without moving no-cover pixels**

In `GuestUploadFlow`, call
`useEventCover(event.coverObjectKey ? guestEventCoverPath(slug) : null)`.
Set `.photo-drop__hero--cover` and `--event-cover` only when the hook returns a
blob URL. A private-cover read failure therefore follows the same markup and
gradient path as an event with no cover.

Wrap event/date, welcome, and disclosure control in
`.photo-drop__hero-copy`. Use `display: contents` for the no-cover variant so
the existing flex children keep their geometry. Only
`.photo-drop__hero--cover .photo-drop__hero-copy` becomes a padded bounded
surface using `coverTextScrim` and `cardRadius`.

Keep the existing cover upload/storage pipeline; this changes only how its
private read is proven successful before presentation.

- [ ] **Step 5: Refactor guest CSS to exact semantic roles**

Declare all 45 Candidary Default fallback variables only on
`.guest-shell--drop`, `.fullscreen`, and `.event-appearance-preview`. Never
declare them on `:root`, `.manager-shell`, `.manager-main`, `.manager-panel`, or
`.create-form`. Every `var(--event-*)` consumption includes its exact
Candidary Default value as the CSS fallback so direct component tests and a
defensive legacy runtime response preserve today's appearance.

Do not alias event primary, accent, or a generic border onto global variables:
raw fill colors are not always valid on a surface, and the four border roles
are intentionally distinct. Map selectors explicitly:

- `.guest-shell--drop`: `page`, using `surface` only for its narrow-phone
  primary canvas;
- `.photo-drop`: `surface`, `text`, `border`, `frameRadius`, `frameShadow`;
- no-cover hero: `heroStart`, `heroMid`, `heroEnd`, `heroOverlayTop`,
  `heroOverlayBottom`;
- cover hero: the successful `--event-cover`, `coverOverlayTop`, and
  `coverOverlayBottom`;
- cover copy: `coverTextScrim` and `cardRadius`;
- scoped inputs and textareas: `raisedSurface`, `pageText`, `inputBorder`,
  `inputRadius`, `inputShadow`, with `mutedText` placeholder;
- required marker: `requiredText`; remembered name: `raisedSurface`,
  `rememberedNameBorder`, `inputRadius`;
- filled primary buttons: `primary`, `primaryForeground`, `primaryHover`,
  `primaryShadow`, `actionRadius`;
- text links, text buttons, outlined actions, and section labels:
  `primaryOnSurface`, never raw `primary`;
- review divider/metadata: `reviewDivider` and `mutedText`;
- selection cards: `raisedSurface`, `border`, `cardRadius`; placeholder:
  `mediaPlaceholderStart`, `mediaPlaceholderEnd`,
  `mediaPlaceholderForeground`; status: `cardText` and `mutedText`;
- ordinary spinner, New badge, native progress fill, and active-send chrome:
  `primary` or `primaryOnSurface` according to whether it is a fill or
  on-surface mark;
- selection summary: `selectionSummaryText`;
- secondary page/content: `page`, `pageText`, `sectionBorder`; pending chips:
  `accentSoft`, `accentSoftForeground`; decorative Notes accents: `accent`;
  Notes input uses the input roles above; and
- full-screen root: `fullscreenBackdrop`, `fullscreenForeground`, with Brand,
  mark, close, and focus using the corresponding foreground, primary/accent,
  and focus roles.

Keep danger/failure red, delivered moss/green, failed/delivered borders and
glyphs, media-removal overlay, low-alpha readability shadows, full-screen
caption black gradient, disabled opacity, spinner geometry, reduced motion,
and focus thickness/offset fixed.

Explicitly scope shared `.brand`, `.text-link`, `.text-button`, `.button`,
`.section-label`, `input`, `textarea`, `.photo-grid`, `.empty-state`,
`.contributions`, `.status--pending`, `.note-form`, `.notes-feed`, and footer
rules. Do not modify their unscoped global behavior.

- [ ] **Step 6: Verify all guest states and commit**

```powershell
npx vitest run --config vitest.config.ts tests/ui/event-theme-rendering.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/app.test.tsx
npm run typecheck
npm run lint
git add src/pages/EventPage.tsx src/features/uploads/GuestUploadFlow.tsx src/styles.css tests/ui/event-theme-rendering.test.tsx tests/ui/guest-upload-flow.test.tsx
git commit -m "feat: theme every guest event state"
```

Expected: guest/UI suites, typecheck, and lint pass without changing host chrome.

---

### Task 8: Add responsive, accessibility, CSP, and visual evidence

**Files:**

- Create: `tsconfig.e2e.json`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/fixtures/ui-data.ts`
- Create: `tests/e2e/fixtures/cover-images.ts`
- Create: `tests/e2e/helpers/theme-contrast.ts`
- Create: `tests/e2e/event-theming.spec.ts`
- Create: `tests/e2e/event-theming-visual.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/core-journey.spec.ts`
- Modify: `tests/e2e/guest-responsive.spec.ts`
- Modify: `tests/e2e/security.spec.ts`
- Modify: `tests/e2e/visual-qa.spec.ts`
- Create/modify: `tests/e2e/event-theming-visual.spec.ts-snapshots/*.png`
- Modify: `tests/e2e/visual-qa.spec.ts-snapshots/create-validation-focus-390-mobile-win32.png`
- Modify: `tests/e2e/visual-qa.spec.ts-snapshots/guest-long-welcome-320-mobile-win32.png`
- Modify: `tests/e2e/visual-qa.spec.ts-snapshots/guest-landscape-844x390-mobile-win32.png`

**Interfaces:**

- Produces: themed guest and manager route fixtures
- Produces: 320 px, 390 px, and desktop state matrix
- Produces: all-preset Axe and computed-contrast evidence
- Produces: reviewed screenshots for every preset

- [ ] **Step 1: Extend deterministic route fixtures**

Add canonical default theme to `EVENT_FIXTURE` and export a helper that calls
`resolveEventTheme()` for any preset/override. Let guest and manager stubs serve
the existing preview image from their authorized cover paths when
`coverObjectKey` is present. Let the manager theme PUT parse the request and
return an updated event fixture.

Add deterministic pure-white and pure-black PNG buffers in `cover-images.ts`;
continue using `public/assets/candidary-hero.png` for the high-frequency
photographic cover. Update direct event response literals in
`core-journey.spec.ts`, `security.spec.ts`, `accessibility.spec.ts`, and any
other E2E file found by a contract search. Each must either return a resolved
Default theme or explicitly assert that it is testing the defensive legacy
fallback.

- [ ] **Step 2: Write the failing responsive state matrix**

In `event-theming.spec.ts`, cover 320 x 568, 390 x 844, and 1280 x 900 across:

- cover and no-cover source/name entry;
- 500-character welcome expanded and collapsed;
- review with long filenames;
- active progress and retry/failure;
- terminal receipt;
- gallery, deliveries, and Notes expanded; and
- full-screen gallery with a long caption.

Use this exact rotation:

| State | 320 x 568 | 390 x 844 | 1280 x 900 |
| --- | --- | --- | --- |
| No-cover name/source entry | Default | Coastal | Garden |
| Cover name/source entry | Midnight | Default | Coastal |
| 500-character welcome, collapsed/expanded | Coastal | Default | Garden |
| Review with long filenames | Default | Coastal | Midnight |
| Active progress then retry/failure | Coastal | Default | Garden |
| Terminal receipt | Default | Coastal | Midnight |
| Gallery, deliveries, Notes expanded | Coastal | Default | Garden |
| Full-screen long caption | Default | Coastal | Midnight |

Assert remembered-name, validation, reserving, queued, uploading, finalizing,
cancel, and retry paint; 44 px targets; keyboard operation; reduced motion; the
640 x 450 200%-zoom proxy; and for every row:

```ts
document.documentElement.scrollWidth
  <= document.documentElement.clientWidth + 1
```

- [ ] **Step 3: Add all-pixel hero and cover contrast checks**

In `theme-contrast.ts`, decode locator screenshot bytes in the browser through
`Blob` -> `createImageBitmap()` -> canvas, avoiding a new PNG dependency and a
CSP-sensitive data-URL fetch. For each preset, make text descendants transparent
without changing geometry, assert the rendered hero box is exactly 390 x 205,
390 x 420, or 620 x 265, and require every RGB pixel to clear `4.5:1` against
white.

For covers, test pure white, pure black, and the existing high-frequency preview
fixture. Measure the rendered text bounds and verify the localized scrim keeps
white copy above `4.5:1`.

- [ ] **Step 4: Add all-preset accessibility checks**

Parameterize the guest Axe pass across all four presets and representative
custom black, white, and mid-tone overrides. Keep `target-size` enabled and add
explicit computed checks for text, action text, input boundary, and focus
contrast. Assert each radio choice has a textual accessible name and checked
state. Scan the Manager Settings editor and preview without narrowing Axe's
document scope.

- [ ] **Step 5: Run new browser tests before generating screenshots**

Add `tsconfig.e2e.json` extending `tsconfig.app.json`, replacing `types` with
`["node", "@playwright/test"]`, and including `tests/e2e/**/*.ts`,
`shared/**/*.ts`, and `playwright.config.ts`. The repository's normal
`typecheck` excludes Playwright tests, so run both:

```powershell
npx tsc -p tsconfig.e2e.json --pretty false
npx playwright test tests/e2e/event-theming.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/guest-responsive.spec.ts
```

Expected: behavioral, responsive, contrast, and Axe tests pass against the
production-like build plus Vite preview.

- [ ] **Step 6: Add tracked visual cases**

In `event-theming-visual.spec.ts`, skip mobile-only cases in the desktop project
and the desktop full-screen case in the mobile project. Use these exact logical
snapshot names:

- `guest-default-cover-390.png`;
- `guest-default-notes-390.png`;
- `guest-garden-cover-390.png`;
- `guest-midnight-review-progress-320.png`;
- `guest-coastal-entry-390.png`;
- `guest-coastal-receipt-390.png`;
- `fullscreen-midnight-1280x900.png`; and
- `manager-event-appearance-390.png`.

Mobile files retain `-mobile-win32`; the full-screen file retains
`-desktop-win32`. Capture the manager editor with a tall 390 px viewport at
`scrollY === 0` so sticky navigation cannot overlap it.

Keep existing `visual-qa.spec.ts` cases. The review, secondary, and full-screen
Default baselines must compare byte-for-byte; regenerate only the create form,
long-welcome, and landscape baselines documented by the spec.

- [ ] **Step 7: Generate and review Windows baselines**

First run the visual suites without snapshot updates. Then update only the new
visual file and the existing create/guest cases that produce the three approved
Default changes. The existing guest case also visits the protected review
state, so immediately prove its file did not move:

```powershell
npx playwright test tests/e2e/visual-qa.spec.ts tests/e2e/event-theming-visual.spec.ts --project=mobile
npx playwright test tests/e2e/event-theming-visual.spec.ts --project=desktop
npx playwright test tests/e2e/event-theming-visual.spec.ts --project=mobile --update-snapshots
npx playwright test tests/e2e/event-theming-visual.spec.ts --project=desktop --update-snapshots
npx playwright test tests/e2e/visual-qa.spec.ts --project=mobile --grep "create form" --update-snapshots
npx playwright test tests/e2e/visual-qa.spec.ts --project=mobile --grep "guest photo drop" --update-snapshots
git diff --exit-code -- tests/e2e/visual-qa.spec.ts-snapshots/guest-review-320-mobile-win32.png tests/e2e/visual-qa.spec.ts-snapshots/guest-secondary-long-content-320-mobile-win32.png tests/e2e/visual-qa.spec.ts-snapshots/fullscreen-long-caption-320-mobile-win32.png
```

Inspect every changed/new PNG at original resolution. Confirm first-fold
hierarchy, contrast, control states, long-content containment, and that manager
chrome outside the preview remains global. Run
`git status --short -- tests/e2e/*-snapshots` and confirm that snapshot scope
lists only the eight new files and the three approved Default baseline updates;
the expected E2E source, fixture, and `tsconfig.e2e.json` changes remain visible
in the full status separately.

- [ ] **Step 8: Re-run visual comparisons and commit**

```powershell
npx playwright test tests/e2e/visual-qa.spec.ts tests/e2e/event-theming-visual.spec.ts --project=mobile
npx playwright test tests/e2e/event-theming-visual.spec.ts --project=desktop
npx tsc -p tsconfig.e2e.json --pretty false
git add tsconfig.e2e.json tests/e2e
git commit -m "test: verify event themes across guest states"
```

Expected: every tracked comparison passes with zero differing pixels.

---

### Task 9: Document the scoped overlay and verify the final head

**Files:**

- Modify: `design/design-system.md`
- Modify: `design/fidelity-ledger.md`
- Modify: `design-qa.md`

**Interfaces:**

- Produces: binding global-versus-event token contract
- Produces: reviewed preset/baseline/viewport evidence ledger
- Produces: final verification record

- [ ] **Step 1: Update the binding design system**

Add a scoped Event theme overlay section that states:

- the existing global table remains binding for public and host chrome;
- only the 45 documented semantic variables may be installed on guest,
  full-screen, and preview scopes;
- danger, delivery, focus geometry, progress meaning, fonts, spacing, and
  workflow hierarchy remain non-overridable;
- only primary/accent six-digit colors are accepted;
- only bundled Manrope and DM Sans are used; and
- raw CSS, URLs, external fonts/assets, arbitrary properties, and a second image
  system remain forbidden.

- [ ] **Step 2: Update the fidelity ledger from reviewed evidence**

Name every new snapshot and tested state, record the three intentionally updated
Default baselines and the three pixel-identical Default baselines, list all four
presets, note custom-color extremes, and distinguish automated browser evidence
from unperformed physical-device and deployment validation. Update
`design-qa.md`'s authoritative route/state/viewport table, tracked-baseline
inventory, E2E TypeScript command, manager-preview isolation evidence, and
production-like CSP test procedure so it does not describe the pre-theme suite.

- [ ] **Step 3: Commit documentation and final evidence**

```powershell
git add design/design-system.md design/fidelity-ledger.md design-qa.md
git commit -m "docs: record event theme evidence"
```

Do not amend earlier task commits. Make no further file changes after this
commit unless a verification failure requires a new test-first fix and a new
commit.

- [ ] **Step 4: Run targeted suites on the final HEAD**

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-theme.test.ts tests/unit/event-theme-style.test.ts tests/ui/event-theme-creation.test.tsx tests/ui/event-appearance-editor.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/guest-upload-flow.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0007.test.ts tests/worker/event-theme-api.test.ts tests/worker/manage-api.test.ts tests/worker/core-journey.test.ts
npx tsc -p tsconfig.e2e.json --pretty false
npx playwright test tests/e2e/event-theming.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/visual-qa.spec.ts
```

Expected: all targeted theme and regression suites pass.

- [ ] **Step 5: Run every required full gate on that same HEAD**

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
git diff --check
```

Expected: every command exits zero on the same final HEAD.

- [ ] **Step 6: Prove the handoff state**

Run `git status --short --branch`, `git log --oneline
051478a5e575e0849ac75bbef08a1850dbc2526a..HEAD`, and recheck the primary HSTS
worktree plus `CandidaryDesignSystem.zip`. Prepare the handoff with architecture,
rejected alternatives, exact data/API contract, per-preset screenshots,
migration/file list, targeted/full gate results, untouched unrelated-work
confirmation, and explicitly unperformed physical-device/deployment validation.
