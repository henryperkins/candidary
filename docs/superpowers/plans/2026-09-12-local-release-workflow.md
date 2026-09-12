# Local release checks and homepage publication

> For agentic workers: use test-first implementation and one independent task review, following repository AGENTS.md. The release owner runs the six full lanes once on the final commit.

**Goal:** Publish the approved homepage without depending on the permanently unavailable GitHub Actions account.

**Architecture:** A small local command reuses the six existing release lanes. GitHub retains the pull request and review record; Cloudflare's connected main build remains the sole routine production deployment owner. No evidence-manifest system, staging ceremony, protection bypass, or duplicate deployment.

**Tech stack:** Node 24, TypeScript scripts, Vitest, Playwright, Cloudflare Workers Builds.

**Spec:** The user approved local Quality, Unit and UI, Worker, Build, Smoke, and conditional Migration safety checks, an explicit release-workflow update, then merging PR #41 and verifying both production origins. Real test and security failures remain blocking.

## Global constraints

- Preserve unrelated untracked work and the approved homepage. No staging, commits, push, merge, or deploy by the implementer.
- Keep existing branch protections and production/preview isolation unchanged.
- Keep the six checks mandatory in the documented release procedure; never publish fake successful GitHub statuses.
- Build once for local validation; smoke uses that artifact and is skipped if Build fails. No deployment inside the local runner.
- No D1 commands for a release without migration-sensitive changes; reuse the existing conditional detector.
- One final scoped workflow/security follow-up commit; no intermediate task commits. The release owner records full local results against the final SHA.
- Focused implementer RED/GREEN only; reviewer does not repeat successful tests; parent runs the approved six-lane gate.

## Task 1: Replace automatic Actions dependency with local checks

Files: add `scripts/ci-local.ts` and `tests/unit/ci-local.test.ts`; update `package.json`, `package-lock.json`, `tests/unit/release-path.test.ts`, `.github/workflows/ci.yml`, `.github/workflows/full-e2e.yml`, and routine release sections of `docs/deployment.md`.

- [ ] Add `npm run ci:local`, a small cross-platform runner for the existing commands. Resolve and print full base/head SHAs (base defaults to origin/main, head must equal checked-out HEAD); reject tracked dirty changes at start and invalidate results if tracked changes or HEAD change during the run. Require an explicit base if origin/main cannot resolve. Do not install dependencies or deploy in the runner.
- [ ] Run Quality (`npm audit --omit=dev`, `verify:bindings`, `typecheck:e2e`, `lint`); Unit and UI (`test:unit`); Worker (`test:worker`); Build (`build:cloudflare`, `verify:pwa-build`, Wrangler strict dry run against dist/candidary/wrangler.json); Smoke (`test:smoke`) only after Build passes; Migration safety (`ci:migrations` with exact base/head).
- [ ] A failed command fails its lane; continue independent lanes and print all six terminal statuses plus overall exit code. Signals/spawn errors are failures. No retries, suppressions, or weakening audit thresholds. Use existing child-process conventions and avoid a framework.
- [ ] Test real runner orchestration with controlled child-command outcomes: all-pass, failure cannot become success, failed Build skips Smoke, migration receives exact SHAs, invalid/mismatched head and tracked edits rejected. Test behavior, not source text. Focused command: `npx vitest run --config vitest.config.ts tests/unit/ci-local.test.ts tests/unit/release-path.test.ts`.
- [ ] Make GitHub workflows manual-only (remove PR and nightly triggers). Keep optional manual CI usable: branch identity from selected ref, full checkout history and correct migration base/head. No automatic Actions dependency, no mutation of repository settings.
- [ ] Pin only Hono from 4.13.2 to 4.13.5 and regenerate lockfile/install minimally. This is the minimum patched version for the actual production audit blocker, verified in upstream advisory GHSA-g6gw-c38x-mqfc. Do not merge unrelated Dependabot PR #40 or update other direct dependencies. Confirm `npm audit --omit=dev` succeeds.
- [ ] Update deployment docs to show install prerequisites (`npm ci`, Chromium installation as needed), clean committed feature branch, fresh origin/main fetch, local command, six-lane results recorded on PR with exact SHA, then merge and one connected build. Distinguish documented release gates from GitHub's currently absent required-status rules. Manual Actions are optional and unavailable under the permanent billing lock. The full browser matrix remains local/manual, non-blocking. Keep unrelated migration/cutover instructions intact apart from stale hosted-gate wording.
- [ ] Run focused RED/GREEN, scoped lint and diff checks; report findings. Parent obtains one independent review, commits scoped paths, then runs the six full lanes on that commit.

## Release owner: execute after Task 1 review

- [ ] Run the six local lanes on the final SHA; retain complete output and exit code. Stop on real failures and make only scoped necessary corrections.
- [ ] Push the feature branch; record local evidence on PR #41 and merge matching the verified head.
- [ ] Let the connected Cloudflare main trigger build/deploy once. Confirm build result, deployed version tag equals merge SHA, and version receives 100 percent traffic.
- [ ] Verify homepage, demo, images, and entry links on desktop/mobile at candidary.app and candidary.online. No real event creation or guest-data mutation.
- [ ] Fast-forward local main safely and report live URLs, PR, exact SHA and check results.
