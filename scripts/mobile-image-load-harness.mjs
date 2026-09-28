/* global URL, console, performance, process, setTimeout */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MiB = 1024 ** 2;
export const DENIAL_BODY_MAX_BYTES = 64 * 1024;
/** Mirrors shared/constants.ts MAX_EVENT_MEDIA/MAX_EVENT_BYTES; a unit test pins the pair. */
export const EVENT_CAPACITY = { media: 10_000, bytes: 100 * 1024 ** 3 };
/** Mirrors shared/origins.ts PREVIEW_APPLICATION_ROOT_ORIGIN. */
export const PREVIEW_ROOT_HOST = 'candidary-preview.lfd.workers.dev';
export const SCENARIOS = ['cold', 'warm', 'mixed'];
const PROBE_KINDS = ['privacy', 'deletion', 'cancellation', 'regeneration-seed', 'multipart-retry'];
export const WORKLOAD_PROFILES = ['capacity-v1', 'operational-v1'];
// Controls/probes are bounded by 20 MiB direct files; keep 10% of every event free for them.
const CAPACITY_HEADROOM = 0.9;

/** Uploads are assigned in whole 25/50/75 MiB triples so every event receives the same byte mix. */
export function minimumEventShards(plan) {
  const triple = plan.sourceSizes.reduce((sum, size) => sum + size, 0);
  const bytes = Math.ceil(plan.originals / plan.sourceSizes.length) * triple;
  return Math.max(Math.ceil(bytes / (EVENT_CAPACITY.bytes * CAPACITY_HEADROOM)),
    Math.ceil(plan.originals / (EVENT_CAPACITY.media * CAPACITY_HEADROOM)), 1);
}
export function buildLoadPlan(options = {}) {
  const scenario = options.scenario ?? 'mixed';
  const workloadProfile = options.workloadProfile ?? 'capacity-v1';
  if (!SCENARIOS.includes(scenario) || !WORKLOAD_PROFILES.includes(workloadProfile)) throw new Error('Unknown workload profile or scenario.');
  if (workloadProfile === 'operational-v1') {
    const sourceSizes = [25 * MiB, 50 * MiB, 75 * MiB];
    const controls = { directBaseline: 10, directDuringLoad: 10, privacy: 4, deletion: 2, cancellation: 2,
      regenerationSeeds: scenario === 'mixed' ? 2 : 0, retryChecks: scenario === 'warm' ? 0 : 1 };
    // Media payload only. Three possible sends for each multipart part, plus one deliberate
    // repeated accepted part. JSON/headers, polls and internal R2/decoder traffic are excluded.
    const originalsUpper = 8 * sourceSizes.reduce((sum, bucket) => sum + bucket * 1.5, 0);
    const uploadBytes = (scenario === 'warm' ? 0 : originalsUpper * 3 + (sourceSizes[0] * 1.5 * 3 + 8 * MiB))
      + (controls.directBaseline + controls.directDuringLoad + controls.deletion + controls.regenerationSeeds) * 20 * MiB
      + controls.cancellation * 8 * MiB * 3;
    const downloadBytes = 4 * 12 * 2 * 20 * MiB
      + (scenario === 'warm' ? 0 : originalsUpper + sourceSizes[0] * 1.5)
      + (controls.privacy + controls.deletion * 2 + controls.cancellation) * DENIAL_BODY_MAX_BYTES;
    return { scenario, workloadProfile, live: false, guests: 4, originals: 24, pageTiles: 12, visitsPerGuest: 2,
      sourceSizes, uploadConcurrency: 4, previewConcurrency: 8, uploadIntervalMs: 100, previewIntervalMs: 50,
      controls, controlConcurrency: 1, controlIntervalMs: 250, pools: { upload: 2, preview: 2 },
      qualification: 'missing', eventShards: 1, payloadBounds: { uploadBytes, downloadBytes } };
  }
  const plan = { scenario, workloadProfile, live: false, guests: 500, originals: 10_000,
    pageTiles: 48, visitsPerGuest: 2, sourceSizes: [25 * MiB, 50 * MiB, 75 * MiB],
    uploadConcurrency: 4, previewConcurrency: 8, uploadIntervalMs: 100, previewIntervalMs: 50,
    // Direct-path negative controls, product-flow probes and mixed-only regeneration seeds.
    controls: { directBaseline: 100, directDuringLoad: 100, privacy: 50, deletion: 10, cancellation: 10,
      regenerationSeeds: scenario === 'mixed' ? 20 : 0 },
    controlConcurrency: 1, controlIntervalMs: 250,
    pools: { upload: 2, preview: 2 }, qualification: 'missing' };
  return { ...plan, eventShards: minimumEventShards(plan) };
}
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
/** Historical capacity artifacts omitted workloadProfile; operational artifacts must pin every plan field. */
export function canonicalLoadPlan(plan) {
  if (!plan || !WORKLOAD_PROFILES.includes(plan.workloadProfile ?? 'capacity-v1')) return false;
  const canonical = buildLoadPlan({ scenario: plan.scenario, workloadProfile: plan.workloadProfile });
  canonical.live = true;
  if (plan.workloadProfile === undefined) delete canonical.workloadProfile;
  return stable(plan) === stable(canonical);
}
// Mirrors the fixed preview scope in mobile-image-load-instrumentation.mjs. Duplication fails
// closed if that deployment scope changes without a corresponding release-verifier review.
const OPERATIONAL_SCOPE_BASE = {
  kind: 'candidary.image-load-scope', environment: 'preview', workloadProfile: 'operational-v1',
  imageDataset: 'candidary_image_metrics_preview', decoderDataset: 'candidary_image_decoder_preview',
  mainScript: 'candidary-preview', buckets: ['candidary-preview-media', 'candidary-preview-media-canonical'],
  containers: { instanceType: 'standard-2', pools: { upload: 2, preview: 2 }, sleepAfterSeconds: 600 },
};
function validOperationalScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  const { eventIds, ...base } = scope;
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/u.test(value);
  return stable(base) === stable(OPERATIONAL_SCOPE_BASE) && eventIds && typeof eventIds === 'object' && !Array.isArray(eventIds)
    && stable(Object.keys(eventIds).sort()) === stable([...SCENARIOS].sort())
    && SCENARIOS.every(name => Array.isArray(eventIds[name]) && eventIds[name].length === (name === 'mixed' ? 2 : 1)
      && eventIds[name].every(id) && new Set(eventIds[name]).size === eventIds[name].length);
}
/** The exact logical-operation total an authorization must approve for one scenario run. */
export function declaredOperations(plan) {
  const c = plan.controls;
  const uploads = plan.scenario === 'warm' ? 0 : plan.originals;
  const previews = plan.guests * plan.pageTiles * plan.visitsPerGuest;
  const controls = c.directBaseline + c.directDuringLoad;
  const probes = c.privacy + c.deletion + c.cancellation + c.regenerationSeeds + (c.retryChecks ?? 0);
  return { uploads, previews, controls, probes, total: uploads + previews + controls + probes };
}
export function guestsInShard(plan, shard) {
  return Math.floor((plan.guests - 1 - shard) / plan.eventShards) + 1;
}
export function uploadAssignment(plan, index) {
  const width = plan.sourceSizes.length;
  const triple = Math.floor(index / width);
  const shard = triple % plan.eventShards;
  const local = Math.floor(triple / plan.eventShards) % guestsInShard(plan, shard);
  return { shard, guestIndex: shard + local * plan.eventShards, byteSize: plan.sourceSizes[index % width] };
}
export function previewAssignment(plan, index) {
  const perGuest = plan.pageTiles * plan.visitsPerGuest;
  const guestIndex = Math.floor(index / perGuest);
  return { guestIndex, shard: guestIndex % plan.eventShards, localGuest: Math.floor(guestIndex / plan.eventShards),
    visit: Math.floor(index / plan.pageTiles) % plan.visitsPerGuest, tile: index % plan.pageTiles };
}

const eventIdPattern = /^[a-zA-Z0-9_-]{8,128}$/u;
function defaultIgnored(path) {
  try { execFileSync('git', ['check-ignore', '-q', path], { cwd: dirname(path), stdio: 'ignore' }); return true; }
  catch { return false; }
}
function privatePath(value, context) {
  if (typeof value !== 'string' || !isAbsolute(value)) return false;
  let real;
  try { real = realpathSync(value); if (!statSync(real).isFile()) return false; } catch { return false; }
  const part = relative(realpathSync(context.repoRoot), real);
  const inside = part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  return !inside || (context.isIgnored ?? defaultIgnored)(real);
}
/** A separately issued, expiring authorization for one scenario on the idle preview deployment. */
export function authorizeLoad(options, authorization, env = process.env, context = {}) {
  if (!options.live) return false;
  const now = context.now ?? Date.now();
  const repoRoot = context.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = buildLoadPlan({ scenario: options.scenario ?? authorization?.scenario, workloadProfile: options.workloadProfile });
  const operational = plan.workloadProfile === 'operational-v1';
  let url;
  try { url = new URL(authorization?.target ?? 'https://invalid'); } catch { url = new URL('https://invalid'); }
  const expires = Date.parse(authorization?.expiresAt);
  const idle = authorization?.previewEnvironmentIdle;
  const idleStart = Date.parse(idle?.windowStart), idleEnd = Date.parse(idle?.windowEnd);
  const ids = value => Array.isArray(value) && value.every(id => eventIdPattern.test(id ?? '')) && new Set(value).size === value.length;
  const events = authorization?.eventIds, uploads = authorization?.uploadEventIds ?? [];
  const all = [...(Array.isArray(events) ? events : []), ...(Array.isArray(uploads) ? uploads : []), authorization?.isolationEventId];
  if (env.CANDIDARY_IMAGE_LOAD_CONFIRM !== 'I_UNDERSTAND' || authorization?.kind !== 'candidary.image-load-authorization'
    || authorization.environment !== 'preview' || authorization.dedicatedRehearsalEvent !== true
    || !SCENARIOS.includes(plan.scenario) || authorization.scenario !== plan.scenario
    || typeof authorization.authorizedBy !== 'string' || !authorization.authorizedBy.trim()
    || !ids(events) || (operational ? events.length !== 1 : events.length < plan.eventShards) || !ids(uploads)
    || (plan.scenario === 'mixed' ? (operational ? uploads.length !== 1 : uploads.length < plan.eventShards) : uploads.length !== 0)
    || !eventIdPattern.test(authorization.isolationEventId ?? '') || new Set(all).size !== all.length
    || !Number.isFinite(expires) || expires <= now || expires - now > 72 * 3600_000
    || idle?.idle !== true || !Number.isFinite(idleStart) || !Number.isFinite(idleEnd) || idleStart > now || idleEnd < expires
    || url.protocol !== 'https:' || url.port || url.username || url.password
    || !(url.hostname === PREVIEW_ROOT_HOST || url.hostname.endsWith(`-${PREVIEW_ROOT_HOST}`))
    || url.pathname !== '/' || url.search || url.hash
    || !privatePath(authorization.credentialsPath, { ...context, repoRoot }) || !privatePath(authorization.sourcesPath, { ...context, repoRoot })
    || (operational ? authorization.workloadProfile !== 'operational-v1'
      || authorization.approvedUploadBytes !== plan.payloadBounds.uploadBytes
      || authorization.approvedDownloadBytes !== plan.payloadBounds.downloadBytes
      : authorization.workloadProfile !== undefined && authorization.workloadProfile !== 'capacity-v1')
    || authorization.approvedRequests !== declaredOperations(plan).total) {
    throw new Error('A current, explicit preview rehearsal authorization is required.');
  }
  return true;
}

function laneTracker(configured) {
  let active = 0, maxActive = 0, since = performance.now(), integral = 0;
  const started = since;
  const move = delta => { const at = performance.now(); integral += active * (at - since); since = at; active += delta; maxActive = Math.max(maxActive, active); };
  return { enter: () => move(1), leave: () => move(-1),
    summary: () => { move(0); const span = since - started; return { configured, maxActive, meanActive: span > 0 ? integral / span : 0 }; } };
}
async function paced(count, concurrency, interval, run, lane) {
  let index = 0;
  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (index < count) {
      const current = index++;
      const start = Math.max(Date.now(), next); next = start + interval;
      if (start > Date.now()) await new Promise(resolve => setTimeout(resolve, start - Date.now()));
      const begin = performance.now();
      lane.enter();
      try { const result = await run(current); results.push({ ...result, index: current, elapsedMs: performance.now() - begin }); }
      catch { results.push({ index: current, ok: false, elapsedMs: performance.now() - begin }); }
      finally { lane.leave(); }
    }
  }));
  return results.sort((a, b) => a.index - b.index);
}

const fields = {
  uploads: ['verificationMs', 'sourceBytes', 'receiptVerified', 'hashVerified', 'incorrectReceipt', 'hashMismatch'],
  previews: ['previewHit', 'previewPrivate'],
  controls: ['phase'],
  probes: ['kind', 'violation', 'retryVerified', 'receiptVerified', 'hashVerified'],
};
/** Allowlisted primitives only: no credential, filename, identifier, body or exception text leaves the adapter. */
function sanitize(group, values) {
  return values.map(value => {
    const row = { index: value.index, elapsedMs: value.elapsedMs, ok: value.ok === true };
    for (const key of fields[group]) {
      const item = value[key];
      if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) row[key] = item;
      else if (key === 'phase' && (item === 'baseline' || item === 'during')) row[key] = item;
      else if (key === 'kind' && PROBE_KINDS.includes(item)) row[key] = item;
    }
    return row;
  });
}

/** A rehearsal adapter supplies actual files/credentials; deployment metrics are exported separately.
 * No credential, guest filename or exception is logged. These observations never certify on their own. */
export async function runScenario(plan, adapter, authorization) {
  if (!SCENARIOS.includes(plan.scenario)) throw new Error('Unknown scenario.');
  const startedAt = new Date().toISOString();
  const lanes = { upload: laneTracker(plan.uploadConcurrency), preview: laneTracker(plan.previewConcurrency),
    control: laneTracker(plan.controlConcurrency), probe: laneTracker(plan.controlConcurrency) };
  try {
    await adapter.prepare({ plan, authorization });
    const c = plan.controls;
    const control = phase => adapter.control ? paced(phase === 'baseline' ? c.directBaseline : c.directDuringLoad, plan.controlConcurrency,
      plan.controlIntervalMs, index => adapter.control({ index, phase, pool: 'direct' })
        .then(result => ({ ...result, phase }), () => ({ ok: false, phase })), lanes.control) : [];
    const probeList = [...Array(c.privacy).fill('privacy'), ...Array(c.deletion).fill('deletion'), ...Array(c.cancellation).fill('cancellation'),
      ...Array(c.retryChecks ?? 0).fill('multipart-retry')];
    const probe = (kinds, offset = 0) => adapter.probe ? paced(kinds.length, plan.controlConcurrency, plan.controlIntervalMs,
      // A failed control/probe keeps its declared kind so accounting cannot silently drop it.
      index => adapter.probe({ index: index + offset, kind: kinds[index] })
        .then(result => ({ ...result, kind: kinds[index] }), () => ({ ok: false, kind: kinds[index] })), lanes.probe)
      .then(rows => rows.map(row => ({ ...row, index: row.index + offset }))) : [];
    const upload = () => paced(plan.originals, plan.uploadConcurrency, plan.uploadIntervalMs, index => adapter.upload({
      index, ...uploadAssignment(plan, index), pool: 'upload',
    }), lanes.upload);
    const preview = () => paced(plan.guests * plan.pageTiles * plan.visitsPerGuest, plan.previewConcurrency, plan.previewIntervalMs, index => adapter.preview({
      index, ...previewAssignment(plan, index), pool: 'preview',
    }), lanes.preview);
    // Baseline direct-upload samples and seeds precede load; the second sample set runs during it.
    const baseline = await control('baseline');
    const seeds = await probe(Array(c.regenerationSeeds).fill('regeneration-seed'), probeList.length);
    let uploads = [], previews = [];
    const load = plan.scenario === 'mixed' ? Promise.all([upload(), preview()])
      : plan.scenario === 'cold' ? upload().then(async rows => [rows, await preview()]) : preview().then(rows => [[], rows]);
    const [loaded, during, probes] = await Promise.all([load, control('during'), probe(probeList)]);
    [uploads, previews] = loaded;
    return { kind: 'mobile-image-load-observations', harnessVersion: 1, complete: false, qualification: 'missing',
      plan, window: { startedAt, endedAt: new Date().toISOString() },
      concurrency: Object.fromEntries(Object.entries(lanes).map(([name, lane]) => [name, lane.summary()])),
      uploads: sanitize('uploads', uploads), previews: sanitize('previews', previews),
      controls: sanitize('controls', [...baseline, ...during.map(row => ({ ...row, index: row.index + baseline.length }))]),
      probes: sanitize('probes', [...probes, ...seeds]).sort((a, b) => a.index - b.index) };
  } finally { await adapter.close(); }
}

export const REQUIRED_METRICS = ['originalBytesFetched','nativeDecodes','nativeSeconds','peakRssBytes','peakScratchBytes','p50Ms','p95Ms','p99Ms',
  'previewHits','previewMisses','busyRate','throughputPerSecond','costPer10000Originals','unrecoveredTransientErrorRate',
  'warmPreviewP95Ms','verificationP95Ms','directP95Degradation','incorrectReceipts','originalHashFailures','privacyFailures',
  'uploadPoolPreviewJobs','previewPoolUploadJobs','uploadRequests','deliveredOriginals','verifiedOriginalHashes','previewRequests',
  'successfulPreviewRequests','privacyChecks','deletionChecks','directControlRequests','busyFailoverChecks','cancellationChecks',
  // Non-busy preview-pool jobs: regeneration that upload retries cannot imitate.
  'regenerationDecodes'];
export const OPERATIONAL_METRICS = [...REQUIRED_METRICS.filter(key => key !== 'costPer10000Originals'), 'retryChecks'];

export function assessLoadEvidence(report, identity) {
  const issues = [];
  const workloadProfile = report?.workloadProfile ?? 'capacity-v1';
  const operational = workloadProfile === 'operational-v1';
  if (report?.kind !== 'mobile-image-load' || report.harnessVersion !== 1 || report.source !== 'live-rehearsal'
    || report.buildFingerprint !== identity.buildFingerprint || report.imageRef !== identity.imageRef
    || !/^[a-f0-9]{64}$/u.test(report.observationsSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(report.instrumentationSha256 ?? '')
    || !report.versions?.harness || !report.versions?.worker || !report.versions?.decoder
    || !WORKLOAD_PROFILES.includes(workloadProfile) || (operational && report.capacityQualified !== false)) issues.push('Missing independent load identity/instrumentation.');
  for (const name of SCENARIOS) {
    const scenario = report?.scenarios?.find(item => item.name === name);
    const m = scenario?.metrics;
    const expected = buildLoadPlan({ scenario: name, workloadProfile: operational ? 'operational-v1' : 'capacity-v1' });
    const metricKeys = operational ? OPERATIONAL_METRICS : REQUIRED_METRICS;
    if (!scenario || (scenario.workloadProfile ?? 'capacity-v1') !== workloadProfile
      || scenario.guests !== expected.guests || scenario.originals !== expected.originals || scenario.pageTiles !== expected.pageTiles
      || scenario.visitsPerGuest !== expected.visitsPerGuest || scenario.uploadConcurrency !== expected.uploadConcurrency
      || scenario.previewConcurrency !== expected.previewConcurrency || scenario.complete !== true
      || (operational && (scenario.eventShards !== 1 || stable(scenario.payloadBounds) !== stable(expected.payloadBounds)
        || scenario.declaredOperations !== declaredOperations(expected).total))
      || !m || !metricKeys.every(key => Number.isFinite(m[key]) && m[key] >= 0)
      || (operational && m.costPer10000Originals != null)) {
      issues.push(`${name}: missing complete workload/measurements.`); continue;
    }
    const previewRequests = expected.guests * expected.pageTiles * expected.visitsPerGuest;
    const expectedUploads = name === 'warm' ? 0 : expected.originals;
    if (m.uploadRequests !== expectedUploads || m.deliveredOriginals > expectedUploads || m.deliveredOriginals < expectedUploads * (operational ? 1 : .99)
      || m.verifiedOriginalHashes !== m.deliveredOriginals || m.previewRequests !== previewRequests
      || m.successfulPreviewRequests < previewRequests * (operational ? 1 : .99) || m.successfulPreviewRequests > previewRequests
      || (operational ? m.previewHits + m.previewMisses < previewRequests : m.previewHits + m.previewMisses !== previewRequests)
      || m.privacyChecks < expected.controls.privacy || m.deletionChecks < expected.controls.deletion
      || m.directControlRequests < expected.controls.directBaseline || m.cancellationChecks < expected.controls.cancellation
      || (operational && (m.retryChecks !== expected.controls.retryChecks || m.unrecoveredTransientErrorRate !== 0
        || (name !== 'warm' && scenario.concurrency?.upload?.maxActive < 2)))
      || m.p50Ms <= 0 || m.p95Ms < m.p50Ms || m.p99Ms < m.p95Ms || m.throughputPerSecond <= 0
      // Decoding scenarios must show measured peak memory and exercised busy failover. A warm
      // window has no decoder work to measure; its zero-activity rule is a go/no-go target below.
      || (name !== 'warm' && (m.peakRssBytes <= 0 || (!operational && m.busyFailoverChecks < 1)
        || m.nativeDecodes < m.deliveredOriginals || m.nativeSeconds <= 0 || m.verificationP95Ms <= 0
        || m.originalBytesFetched < m.deliveredOriginals * 25 * MiB))
      || (name === 'mixed' && (m.previewMisses < 1 || m.nativeDecodes <= m.deliveredOriginals || m.regenerationDecodes < 1))
      || (name === 'warm' && (m.previewMisses !== 0 || m.warmPreviewP95Ms <= 0))) issues.push(`${name}: measurements do not account for the declared workload.`);
    if (m.incorrectReceipts || m.originalHashFailures || m.privacyFailures || m.uploadPoolPreviewJobs || m.previewPoolUploadJobs
      || m.unrecoveredTransientErrorRate >= .01 || m.warmPreviewP95Ms > 2000 || m.verificationP95Ms > 120000
      || m.peakRssBytes > 3 * 1024 ** 3 || m.peakScratchBytes > 2 * 1024 ** 3 || (!operational && m.directP95Degradation > .10)
      // Warm persisted previews: zero original reads and zero decoder activity of any kind (a busy
      // refusal is still a decode request, and any RSS/scratch/native time means one ran).
      || (name === 'warm' && (m.originalBytesFetched || m.nativeDecodes || m.nativeSeconds || m.peakRssBytes || m.peakScratchBytes
        || m.busyFailoverChecks || m.busyRate || m.regenerationDecodes))) issues.push(`${name}: go/no-go target failed.`);
  }
  return { pass: issues.length === 0, issues };
}

/** Nearest-rank percentile over a copy; never mutates observation rows. */
export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : 0;
}
/** Metrics derived only from harness observations. The instrumentation exporter
 * and verifyLoadArtifacts both use this, so reported values can be recomputed. */
export function observationMetrics(observed) {
  const ok = rows => rows.filter(row => row.ok);
  const delivered = ok(observed.uploads), previews = ok(observed.previews);
  const controls = phase => ok(observed.controls.filter(row => row.phase === phase)).map(row => row.elapsedMs);
  const probes = kind => observed.probes.filter(row => row.kind === kind);
  const baseline = percentile(controls('baseline'), .95), during = percentile(controls('during'), .95);
  const latency = [...delivered, ...previews].map(row => row.elapsedMs);
  const operations = observed.uploads.length + observed.previews.length + observed.controls.length + observed.probes.length;
  const violations = observed.probes.filter(row => row.violation === true).length;
  const failures = operations - delivered.length - previews.length - ok(observed.controls).length - ok(observed.probes).length - violations;
  const span = (Date.parse(observed.window?.endedAt) - Date.parse(observed.window?.startedAt)) / 1000;
  return {
    uploadRequests: observed.uploads.length, deliveredOriginals: delivered.length,
    verifiedOriginalHashes: delivered.filter(row => row.hashVerified === true).length,
    previewRequests: observed.previews.length, successfulPreviewRequests: previews.length,
    p50Ms: percentile(latency, .5), p95Ms: percentile(latency, .95), p99Ms: percentile(latency, .99),
    warmPreviewP95Ms: percentile(previews.filter(row => row.previewHit === true).map(row => row.elapsedMs), .95),
    verificationP95Ms: percentile(delivered.map(row => row.verificationMs), .95),
    directControlRequests: Math.min(controls('baseline').length, controls('during').length),
    directP95Degradation: baseline > 0 && during > 0 ? Math.max(0, (during - baseline) / baseline) : 0,
    incorrectReceipts: observed.uploads.filter(row => row.incorrectReceipt === true).length
      + probes('cancellation').filter(row => row.violation === true).length,
    originalHashFailures: observed.uploads.filter(row => row.hashMismatch === true).length,
    privacyFailures: observed.previews.filter(row => row.previewHit === true && row.previewPrivate !== true).length
      + probes('privacy').filter(row => row.violation === true).length + probes('deletion').filter(row => row.violation === true).length,
    privacyChecks: ok(probes('privacy')).length, deletionChecks: ok(probes('deletion')).length, cancellationChecks: ok(probes('cancellation')).length,
    ...(observed.plan.workloadProfile === 'operational-v1' ? { retryChecks: probes('multipart-retry')
      .filter(row => row.ok && row.retryVerified === true && row.receiptVerified === true && row.hashVerified === true).length } : {}),
    unrecoveredTransientErrorRate: operations ? Math.max(0, failures) / operations : 1,
    throughputPerSecond: span > 0 ? (delivered.length + previews.length) / span : 0,
  };
}

/** Bind the reviewed metrics to actual harness observations and separately
 * exported deployment counters; a document saying complete is insufficient. */
export function verifyLoadArtifacts(report, observations, instrumentation) {
  const identity = artifact => artifact?.harnessVersion === 1 && artifact.buildFingerprint === report.buildFingerprint && artifact.imageRef === report.imageRef;
  const reportProfile = report?.workloadProfile ?? 'capacity-v1';
  const embeddedScopePresent = instrumentation && Object.hasOwn(instrumentation, 'scope');
  const embeddedScope = instrumentation?.scope;
  const embeddedProfile = embeddedScope?.workloadProfile ?? 'capacity-v1';
  if (observations?.kind !== 'mobile-image-load-observations-bundle' || instrumentation?.kind !== 'mobile-image-load-instrumentation'
    || instrumentation.source !== 'deployment-instrumentation' || !identity(observations) || !identity(instrumentation)
    || !Array.isArray(report?.scenarios) || !Array.isArray(observations.scenarios) || !Array.isArray(instrumentation.scenarios)
    || [report.scenarios, observations.scenarios, instrumentation.scenarios].some(rows => rows.length !== SCENARIOS.length)
    || SCENARIOS.some(name => report.scenarios.filter(row => row.name === name).length !== 1
      || observations.scenarios.filter(row => row.plan?.scenario === name).length !== 1
      || instrumentation.scenarios.filter(row => row.name === name).length !== 1)
    || (embeddedScopePresent && (!embeddedScope || typeof embeddedScope !== 'object' || Array.isArray(embeddedScope)
      || !WORKLOAD_PROFILES.includes(embeddedProfile) || embeddedProfile !== reportProfile))
    || (report.workloadProfile === 'operational-v1' && !validOperationalScope(instrumentation.scope))) return false;
  return report.scenarios.every(scenario => {
    const observed = observations.scenarios?.find(item => item.plan?.scenario === scenario.name);
    const instrumented = instrumentation.scenarios?.find(item => item.name === scenario.name);
    const m = scenario.metrics;
    if (observed?.kind !== 'mobile-image-load-observations' || observed.harnessVersion !== 1 || !canonicalLoadPlan(observed.plan)
      || (observed.plan.workloadProfile ?? 'capacity-v1') !== (report.workloadProfile ?? 'capacity-v1')
      || (observations.workloadProfile ?? 'capacity-v1') !== (report.workloadProfile ?? 'capacity-v1')
      || (instrumentation.workloadProfile ?? 'capacity-v1') !== (report.workloadProfile ?? 'capacity-v1')
      || (report.workloadProfile === 'operational-v1' && instrumented?.metrics?.costPer10000Originals != null)
      || observed.plan.guests !== scenario.guests || observed.plan.originals !== scenario.originals || observed.plan.pageTiles !== scenario.pageTiles
      || observed.plan.visitsPerGuest !== scenario.visitsPerGuest || observed.plan.uploadConcurrency !== scenario.uploadConcurrency
      || observed.plan.previewConcurrency !== scenario.previewConcurrency || !instrumented?.metrics
      || instrumented.window?.startedAt !== observed.window?.startedAt || instrumented.window?.endedAt !== observed.window?.endedAt
      || Object.keys(m).some(key => instrumented.metrics[key] !== m[key])) return false;
    const declared = declaredOperations(observed.plan);
    const c = observed.plan.controls;
    for (const [rows, expected] of [[observed.uploads, m.uploadRequests], [observed.previews, m.previewRequests],
      [observed.controls, declared.controls], [observed.probes, declared.probes]]) {
      if (!Array.isArray(rows) || rows.length !== expected || new Set(rows.map(row => row.index)).size !== expected
        || rows.some(row => !Number.isInteger(row.index) || row.index < 0 || row.index >= expected || !Number.isFinite(row.elapsedMs) || row.elapsedMs <= 0)) return false;
    }
    if (observed.controls.filter(row => row.phase === 'baseline').length !== c.directBaseline
      || PROBE_KINDS.some(kind => observed.probes.filter(row => row.kind === kind).length
        !== { privacy: c.privacy, deletion: c.deletion, cancellation: c.cancellation, 'regeneration-seed': c.regenerationSeeds,
          'multipart-retry': c.retryChecks ?? 0 }[kind])) return false;
    const delivered = observed.uploads.filter(item => item.ok);
    const previews = observed.previews.filter(item => item.ok);
    if (delivered.length !== m.deliveredOriginals || previews.length !== m.successfulPreviewRequests
      || delivered.some(item => item.hashVerified !== true || item.receiptVerified !== true)
      || previews.some(item => item.previewPrivate !== true)) return false;
    if (scenario.name === 'warm' && percentile(previews.map(item => item.elapsedMs), .95) !== m.warmPreviewP95Ms) return false;
    if (delivered.length && (delivered.some(item => !Number.isFinite(item.verificationMs) || item.verificationMs <= 0)
      || percentile(delivered.map(item => item.verificationMs), .95) !== m.verificationP95Ms)) return false;
    const derived = observationMetrics(observed);
    return Object.entries(derived).every(([key, value]) => m[key] === value);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  try {
    const plan = buildLoadPlan({ scenario: args.includes('--scenario') ? value('--scenario') : 'mixed',
      workloadProfile: args.includes('--profile') ? value('--profile') : undefined });
    if (!SCENARIOS.includes(plan.scenario)) throw new Error('Unknown scenario.');
    if (!args.includes('--live')) console.log(JSON.stringify({ ...plan, declaredOperations: declaredOperations(plan) }, null, 2));
    else {
      if (!['--authorization', '--adapter', '--report'].every(flag => args.includes(flag))) throw new Error('Live mode requires authorization, reviewed adapter and report paths.');
      const authorization = JSON.parse(await readFile(resolve(value('--authorization')), 'utf8'));
      authorizeLoad({ live: true, scenario: plan.scenario, workloadProfile: plan.workloadProfile }, authorization);
      const module = await import(pathToFileURL(resolve(value('--adapter'))).href);
      const adapter = typeof module.createLoadAdapter === 'function' ? module.createLoadAdapter() : module;
      plan.live = true;
      const report = await runScenario(plan, adapter, authorization);
      await writeFile(resolve(value('--report')), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ complete: false, qualification: 'missing', report: value('--report') }));
    }
  } catch { console.error('Load harness refused or failed. No qualification evidence produced.'); process.exitCode = 1; }
}
