# Repository guide for coding agents

## Getting started

- Run `./scripts/setup-codex.sh` from the repository root in a fresh checkout. It
  installs the locked dependencies, creates local-only development secrets, and
  applies every D1 migration to Wrangler's local database.
- The supported runtime is Node.js 22 or newer with npm 11 or newer. Do not use
  another package manager or regenerate `package-lock.json` unnecessarily.
- Use Bash syntax in automation. Documentation may also show PowerShell for
  Windows contributors.

## Verification

- During development, run the narrowest relevant Vitest or Playwright test.
- Before finishing a normal code change, run `npm run check`. It covers the app,
  Worker, scripts, end-to-end TypeScript project, lint, and unit/Worker tests.
- Run `npm run build` when changing production code or build configuration.
- Run `npm run test:e2e` for user journeys or visible UI changes. Playwright
  browsers are not installed by the setup script; install Chromium explicitly
  with `npx playwright install chromium` when the task needs it.
- `npm run verify:bindings` is required after changing `wrangler.jsonc` bindings.
  Regenerate deliberate binding changes with `npm run cf-typegen`.

## Safety and architecture

- Never run deploy, remote migration, release, backfill execution, or confirmed
  load-test commands unless the task explicitly asks for that operation. Local
  D1 commands must retain `--local`.
- Never commit `.dev.vars`, `.wrangler/`, generated evidence, or credentials.
- Read `CLAUDE.md` before changing authorization, RSVP, uploads, event covers,
  exports, cleanup, migrations, or release tooling. Its invariants apply to all
  agents despite the filename.
- Schema changes are append-only: add a numbered file under `migrations/`; do
  not edit a migration that may already have been applied.
- Keep shared wire contracts and limits in `shared/`. Both the React app and the
  Worker import this directory by relative path; the repository has no aliases.
- Preserve the existing API response shape and use `ApiError` codes defined in
  `shared/errors.ts`.

## Working tree hygiene

- Treat unrelated dirty files as user work: do not modify, stage, or discard
  them. Review `git status --short` and `git diff --check` before committing.
- Generated cover presets comprise hundreds of files. Only regenerate them when
  the task explicitly changes that pipeline.
