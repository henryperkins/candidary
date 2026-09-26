/* global console, process */
/**
 * Builds the reviewed `mobile-image-load` report from pinned harness observations
 * and the independent deployment instrumentation document.
 *
 * `bundle` joins the three harness outputs under the candidate decoder identity.
 * `build` writes the bundle, instrumentation and report as `<sha256>.json` evidence
 * files, then runs the same verifyLoadArtifacts/assessLoadEvidence checks the
 * release verifier uses. Evidence is written even when a go/no-go target fails, so
 * throughput, cost and refusals are retained; the exit status reports the gate.
 * It reads local files only and never contacts a network.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_METRICS, SCENARIOS, assessLoadEvidence, declaredOperations, verifyLoadArtifacts } from './mobile-image-load-harness.mjs';

/** The exact bytes that are hashed and published; the release verifier hashes file bytes. */
export const serialize = value => JSON.stringify(value, null, 2) + '\n';
export const sha256Hex = value => createHash('sha256').update(value).digest('hex');

const fingerprintPattern = /^[a-f0-9]{64}$/u;
const imageRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$/u;
const TOOL_FILES = ['mobile-image-load-harness.mjs', 'mobile-image-load-adapter.mjs', 'mobile-image-load-instrumentation.mjs', 'mobile-image-load-report.mjs'];

class ReportError extends Error {
  constructor(reason) { super(`Load report refused: ${reason}.`); this.name = 'ReportError'; }
}
const refuse = reason => { throw new ReportError(reason); };
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

function validateIdentity(identity) {
  if (!fingerprintPattern.test(identity?.buildFingerprint ?? '') || !imageRefPattern.test(identity?.imageRef ?? '')) {
    refuse('identity needs the candidate build fingerprint and an immutable registry digest reference');
  }
  return { buildFingerprint: identity.buildFingerprint, imageRef: identity.imageRef };
}
function validateObservation(observed, name) {
  const start = Date.parse(observed?.window?.startedAt), end = Date.parse(observed?.window?.endedAt);
  if (observed?.kind !== 'mobile-image-load-observations' || observed.harnessVersion !== 1 || observed.plan?.scenario !== name
    || observed.plan.live !== true || !Number.isFinite(start) || !Number.isFinite(end) || end < start
    || !['uploads', 'previews', 'controls', 'probes'].every(group => Array.isArray(observed[group])) || !plainObject(observed.concurrency)) {
    refuse(`${name} observations must be one live harness run`);
  }
  return observed;
}

/** One live harness output per scenario, bound to the candidate decoder identity. */
export function bundleObservations(identity, observations) {
  const bound = validateIdentity(identity);
  if (!Array.isArray(observations) || observations.length !== SCENARIOS.length) refuse('exactly one cold, warm and mixed run is required');
  const scenarios = SCENARIOS.map(name => {
    const matches = observations.filter(item => item?.plan?.scenario === name);
    if (matches.length !== 1) refuse('exactly one cold, warm and mixed run is required');
    return validateObservation(matches[0], name);
  });
  return { kind: 'mobile-image-load-observations-bundle', harnessVersion: 1, ...bound, scenarios };
}

/** Returns the bundle's observations keyed by scenario name. */
export function validateBundle(bundle) {
  if (bundle?.kind !== 'mobile-image-load-observations-bundle' || bundle.harnessVersion !== 1 || !Array.isArray(bundle.scenarios)
    || bundle.scenarios.length !== SCENARIOS.length) refuse('invalid observations bundle');
  validateIdentity(bundle);
  return Object.fromEntries(SCENARIOS.map((name, index) => [name, validateObservation(bundle.scenarios[index], name)]));
}

export function buildLoadReport({ bundle, instrumentation, versions }) {
  const observations = validateBundle(bundle);
  if (instrumentation?.kind !== 'mobile-image-load-instrumentation' || instrumentation.harnessVersion !== 1
    || instrumentation.source !== 'deployment-instrumentation' || instrumentation.buildFingerprint !== bundle.buildFingerprint
    || instrumentation.imageRef !== bundle.imageRef || !Array.isArray(instrumentation.scenarios)) refuse('instrumentation does not match the bundle identity');
  if (!['harness', 'worker', 'decoder'].every(key => typeof versions?.[key] === 'string' && versionPattern.test(versions[key]))) {
    refuse('harness, main Worker and decoder versions are required');
  }
  const scenarios = SCENARIOS.map(name => {
    const observed = observations[name], instrumented = instrumentation.scenarios.find(item => item?.name === name);
    if (!plainObject(instrumented?.metrics) || instrumented.window?.startedAt !== observed.window.startedAt
      || instrumented.window?.endedAt !== observed.window.endedAt) refuse(`${name} instrumentation is missing or covers another window`);
    const metrics = Object.fromEntries(REQUIRED_METRICS.map(key => [key, instrumented.metrics[key]]));
    if (Object.values(metrics).some(value => !Number.isFinite(value) || value < 0)) refuse(`${name} instrumentation is incomplete`);
    const plan = observed.plan, declared = declaredOperations(plan);
    // Complete means every declared logical operation has an observation row; outcomes are judged separately.
    const complete = observed.uploads.length === declared.uploads && observed.previews.length === declared.previews
      && observed.controls.length === declared.controls && observed.probes.length === declared.probes;
    return { name, guests: plan.guests, originals: plan.originals, pageTiles: plan.pageTiles, visitsPerGuest: plan.visitsPerGuest,
      uploadConcurrency: plan.uploadConcurrency, previewConcurrency: plan.previewConcurrency, eventShards: plan.eventShards, pools: plan.pools,
      complete, window: observed.window, concurrency: observed.concurrency, costUsd: instrumented.cost?.totalUsd ?? null, metrics };
  });
  return { kind: 'mobile-image-load', harnessVersion: 1, source: 'live-rehearsal', buildFingerprint: bundle.buildFingerprint, imageRef: bundle.imageRef,
    observationsSha256: sha256Hex(serialize(bundle)), instrumentationSha256: sha256Hex(serialize(instrumentation)),
    versions: { harness: versions.harness, worker: versions.worker, decoder: versions.decoder }, scenarios };
}

/** Pins the exact rehearsal tooling that produced and evaluated the evidence. */
export async function toolDigest(directory = dirname(fileURLToPath(import.meta.url))) {
  const hash = createHash('sha256');
  for (const name of TOOL_FILES) {
    const bytes = await readFile(join(directory, name));
    hash.update(`${name}\0${bytes.length}\0`); hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), command = args[0];
  const flags = ['--identity', '--out', '--observations', '--instrumentation', '--versions', '--evidence-root'];
  const value = flag => { const index = args.indexOf(flag); if (index < 1 || !args[index + 1]) refuse(`missing ${flag}`); return resolve(args[index + 1]); };
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  try {
    if (command === 'bundle') {
      const inputs = args.slice(1).filter((item, index, list) => !flags.includes(item) && !flags.includes(list[index - 1]));
      const bundle = bundleObservations(await json(value('--identity')), await Promise.all(inputs.map(path => json(resolve(path)))));
      await writeFile(value('--out'), serialize(bundle), { flag: 'wx' });
      console.log(JSON.stringify({ bundle: value('--out'), sha256: sha256Hex(serialize(bundle)) }, null, 2));
    } else if (command === 'build') {
      const bundle = await json(value('--observations')), instrumentation = await json(value('--instrumentation'));
      const supplied = await json(value('--versions'));
      const report = buildLoadReport({ bundle, instrumentation, versions: { harness: await toolDigest(), worker: supplied?.worker, decoder: supplied?.decoder } });
      if (!verifyLoadArtifacts(report, bundle, instrumentation)) refuse('observations and instrumentation do not reproduce the report');
      const assessment = assessLoadEvidence(report, bundle);
      const root = value('--evidence-root');
      await mkdir(root, { recursive: true });
      const shas = {};
      for (const [key, document] of [['observationsSha256', bundle], ['instrumentationSha256', instrumentation], ['reportSha256', report]]) {
        const text = serialize(document); shas[key] = sha256Hex(text);
        await writeFile(join(root, `${shas[key]}.json`), text);
      }
      console.log(JSON.stringify({ ...shas, artifactsVerified: true, pass: assessment.pass, issues: assessment.issues,
        costPer10000Originals: Object.fromEntries(report.scenarios.map(item => [item.name, item.metrics.costPer10000Originals])),
        throughputPerSecond: Object.fromEntries(report.scenarios.map(item => [item.name, item.metrics.throughputPerSecond])) }, null, 2));
      process.exitCode = assessment.pass ? 0 : 1;
    } else refuse('usage: bundle | build');
  } catch (error) {
    console.error(error instanceof ReportError ? error.message : 'Load report failed. No load evidence produced.');
    process.exitCode = 1;
  }
}
