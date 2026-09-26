/* global AbortSignal, console, process */
/**
 * Deployment instrumentation for the mobile-image rehearsal (preview only).
 *
 * `export` reads the two private Analytics Engine datasets and two documented
 * GraphQL datasets for each scenario window. It is a dry run that prints the
 * exact queries unless `--live-export` is given; only then are CLOUDFLARE_ACCOUNT_ID
 * and CLOUDFLARE_API_TOKEN read from the environment. Neither value is logged,
 * written or embedded in an error. `build` is offline: it validates a recorded
 * export against the pinned observations bundle, computes every metric that
 * assessLoadEvidence requires, and prices measured usage with the documented
 * list prices below. Invalid, sampled, incomplete or mismatched exports throw.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_METRICS, SCENARIOS, buildLoadPlan, observationMetrics } from './mobile-image-load-harness.mjs';
import { serialize, sha256Hex, validateBundle } from './mobile-image-load-report.mjs';

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

/**
 * Workers Paid marginal list prices, retrieved 2026-09-25 from the cited pages.
 * Included monthly usage and free tiers are deliberately not subtracted, and
 * billable-unit rounding is not applied, so each figure is the marginal cost of
 * the measured usage alone.
 */
export const PRICING = deepFreeze({
  retrievedAt: '2026-09-25',
  currency: 'USD',
  basis: 'Workers Paid marginal list prices; monthly included usage, free tiers and billable-unit rounding are not applied.',
  workersRequestsPerMillion: 0.30,
  workersCpuMsPerMillion: 0.02,
  r2ClassAPerMillion: 4.50,
  r2ClassBPerMillion: 0.36,
  r2StorageGbMonth: 0.015,
  containerMemoryGiBSecond: 0.0000025,
  containerVcpuSecond: 0.000020,
  containerDiskGbSecond: 0.00000007,
  durableObjectRequestsPerMillion: 0.15,
  durableObjectGbSecondsPerMillion: 12.50,
  /** Duration is billed for 128 MB regardless of use; the pricing example computes 128 MB / 1 GB. */
  durableObjectBilledGb: 0.128,
  /** Listed price; the pricing page states Analytics Engine is not billed yet. */
  analyticsEnginePointsPerMillion: 0.25,
  imagesTransformationsPerThousand: 0.50,
  instanceTypes: {
    lite: { vcpu: 1 / 16, memoryGiB: 0.25, diskGB: 2 },
    basic: { vcpu: 0.25, memoryGiB: 1, diskGB: 4 },
    'standard-1': { vcpu: 0.5, memoryGiB: 4, diskGB: 8 },
    'standard-2': { vcpu: 1, memoryGiB: 6, diskGB: 12 },
    'standard-3': { vcpu: 2, memoryGiB: 8, diskGB: 16 },
    'standard-4': { vcpu: 4, memoryGiB: 12, diskGB: 20 },
  },
  r2ClassA: ['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
    'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption',
    'PutBucketCors', 'PutBucketLifecycleConfiguration'],
  r2ClassB: ['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
    'GetBucketLifecycleConfiguration'],
  r2Free: ['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload'],
  sources: {
    workers: 'https://developers.cloudflare.com/workers/platform/pricing/',
    serviceBindings: 'https://developers.cloudflare.com/workers/platform/pricing/#service-bindings',
    r2: 'https://developers.cloudflare.com/r2/pricing/',
    containers: 'https://developers.cloudflare.com/containers/platform/pricing/',
    durableObjects: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
    analyticsEngine: 'https://developers.cloudflare.com/analytics/analytics-engine/pricing/',
    images: 'https://developers.cloudflare.com/images/pricing/',
    analyticsEngineSql: 'https://developers.cloudflare.com/analytics/analytics-engine/sql-api/',
    analyticsEngineSampling: 'https://developers.cloudflare.com/analytics/analytics-engine/sampling/',
    workersGraphql: 'https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/',
    r2Graphql: 'https://developers.cloudflare.com/r2/platform/metrics-analytics/',
    d1Graphql: 'https://developers.cloudflare.com/d1/observability/metrics-analytics/',
  },
});

/** Mirrors the preview Wrangler definitions; a unit test pins every value to the configuration files. */
export const PREVIEW_SCOPE = deepFreeze({
  kind: 'candidary.image-load-scope',
  environment: 'preview',
  imageDataset: 'candidary_image_metrics_preview',
  decoderDataset: 'candidary_image_decoder_preview',
  mainScript: 'candidary-preview',
  buckets: ['candidary-preview-media', 'candidary-preview-media-canonical'],
  containers: { instanceType: 'standard-2', pools: { upload: 2, preview: 2 }, sleepAfterSeconds: 600 },
});

const SQL_URL = accountId => `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const eventIdPattern = /^[a-zA-Z0-9_-]{8,128}$/u;
const ORIGINAL_LABELS = ['native-decode', 'original-download', 'export', 'images-transform'];
const HIT_LABELS = ['persisted-hit', 'legacy-hit'];
const MISS_LABELS = ['legacy-images', 'miss-regeneration', 'unavailable'];
const PREVIEW_LABELS = [...HIT_LABELS, ...MISS_LABELS, 'denied'];
const POOL_LANES = ['upload/upload', 'preview/preview', 'upload/preview', 'preview/upload'];
const OUTCOMES = ['ok', 'unsupported', 'malformed', 'resource_limit', 'busy', 'unavailable'];
const IMAGE_KEYS = ['kind', 'label', 'points', 'bytes', 'maxSampleInterval'];
const DECODER_KEYS = ['poolLane', 'path', 'outcome', 'jobs', 'nativeMs', 'peakRssBytes', 'peakScratchBytes', 'sourceBytes', 'maxSampleInterval'];
const EXPORT_SETTLE_MS = 5 * 60_000;
const EXPORT_HORIZON_MS = 30 * 24 * 3600_000;
const MAX_WINDOW_MS = 72 * 3600_000;

/** Fixed, message-safe failures: nothing request-, response- or credential-derived is interpolated. */
class InstrumentationError extends Error {
  constructor(reason) { super(`Deployment instrumentation refused: ${reason}.`); this.name = 'InstrumentationError'; }
}
const refuse = reason => { throw new InstrumentationError(reason); };

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validateScope(scope) {
  const { eventIds, ...constant } = plainObject(scope) ? scope : {};
  if (!plainObject(scope) || stable(constant) !== stable(PREVIEW_SCOPE) || !exactKeys(eventIds, SCENARIOS)
    || SCENARIOS.some(name => !Array.isArray(eventIds[name]) || !eventIds[name].length || eventIds[name].length > 64
      || new Set(eventIds[name]).size !== eventIds[name].length || eventIds[name].some(id => typeof id !== 'string' || !eventIdPattern.test(id)))) {
    refuse('scope must be the preview rehearsal scope with valid event identifiers');
  }
  return scope;
}

/** The event IDs the adapter actually uses: the first eventShards gallery IDs, plus upload IDs for mixed. */
export function scopeFromAuthorizations(authorizations) {
  const eventIds = {};
  for (const name of SCENARIOS) {
    const authorization = authorizations?.[name], plan = buildLoadPlan({ scenario: name });
    if (authorization?.kind !== 'candidary.image-load-authorization' || authorization.scenario !== name
      || !Array.isArray(authorization.eventIds) || authorization.eventIds.length < plan.eventShards
      || (name === 'mixed' && (!Array.isArray(authorization.uploadEventIds) || authorization.uploadEventIds.length < plan.eventShards))) {
      refuse('each scenario needs its own rehearsal authorization');
    }
    eventIds[name] = [...authorization.eventIds.slice(0, plan.eventShards), ...(name === 'mixed' ? authorization.uploadEventIds.slice(0, plan.eventShards) : [])];
  }
  return validateScope({ ...JSON.parse(JSON.stringify(PREVIEW_SCOPE)), eventIds });
}

/** Whole-second bounds: start floored, end exclusive after the second containing endedAt. */
function bounds(window) {
  const start = Date.parse(window?.startedAt), end = Date.parse(window?.endedAt);
  if (!exactKeys(window, ['startedAt', 'endedAt']) || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > MAX_WINDOW_MS) {
    refuse('invalid scenario window');
  }
  const low = Math.floor(start / 1000) * 1000, high = Math.floor(end / 1000) * 1000 + 1000;
  const sql = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const iso = ms => `${new Date(ms).toISOString().slice(0, 19)}Z`;
  return { startSql: sql(low), endSql: sql(high), startIso: iso(low), endIso: iso(high) };
}

/** Sampling-weighted Analytics Engine SQL. Identifiers are validated constants; values are validated patterns. */
export function analyticsEngineQueries({ scope, name, window }) {
  validateScope(scope);
  if (!SCENARIOS.includes(name)) refuse('unknown scenario');
  const b = bounds(window);
  const time = `timestamp >= toDateTime('${b.startSql}') AND timestamp < toDateTime('${b.endSql}')`;
  const events = scope.eventIds[name].map(id => `index1 = '${id}'`).join(' OR ');
  return {
    image: ['SELECT blob2 AS kind, blob3 AS label, SUM(_sample_interval * double2) AS points, SUM(_sample_interval * double1) AS bytes,',
      '  MAX(_sample_interval) AS maxSampleInterval',
      `FROM ${scope.imageDataset}`,
      `WHERE ${time} AND blob1 = '${scope.environment}' AND (${events})`,
      'GROUP BY kind, label ORDER BY kind, label FORMAT JSON'].join('\n'),
    decoder: ['SELECT blob2 AS poolLane, blob3 AS path, blob4 AS outcome, SUM(_sample_interval * double5) AS jobs,',
      '  SUM(_sample_interval * double1) AS nativeMs, MAX(double2) AS peakRssBytes, MAX(double3) AS peakScratchBytes,',
      '  SUM(_sample_interval * double4) AS sourceBytes, MAX(_sample_interval) AS maxSampleInterval',
      `FROM ${scope.decoderDataset}`,
      `WHERE ${time} AND index1 = '${scope.environment}' AND blob1 = '${scope.environment}'`,
      'GROUP BY poolLane, path, outcome ORDER BY poolLane, path, outcome FORMAT JSON'].join('\n'),
  };
}

/** Documented GraphQL fields only: Workers request/error sums and R2 operation counts by action type. */
export function graphqlQuery({ scope, window }) {
  validateScope(scope);
  const b = bounds(window);
  return {
    query: ['query CandidaryImageLoadUsage($accountTag: string!, $start: Time!, $end: Time!, $mainScript: string!, $legacyBucket: string!, $canonicalBucket: string!) {',
      '  viewer {',
      '    accounts(filter: { accountTag: $accountTag }) {',
      '      main: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $mainScript, datetime_geq: $start, datetime_leq: $end }) { sum { requests errors } }',
      '      legacy: r2OperationsAdaptiveGroups(limit: 10000, filter: { bucketName: $legacyBucket, datetime_geq: $start, datetime_leq: $end }) { sum { requests } dimensions { actionType } }',
      '      canonical: r2OperationsAdaptiveGroups(limit: 10000, filter: { bucketName: $canonicalBucket, datetime_geq: $start, datetime_leq: $end }) { sum { requests } dimensions { actionType } }',
      '    }',
      '  }',
      '}'].join('\n'),
    variables: { start: b.startIso, end: b.endIso, mainScript: scope.mainScript, legacyBucket: scope.buckets[0], canonicalBucket: scope.buckets[1] },
  };
}

async function boundedJson(response) {
  const text = await response.text().catch(() => refuse('unreadable response'));
  if (text.length > 16 * 1024 ** 2) refuse('oversized response');
  try { return JSON.parse(text); } catch { return refuse('invalid response JSON'); }
}

/** Network happens only here, only with explicit credentials, and only for the given windows. */
export async function exportDeploymentMetrics({ scope, windows, fetch = globalThis.fetch, env = process.env, now = Date.now, timeoutMs = 60_000 }) {
  validateScope(scope);
  const accountId = env?.CLOUDFLARE_ACCOUNT_ID, token = env?.CLOUDFLARE_API_TOKEN;
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/u.test(accountId) || typeof token !== 'string' || !/^[\x21-\x7e]{1,512}$/u.test(token)) {
    refuse('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for a live export');
  }
  const names = SCENARIOS.filter(name => windows?.[name]);
  if (!plainObject(windows) || !names.length || Object.keys(windows).some(name => !SCENARIOS.includes(name))) refuse('no scenario windows');
  const planned = names.map(name => ({ name, window: { startedAt: windows[name].startedAt, endedAt: windows[name].endedAt },
    queries: { ...analyticsEngineQueries({ scope, name, window: windows[name] }), graphql: graphqlQuery({ scope, window: windows[name] }) } }));
  const post = async (url, init) => {
    let response;
    try { response = await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { return refuse('network failure'); }
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); refuse('Cloudflare API returned a non-200 status'); }
    return boundedJson(response);
  };
  const sql = async query => {
    const value = await post(SQL_URL(accountId), { headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: query });
    if (!plainObject(value) || !Array.isArray(value.data) || !Number.isInteger(value.rows)) refuse('invalid Analytics Engine response');
    return { meta: Array.isArray(value.meta) ? value.meta : [], data: value.data, rows: value.rows };
  };
  const scenarios = [];
  for (const item of planned) {
    const imageMetrics = await sql(item.queries.image);
    const decoderMetrics = await sql(item.queries.decoder);
    const response = await post(GRAPHQL_URL, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: item.queries.graphql.query, variables: { ...item.queries.graphql.variables, accountTag: accountId } }) });
    if (!plainObject(response) || (response.errors != null && !(Array.isArray(response.errors) && !response.errors.length))) refuse('GraphQL returned errors');
    // Only the aliased usage arrays are retained: no account tag, token or request metadata.
    const account = response.data?.viewer?.accounts?.[0];
    const graphql = { data: { viewer: { accounts: Array.isArray(response.data?.viewer?.accounts) && account
      ? [{ main: account.main, legacy: account.legacy, canonical: account.canonical }] : [] } }, errors: null };
    scenarios.push({ ...item, imageMetrics, decoderMetrics, graphql });
  }
  return { kind: 'mobile-image-load-deployment-export', exportedAt: new Date(now()).toISOString(), scope, scenarios };
}

/** Non-negative safe integer from an Analytics Engine/GraphQL number or numeric string. */
function count(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+(\.[0-9]+)?(e\+?[0-9]+)?$/iu.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) refuse('non-integer or negative measurement');
  return number;
}
function resultRows(result, keys, allowEmpty) {
  if (!plainObject(result) || !Array.isArray(result.data) || result.rows !== result.data.length || result.data.length > 256
    || (!allowEmpty && !result.data.length)) refuse('missing or truncated Analytics Engine rows');
  return result.data.map(row => { if (!exactKeys(row, keys)) refuse('unexpected Analytics Engine columns'); return row; });
}
function imageUsage(result) {
  const rows = resultRows(result, IMAGE_KEYS, false), seen = new Set(), usage = {};
  for (const row of rows) {
    const labels = row.kind === 'original-read' ? ORIGINAL_LABELS : row.kind === 'preview-read' ? PREVIEW_LABELS : [];
    const key = `${row.kind}:${row.label}`;
    if (!labels.includes(row.label) || seen.has(key)) refuse('unknown or duplicated image metric label');
    // Unsampled data only: counts, maxima and zero-activity proofs must be exact.
    if (count(row.maxSampleInterval) !== 1) refuse('sampled Analytics Engine data');
    seen.add(key);
    usage[key] = { points: count(row.points), bytes: count(row.bytes) };
  }
  const sum = (kind, labels, field) => labels.reduce((total, label) => total + (usage[`${kind}:${label}`]?.[field] ?? 0), 0);
  return {
    rows: usage,
    originalBytes: sum('original-read', ORIGINAL_LABELS, 'bytes'),
    hits: sum('preview-read', HIT_LABELS, 'points'),
    misses: sum('preview-read', MISS_LABELS, 'points'),
    imagesTransformations: sum('original-read', ['images-transform'], 'points'),
    points: Object.values(usage).reduce((total, item) => total + item.points, 0),
  };
}
function decoderUsage(result) {
  const rows = resultRows(result, DECODER_KEYS, true), seen = new Set();
  const usage = { jobs: 0, busy: 0, regeneration: 0, nativeMs: 0, peakRssBytes: 0, peakScratchBytes: 0, sourceBytes: 0, byPoolLane: {}, pools: { upload: 0, preview: 0 } };
  for (const row of rows) {
    const key = `${row.poolLane}:${row.path}:${row.outcome}`;
    if (!POOL_LANES.includes(row.poolLane) || !['inspect', 'preview'].includes(row.path) || !OUTCOMES.includes(row.outcome) || seen.has(key)) {
      refuse('unknown or duplicated decoder metric group');
    }
    if (count(row.maxSampleInterval) !== 1) refuse('sampled Analytics Engine data');
    seen.add(key);
    const jobs = count(row.jobs);
    if (jobs < 1) refuse('empty decoder metric group');
    usage.jobs += jobs;
    const nativeMs = count(row.nativeMs);
    if (row.outcome === 'busy') usage.busy += jobs;
    // Regeneration proof is a successful preview-pool decode that did native work; failed or
    // unmeasured preview-pool jobs are forwarded work, never a regenerated preview.
    else if (row.poolLane === 'preview/preview' && row.outcome === 'ok' && nativeMs > 0) usage.regeneration += jobs;
    usage.nativeMs += nativeMs;
    usage.sourceBytes += count(row.sourceBytes);
    usage.peakRssBytes = Math.max(usage.peakRssBytes, count(row.peakRssBytes));
    usage.peakScratchBytes = Math.max(usage.peakScratchBytes, count(row.peakScratchBytes));
    usage.byPoolLane[row.poolLane] = (usage.byPoolLane[row.poolLane] ?? 0) + jobs;
    usage.pools[row.poolLane.split('/')[0]] += jobs;
  }
  return usage;
}
function graphqlUsage(graphql) {
  if (!plainObject(graphql) || (graphql.errors != null && !(Array.isArray(graphql.errors) && !graphql.errors.length))) refuse('GraphQL errors');
  const accounts = graphql.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) refuse('missing GraphQL account usage');
  const { main, legacy, canonical } = accounts[0] ?? {};
  // A rehearsal window always invokes the main Worker; an empty aggregate is a failed export, not zero load.
  if (!Array.isArray(main) || main.length !== 1) refuse('missing Workers invocation usage');
  const requests = count(main[0]?.sum?.requests), errors = count(main[0]?.sum?.errors ?? 0);
  if (requests < 1) refuse('missing Workers invocation usage');
  const r2 = { classA: 0, classB: 0, free: 0, unclassified: {} };
  for (const rows of [legacy, canonical]) {
    if (!Array.isArray(rows) || rows.length > 256) refuse('missing R2 operation usage');
    for (const row of rows) {
      const action = row?.dimensions?.actionType, requestsForAction = count(row?.sum?.requests);
      if (typeof action !== 'string' || !/^[A-Za-z]{1,64}$/u.test(action)) refuse('invalid R2 action type');
      if (PRICING.r2ClassA.includes(action)) r2.classA += requestsForAction;
      else if (PRICING.r2ClassB.includes(action)) r2.classB += requestsForAction;
      else if (PRICING.r2Free.includes(action)) r2.free += requestsForAction;
      // Undocumented action types are retained for review and priced as Class A (the higher rate).
      else r2.unclassified[action] = (r2.unclassified[action] ?? 0) + requestsForAction;
    }
  }
  if (r2.classA + r2.classB + r2.free + Object.values(r2.unclassified).reduce((a, b) => a + b, 0) < 1) refuse('missing R2 operation usage');
  return { mainRequests: requests, mainErrors: errors, r2 };
}

const usd = value => Math.round(value * 1e6) / 1e6;
function costFor({ observed, image, decoder, usage, scope, pricing }) {
  const type = pricing.instanceTypes[scope.containers.instanceType];
  const windowSeconds = (Date.parse(observed.window.endedAt) - Date.parse(observed.window.startedAt)) / 1000;
  // Upper bound: every instance of a pool that ran any job is billed for the whole window plus its sleepAfter tail.
  const activeSeconds = Object.fromEntries(Object.entries(scope.containers.pools).map(([pool, instances]) =>
    [pool, decoder.pools[pool] > 0 ? instances * (windowSeconds + scope.containers.sleepAfterSeconds) : 0]));
  const containerSeconds = activeSeconds.upload + activeSeconds.preview;
  const unclassified = Object.values(usage.r2.unclassified).reduce((a, b) => a + b, 0);
  const deliveredBytes = observed.uploads.filter(row => row.ok === true && Number.isSafeInteger(row.sourceBytes) && row.sourceBytes > 0)
    .reduce((total, row) => total + row.sourceBytes, 0);
  const components = [
    { name: 'workers-requests', basis: 'measured', quantity: usage.mainRequests, unit: 'requests', usd: usage.mainRequests / 1e6 * pricing.workersRequestsPerMillion,
      note: 'Main Worker invocations; decoder calls use a service binding and incur no request fee.' },
    { name: 'r2-class-a', basis: 'measured', quantity: usage.r2.classA + unclassified, unit: 'operations',
      usd: (usage.r2.classA + unclassified) / 1e6 * pricing.r2ClassAPerMillion, note: 'Undocumented action types are priced as Class A.' },
    { name: 'r2-class-b', basis: 'measured', quantity: usage.r2.classB, unit: 'operations', usd: usage.r2.classB / 1e6 * pricing.r2ClassBPerMillion },
    { name: 'r2-storage-month', basis: 'derived', quantity: deliveredBytes / 1e9, unit: 'GB-month',
      usd: deliveredBytes / 1e9 * pricing.r2StorageGbMonth, note: 'One month of the delivered original bytes observed by the harness (decimal GB).' },
    { name: 'containers-upper-bound', basis: 'upper-bound', quantity: containerSeconds, unit: 'instance-seconds',
      usd: containerSeconds * (type.memoryGiB * pricing.containerMemoryGiBSecond + type.diskGB * pricing.containerDiskGbSecond + type.vcpu * pricing.containerVcpuSecond),
      note: 'Provisioned memory/disk and full vCPU for every instance of each active pool over the window plus sleepAfter.' },
    { name: 'durable-objects', basis: 'derived', quantity: decoder.jobs * 2, unit: 'requests',
      usd: decoder.jobs * 2 / 1e6 * pricing.durableObjectRequestsPerMillion
        + containerSeconds * pricing.durableObjectBilledGb / 1e6 * pricing.durableObjectGbSecondsPerMillion,
      note: 'Two stub fetches (health and job) per forwarded decoder job; duration bounded by container instance-seconds at 128 MB.' },
    { name: 'analytics-engine-points', basis: 'measured', quantity: image.points + decoder.jobs, unit: 'data points',
      usd: (image.points + decoder.jobs) / 1e6 * pricing.analyticsEnginePointsPerMillion, note: 'Listed price; Analytics Engine is not billed yet.' },
    { name: 'images-transformations', basis: 'upper-bound', quantity: image.imagesTransformations, unit: 'transformations',
      usd: image.imagesTransformations / 1000 * pricing.imagesTransformationsPerThousand, note: 'Every call counted; billing is per unique transformation.' },
  ].map(item => ({ ...item, usd: usd(item.usd) }));
  const excluded = [
    { name: 'workers-cpu-time', reason: 'workersInvocationsAdaptive documents CPU-time quantiles only, not a per-window sum.' },
    { name: 'd1-rows', reason: 'd1AnalyticsAdaptiveGroups is documented with daily date filters only; it cannot be attributed to a scenario window.' },
    { name: 'workflows-storage', reason: 'Not exported; state is small relative to the included 1 GB-month.' },
    { name: 'persisted-preview-storage', reason: 'Preview object bytes are not exported per window.' },
    { name: 'container-egress', reason: 'Decoder containers run with Internet access disabled.' },
    { name: 'included-allowances', reason: 'Monthly included usage is not subtracted.' },
  ];
  const totalUsd = usd(components.reduce((total, item) => total + item.usd, 0));
  return { totalUsd, costPer10000Originals: usd(totalUsd * 10_000 / observed.plan.originals), activeSeconds, components, excluded };
}

/** Offline: validates a recorded export against the pinned observations and computes the instrumentation document. */
export function buildInstrumentation({ bundle, exports, scope, pricing = PRICING }) {
  validateScope(scope);
  if (stable(pricing) !== stable(PRICING)) refuse('pricing must be the reviewed constants');
  const observations = validateBundle(bundle);
  if (!plainObject(exports) || exports.kind !== 'mobile-image-load-deployment-export' || stable(exports.scope) !== stable(scope)
    || !Array.isArray(exports.scenarios) || exports.scenarios.length !== SCENARIOS.length
    || stable(exports.scenarios.map(item => item?.name).sort()) !== stable([...SCENARIOS].sort())) refuse('export must cover every scenario for this scope');
  const exportedAt = Date.parse(exports.exportedAt);
  if (!Number.isFinite(exportedAt)) refuse('invalid export time');
  const scenarios = SCENARIOS.map(name => {
    const observed = observations[name], exported = exports.scenarios.find(item => item.name === name);
    const end = Date.parse(observed.window.endedAt), start = Date.parse(observed.window.startedAt);
    if (stable(exported.window) !== stable(observed.window)) refuse('export window differs from the observed window');
    if (exportedAt < end + EXPORT_SETTLE_MS || exportedAt - start > EXPORT_HORIZON_MS) refuse('export must follow the window by at least five minutes');
    const expected = { ...analyticsEngineQueries({ scope, name, window: observed.window }), graphql: graphqlQuery({ scope, window: observed.window }) };
    if (stable(exported.queries) !== stable(expected)) refuse('export was not produced by the reviewed queries');
    const image = imageUsage(exported.imageMetrics), decoder = decoderUsage(exported.decoderMetrics), usage = graphqlUsage(exported.graphql);
    const cost = costFor({ observed, image, decoder, usage, scope, pricing });
    const measured = {
      ...observationMetrics(observed),
      originalBytesFetched: image.originalBytes,
      previewHits: image.hits,
      previewMisses: image.misses,
      nativeDecodes: decoder.jobs - decoder.busy,
      regenerationDecodes: decoder.regeneration,
      nativeSeconds: decoder.nativeMs / 1000,
      peakRssBytes: decoder.peakRssBytes,
      peakScratchBytes: decoder.peakScratchBytes,
      busyRate: decoder.jobs ? decoder.busy / decoder.jobs : 0,
      busyFailoverChecks: decoder.busy,
      uploadPoolPreviewJobs: decoder.byPoolLane['upload/preview'] ?? 0,
      previewPoolUploadJobs: decoder.byPoolLane['preview/upload'] ?? 0,
      costPer10000Originals: cost.costPer10000Originals,
    };
    const metrics = Object.fromEntries(REQUIRED_METRICS.map(key => [key, measured[key]]));
    if (Object.values(metrics).some(value => !Number.isFinite(value) || value < 0)) refuse('incomplete metric set');
    return { name, window: observed.window, metrics,
      usage: { mainWorker: { requests: usage.mainRequests, errors: usage.mainErrors }, r2: usage.r2, imageReads: image.rows,
        decoder: { jobs: decoder.jobs, busy: decoder.busy, regeneration: decoder.regeneration, nativeMs: decoder.nativeMs, sourceBytes: decoder.sourceBytes, byPoolLane: decoder.byPoolLane },
        containerActiveSecondsUpperBound: cost.activeSeconds },
      cost: { currency: pricing.currency, totalUsd: cost.totalUsd, components: cost.components, excluded: cost.excluded } };
  });
  return { kind: 'mobile-image-load-instrumentation', harnessVersion: 1, source: 'deployment-instrumentation',
    buildFingerprint: bundle.buildFingerprint, imageRef: bundle.imageRef, exportedAt: exports.exportedAt,
    exportSha256: sha256Hex(serialize(exports)), scope,
    pricing: { retrievedAt: pricing.retrievedAt, currency: pricing.currency, basis: pricing.basis, sources: pricing.sources }, scenarios };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), command = args[0];
  const value = flag => { const index = args.indexOf(flag); if (index < 1 || !args[index + 1]) refuse(`missing ${flag}`); return resolve(args[index + 1]); };
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  try {
    if (command === 'scope') {
      const scope = scopeFromAuthorizations({ cold: await json(value('--cold')), warm: await json(value('--warm')), mixed: await json(value('--mixed')) });
      await writeFile(value('--out'), serialize(scope), { flag: 'wx' });
      console.log(JSON.stringify({ scope: value('--out'), eventIds: scope.eventIds }, null, 2));
    } else if (command === 'export') {
      const scope = validateScope(await json(value('--scope')));
      const observations = validateBundle(await json(value('--observations')));
      const windows = Object.fromEntries(SCENARIOS.map(name => [name, observations[name].window]));
      if (!args.includes('--live-export')) {
        console.log(JSON.stringify({ live: false, note: 'Dry run: no network request was made. Re-run with --live-export under a separate authorization.',
          endpoints: { sql: SQL_URL('<CLOUDFLARE_ACCOUNT_ID>'), graphql: GRAPHQL_URL },
          scenarios: SCENARIOS.map(name => ({ name, window: windows[name],
            queries: { ...analyticsEngineQueries({ scope, name, window: windows[name] }), graphql: graphqlQuery({ scope, window: windows[name] }) } })) }, null, 2));
      } else {
        const out = value('--out');
        const exported = await exportDeploymentMetrics({ scope, windows });
        await writeFile(out, serialize(exported), { flag: 'wx' });
        console.log(JSON.stringify({ live: true, export: out, exportedAt: exported.exportedAt, scenarios: SCENARIOS }, null, 2));
      }
    } else if (command === 'build') {
      const instrumentation = buildInstrumentation({ bundle: await json(value('--observations')), exports: await json(value('--export')),
        scope: await json(value('--scope')), pricing: PRICING });
      await writeFile(value('--out'), serialize(instrumentation), { flag: 'wx' });
      console.log(JSON.stringify({ instrumentation: value('--out'), sha256: sha256Hex(serialize(instrumentation)),
        costPer10000Originals: Object.fromEntries(instrumentation.scenarios.map(item => [item.name, item.metrics.costPer10000Originals])) }, null, 2));
    } else refuse('usage: scope | export | build');
  } catch (error) {
    // Only this module's fixed refusal text is shown; anything else is reported generically.
    console.error(error instanceof InstrumentationError ? error.message : 'Deployment instrumentation failed. No instrumentation evidence produced.');
    process.exitCode = 1;
  }
}
