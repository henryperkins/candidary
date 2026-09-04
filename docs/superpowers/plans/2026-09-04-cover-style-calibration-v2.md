# Cover Style Calibration V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the five Cover Studio styles visibly distinct on both preset art and host-uploaded photos, while preserving already-published v1 preset bytes and v1 upload treatment behavior.

**Architecture:** Ship a new immutable preset asset release and a versioned tonal recipe. The browser preset builder and Cloudflare Images renderer share the same calibrated intent, while an additive render-recipe envelope pins upload recipe v2 without changing the public stored-cover schema. Film grain remains a runtime layer and resolves to v1 or v2 from durable publication state so previews and published heroes agree.

**Tech Stack:** TypeScript 6, React 19, Vitest, Playwright, Cloudflare Workers Images binding, D1, static versioned cover assets.

**Spec:** `docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md`

## Global Constraints

- Natural is unchanged: tonal transform `{ sharpen: 1 }` and Canvas filter `none`.
- Warm v2 is `{ saturation: 1.04, contrast: 0.99, sharpen: 1 }` followed by a source-over `#e7b78d` wash at opacity `0.05`; there is no gamma or brightness lift.
- Film v2 is `{ contrast: 0.95, saturation: 0.80, sharpen: 1 }` plus runtime `film-grain-v2` at opacity `0.10`.
- Soft v2 is `{ saturation: 0.96, contrast: 0.92, sharpen: 0.6 }`; there is no brightness lift.
- Monochrome v2 is `{ saturation: 0, contrast: 1.02, sharpen: 1 }` and Canvas `grayscale(1) contrast(1.02)`.
- The same style IDs and semantic recipes apply to built-in presets and uploaded photos; numeric transforms remain server-owned and are never client-authored.
- Preset asset v1 and `film-grain-v1` remain byte-addressable and unchanged. New preset publications pin asset v2; existing preset publications continue to resolve their pinned version.
- Legacy upload render-set rows whose `recipe_json` is a bare stored config resolve tonal recipe 1 and `film-grain-v1`. New upload render sets persist a strict v2 render-recipe envelope and resolve tonal recipe 2 and `film-grain-v2`.
- Film grain is layered exactly once in style thumbnails, the draft canvas, and the authoritative hero in image -> grain -> scrim -> content order. It is never baked into derivative image bytes.
- Existing public `StoredEventCoverConfigV1` and publish-request shapes remain compatible. A forward-only D1 migration may replace only the preset-version invariant triggers so the closed set of accepted preset asset versions is 1 or 2.
- Use the Images binding `draw()` API with a server-owned one-pixel `#e7b78d` PNG stream, `{ opacity: 0.05, repeat: true, composite: 'over' }`, for Warm v2.
- Do not alter the six built-in source artworks, the five style choices, crop behavior, style copy, or Cover Studio navigation.
- Run only the focused checks named below. Do not run repository-wide gates.
- Do not stage, commit, push, deploy, or mutate the primary checkout. Leave all implementation changes uncommitted in this isolated worktree.

---

### Task 1: Version and calibrate the complete Cover Studio style pipeline

**Files:**

- Modify: `shared/event-cover.ts`
- Modify: `scripts/build-cover-presets.ts`
- Modify: `scripts/verify-cover-presets.ts` only if its version checks need to understand the v2 treatment name
- Create: `worker/storage/event-cover-effects.ts`
- Modify: `worker/storage/event-cover-images.ts`
- Modify: `worker/services/event-cover-publication.ts`
- Modify: `worker/workflows/cover-render.ts`
- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `worker/http/event-cover-view.ts`
- Create: `migrations/0022_event_cover_preset_asset_v2.sql`
- Modify: `src/features/cover/CoverStylePicker.tsx`
- Modify: `src/components/EventAppearanceCanvas.tsx`
- Modify: `src/components/EventAppearanceEditor.tsx`
- Modify: `src/components/ResponsiveEventCover.tsx`
- Modify: `src/styles.css`
- Generate: `public/assets/event-covers/v2/manifest.json`
- Generate: `public/assets/event-covers/v2/film-grain-v2.png`
- Generate: `public/assets/event-covers/v2/<preset>/<effect>/<profile>-<density>.<format>` (720 files)
- Test: `tests/unit/event-cover.test.ts`
- Test: `tests/unit/cover-presets.test.ts`
- Test: `tests/unit/cover-contrast.test.ts`
- Test: `tests/worker/event-cover-images.test.ts`
- Test: `tests/worker/event-cover-publication.test.ts`
- Test: `tests/worker/cover-render-workflow.test.ts`
- Test: `tests/worker/event-cover-view.test.ts`
- Create or modify: `tests/worker/migration-0022.test.ts`
- Modify: `scripts/verify-fresh-d1.ts` and `tests/unit/verify-fresh-d1.test.ts` only if the migration inventory requires it
- Test: `tests/worker/helpers.ts`
- Test: `tests/ui/event-theme-rendering.test.tsx`
- Test: `tests/ui/responsive-event-cover.test.tsx`
- Test: `tests/ui/event-appearance-editor.test.tsx` or `tests/ui/cover-studio-session.test.tsx` only where an existing assertion needs the current asset version
- Test: `tests/e2e/event-cover-studio.spec.ts`

**Interfaces:**

- Produces: `EventCoverPresetAssetVersion = 1 | 2`, `EventCoverTonalEffectVersion = 1 | 2`, `CURRENT_EVENT_COVER_PRESET_ASSET_VERSION = 2`, and surface treatment union `'none' | 'film-grain-v1' | 'film-grain-v2'`.
- Produces: `canonicalCoverRenderRecipe(config, tonalEffectVersion)` whose v2 JSON is byte-stable and shaped as `{"version":2,"config":<canonical StoredEventCoverConfigV1 object>,"tonalEffectVersion":2}`.
- Produces: `parseCoverRenderRecipe(value)` returning `{ config, tonalEffectVersion }`; a legacy bare stored config returns version 1, and malformed/enriched inputs return `null`.
- Produces: `coverSurfaceTreatment(config, tonalEffectVersion?)`; preset Film derives v1/v2 from `assetVersion`, upload Film derives from the explicit tonal version and defaults to v1 for legacy callers, and every non-Film effect returns `none`.
- Produces: `applyCoverTonalEffect(transformer, effect, tonalEffectVersion)` in `worker/storage/event-cover-effects.ts`, returning an `ImageTransformer` with the exact versioned transform and Warm v2 draw operation applied.
- Produces: forward-only trigger definitions that accept preset `assetVersion` 1 or 2 and reject every other value while preserving all source/pointer invariants from migration 0014.
- Consumes: Cloudflare Images `ImageTransformer.draw(imageStream, { opacity, repeat, composite })`; the overlay bytes are a checked source constant and not a network fetch.
- Consumes: current v2 constants in new UI intent; authoritative event responses continue to consume the server-resolved `surfaceTreatment` field.

- [ ] **Step 1: Add RED domain/version tests**

  Extend `tests/unit/event-cover.test.ts` so it requires preset asset versions 1 and 2, rejects every other asset version, proves the exact v2 render-recipe serialization, accepts legacy bare recipes as tonal v1, rejects unknown envelope keys/versions, and proves these treatment resolutions:

  ```ts
  coverSurfaceTreatment(v1PresetFilm) === 'film-grain-v1'
  coverSurfaceTreatment(v2PresetFilm) === 'film-grain-v2'
  coverSurfaceTreatment(uploadFilm) === 'film-grain-v1'
  coverSurfaceTreatment(uploadFilm, 2) === 'film-grain-v2'
  coverSurfaceTreatment(uploadNatural, 2) === 'none'
  ```

  Update `tests/unit/cover-presets.test.ts` and `tests/unit/cover-contrast.test.ts` to require current asset version 2, manifest tonal version 2, `film-grain-v2`, v2 grain opacity `0.10`, historical v1 opacity `0.18`, and continued existence of the v1 manifest/tile. Assert the exact five Canvas filter strings and the Warm wash `{ color: '#e7b78d', opacity: 0.05, composite: 'source-over' }`.

- [ ] **Step 2: Run the focused unit RED check**

  Run:

  ```bash
  npx vitest run --config vitest.config.ts tests/unit/event-cover.test.ts tests/unit/cover-presets.test.ts tests/unit/cover-contrast.test.ts
  ```

  Expected: FAIL because v2 versions, treatment, serialization, recipes, and assets do not exist yet.

- [ ] **Step 3: Implement strict domain and render-recipe versioning**

  In `shared/event-cover.ts`, keep stored config `version: 1`, widen only preset `assetVersion` to `1 | 2`, move `COVER_PIPELINE_VERSIONS.previewRecipe`, `.tonalEffect`, `.imagesParameterRecipe`, and `.presetAsset` to 2, and add the render-recipe parser/serializer described under Interfaces. The v2 serializer must canonicalize the nested config using the existing canonical serializer before wrapping it. The parser must be strict for both the envelope and nested config. Update `coverSurfaceTreatment` without changing non-Film behavior.

- [ ] **Step 4: Add RED Worker renderer tests**

  Expand the recording Images fake with a `draws` array on each recorded output call. Each draw row records the overlay stream and options without decoding or logging bytes. In `tests/worker/event-cover-images.test.ts`, assert the exact v2 transform objects for all five effects and assert Warm v2 alone performs exactly one draw with:

  ```ts
  { opacity: 0.05, repeat: true, composite: 'over' }
  ```

  Also assert a direct tonal-v1 profile render retains the existing v1 Warm transform and performs no draw, and update preview object-key expectations from recipe suffix `-1.webp` to `-2.webp`.

- [ ] **Step 5: Run the focused Worker renderer RED check**

  Run:

  ```bash
  npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-images.test.ts
  ```

  Expected: FAIL on the calibrated recipes, draw recording, and recipe-versioned key.

- [ ] **Step 6: Implement the versioned Cloudflare Images renderer**

  Put v1 and v2 allowlisted transform tables and `applyCoverTonalEffect` in `worker/storage/event-cover-effects.ts`. Embed a valid one-pixel opaque PNG whose decoded color is exactly `#e7b78d`; Warm v2 applies it through `draw()` after its tonal transform. Make `renderCoverProfileObject` require `tonalEffectVersion`. Previews always use the current tonal version and current preview key. Do not bake Film grain into any preview or profile bytes.

- [ ] **Step 7: Add RED publication/workflow/view compatibility tests**

  Add focused cases proving that a newly queued upload render set stores the strict v2 envelope, the render workflow reads the envelope and passes tonal version 2, a legacy bare upload recipe still passes tonal version 1, and final event `cover_config_json` remains the public v1 config. Add view cases showing an active legacy upload Film resolves `film-grain-v1`, an active v2-envelope upload Film resolves `film-grain-v2`, a pinned preset asset v1 Film resolves v1, and a pinned preset asset v2 Film resolves v2. Update new-preset publication expectations to asset version 2 without rewriting fixtures that intentionally represent old publications.

  Add a migration RED case proving a fresh database and an upgraded database accept both preset asset versions 1 and 2, reject version 3, and preserve all non-preset source/pointer guards.

- [ ] **Step 8: Run the focused publication RED check**

  Run:

  ```bash
  npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-publication.test.ts tests/worker/cover-render-workflow.test.ts tests/worker/event-cover-view.test.ts
  ```

  Expected: FAIL because publication still writes bare recipes/current preset v1 and the workflow/view do not read recipe versions.

- [ ] **Step 9: Persist and consume the v2 upload recipe**

  Queue new upload render sets with `canonicalCoverRenderRecipe(publishedConfig(request), COVER_PIPELINE_VERSIONS.tonalEffect)`. At every workflow read, use `parseCoverRenderRecipe`, pass its `tonalEffectVersion` into profile rendering, and serialize only `recipe.config` into the final event row. Backfill continues to write its legacy bare Natural config and explicitly renders with the dependency-pinned current tonal version. In `event-cover-view.ts`, select the active set's `recipe_json`, parse it, and use its tonal version solely to resolve the upload surface treatment; reject malformed active recipes through the existing invariant path.

  Add migration 0022 without changing migration 0014. Drop and recreate only the event-cover insert/update invariant triggers, keeping their existing predicates byte-for-byte except that preset `assetVersion` must be in the closed set `(1, 2)` rather than equal to 1.

- [ ] **Step 10: Add RED UI parity tests**

  Require `ResponsiveEventCover` to expose separate `responsive-cover--film-grain-v1` and `responsive-cover--film-grain-v2` classes. Require a Film style card to wrap its real thumbnail with the v2 treatment layer. Require an uploaded Film draft in `EventAppearanceCanvas` to apply the v2 class exactly once while Natural applies none. Require current preset thumbnails and current preset canvas intent to resolve `/assets/event-covers/v2/`, while an authoritative v1 event remains on `/v1/`.

- [ ] **Step 11: Run the focused UI RED check**

  Run:

  ```bash
  npx vitest run --config vitest.config.ts tests/ui/responsive-event-cover.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/event-appearance-editor.test.tsx tests/ui/cover-studio-session.test.tsx
  ```

  Expected: FAIL because picker/draft grain is absent and current UI still hardcodes asset v1.

- [ ] **Step 12: Implement v2 picker, canvas, and hero parity**

  Use `CURRENT_EVENT_COVER_PRESET_ASSET_VERSION` for newly selected preset paths and intent. Carry the selected effect into the local draft canvas. Give Film thumbnails a positioned treatment wrapper and Film drafts the same v2 runtime layer. Preserve native radios, decorative empty-alt thumbnails, focus behavior, and existing card dimensions. Use these exact CSS rules semantically:

  ```css
  .responsive-cover--film-grain-v1 .responsive-cover__treatment { background-image: url('/assets/event-covers/v1/film-grain-v1.png'); opacity: .18; }
  .responsive-cover--film-grain-v2 .responsive-cover__treatment { background-image: url('/assets/event-covers/v2/film-grain-v2.png'); opacity: .10; }
  ```

  Both repeat the tile. The picker wrapper is `position: relative; overflow: hidden`; its image remains the same square object-fit preview and its treatment is pointer-inert.

- [ ] **Step 13: Calibrate and generate immutable preset asset v2**

  Change the generator to asset version 2 and manifest tonal version 2. Use these exact Canvas filters:

  ```ts
  natural: 'none'
  warm: 'saturate(1.04) contrast(0.99)'
  film: 'contrast(0.95) saturate(0.8)'
  soft: 'saturate(0.96) contrast(0.92)'
  monochrome: 'grayscale(1) contrast(1.02)'
  ```

  After drawing the Warm filtered base, reset the filter, set `globalCompositeOperation = 'source-over'`, set `globalAlpha = 0.05`, fill the whole output with `#e7b78d`, then reset alpha/composite state before sampling or encoding. Name the generated tile `film-grain-v2.png`. Run:

  ```bash
  npm run build:cover-presets
  npm run verify:cover-presets
  ```

  Expected: 720 v2 files plus the v2 manifest/tile verify successfully, and `public/assets/event-covers/v1/` remains present and unmodified.

- [ ] **Step 14: Extend the focused real-browser Cover Studio assertion**

  In `tests/e2e/event-cover-studio.spec.ts`, use the existing upload fixture/route harness and assert that choosing Film after a real uploaded preview is ready gives both the Film thumbnail and the large local draft canvas the v2 grain class, with only one treatment element in each surface. Do not add generated benchmark photos or output evidence to tracked fixtures.

- [ ] **Step 15: Run GREEN checks once, proportionally**

  Run each named union once on the final tree:

  ```bash
  npx vitest run --config vitest.config.ts tests/unit/event-cover.test.ts tests/unit/cover-presets.test.ts tests/unit/cover-contrast.test.ts tests/ui/responsive-event-cover.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/event-appearance-editor.test.tsx tests/ui/cover-studio-session.test.tsx
  npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-images.test.ts tests/worker/event-cover-publication.test.ts tests/worker/cover-render-workflow.test.ts tests/worker/event-cover-view.test.ts
  npx vitest run --config vitest.worker.config.ts tests/worker/migration-0022.test.ts
  npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
  npx playwright test tests/e2e/event-cover-studio.spec.ts
  npm run typecheck
  npm run typecheck:e2e
  npm run verify:cover-presets
  ```

  Expected: all named checks pass. Record commands, counts, and any environmental limitation in the report. Do not substitute repository-wide `npm test`, `npm run lint`, or CI.

- [ ] **Step 16: Self-review and hand back an uncommitted worktree**

  Inspect `git diff --check`, `git status --short`, and the complete diff from base `c260d2ec758ef5fba34c0c29eff48e2d1b4af2ff`. Confirm no v1 asset path appears as modified or deleted, no generated spike/evidence files are tracked, and no secret or environment file was added. Write the implementer report; do not stage or commit.
