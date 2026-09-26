import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_EVENT_BYTES, MAX_EVENT_MEDIA } from '../../shared/constants';
import { PREVIEW_APPLICATION_ROOT_ORIGIN } from '../../shared/origins';
// @ts-expect-error Node rehearsal script is exercised through its runtime interface.
import { buildLoadPlan, authorizeLoad, assessLoadEvidence, runScenario, declaredOperations, uploadAssignment, previewAssignment, EVENT_CAPACITY, PREVIEW_ROOT_HOST } from '../../scripts/mobile-image-load-harness.mjs';

const MiB = 1024 ** 2;
const privateDir = mkdtempSync(join(tmpdir(), 'candidary-load-auth-'));
const credentialsPath = join(privateDir, 'credentials.json'); writeFileSync(credentialsPath, '{}');
const sourcesPath = join(privateDir, 'sources.json'); writeFileSync(sourcesPath, '{}');
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}_event_${index}`);
function authorization(scenario = 'cold', changes: Record<string, unknown> = {}) {
  const now = Date.now();
  return { kind: 'candidary.image-load-authorization', target: `https://${PREVIEW_ROOT_HOST}/`, environment: 'preview', scenario,
    dedicatedRehearsalEvent: true, authorizedBy: 'Release owner', eventIds: ids('gallery', 6), uploadEventIds: scenario === 'mixed' ? ids('upload', 6) : [],
    isolationEventId: 'isolation_event_0', expiresAt: new Date(now + 3600_000).toISOString(), credentialsPath, sourcesPath,
    previewEnvironmentIdle: { idle: true, windowStart: new Date(now - 60_000).toISOString(), windowEnd: new Date(now + 7200_000).toISOString() },
    approvedRequests: declaredOperations(buildLoadPlan({ scenario })).total, ...changes };
}
const context = { repoRoot: resolve('.'), isIgnored: () => false };
const env = { CANDIDARY_IMAGE_LOAD_CONFIRM: 'I_UNDERSTAND' };

describe('mobile image rehearsal boundaries', () => {
  it('defaults to a paced 500-guest plan and performs no network or publication', () => {
    const plan = JSON.parse(execFileSync(process.execPath, ['scripts/mobile-image-load-harness.mjs'], {encoding:'utf8'}));
    expect(plan).toMatchObject({live:false,guests:500,originals:10000,pageTiles:48,visitsPerGuest:2,pools:{upload:2,preview:2},qualification:'missing'});
    expect(plan.sourceSizes).toEqual([25,50,75].map(size => size * 1024**2));
    expect(plan.uploadConcurrency).toBeLessThan(500);
    expect(plan.declaredOperations).toEqual({ uploads: 10000, previews: 48000, controls: 200, probes: 90, total: 58290 });
  });

  it('declares the exact logical operation totals including controls and probes', () => {
    expect(declaredOperations(buildLoadPlan({ scenario: 'cold' })).total).toBe(58270);
    expect(declaredOperations(buildLoadPlan({ scenario: 'warm' })).total).toBe(48270);
    expect(declaredOperations(buildLoadPlan({ scenario: 'mixed' })).total).toBe(58290);
    expect(buildLoadPlan({ scenario: 'mixed' }).controls).toEqual({ directBaseline: 100, directDuringLoad: 100, privacy: 50, deletion: 10, cancellation: 10, regenerationSeeds: 20 });
  });

  it('shards the unshrunk workload across events inside the product capacity limits', () => {
    expect(EVENT_CAPACITY).toEqual({ media: MAX_EVENT_MEDIA, bytes: MAX_EVENT_BYTES });
    expect(`https://${PREVIEW_ROOT_HOST}`).toBe(PREVIEW_APPLICATION_ROOT_ORIGIN);
    const plan = buildLoadPlan({ scenario: 'cold' });
    expect(plan.eventShards).toBe(6);
    const bytes = new Array(plan.eventShards).fill(0), counts = new Array(plan.eventShards).fill(0), guests = new Set<number>();
    for (let index = 0; index < plan.originals; index++) {
      const assigned = uploadAssignment(plan, index);
      expect(assigned.guestIndex % plan.eventShards).toBe(assigned.shard);
      expect(assigned.guestIndex).toBeLessThan(plan.guests);
      bytes[assigned.shard] += assigned.byteSize; counts[assigned.shard]++; guests.add(assigned.guestIndex);
    }
    expect(guests.size).toBe(500);
    expect(Math.max(...bytes)).toBeLessThanOrEqual(MAX_EVENT_BYTES * 0.9);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_EVENT_MEDIA);
    expect(bytes.reduce((sum, value) => sum + value, 0)).toBe(3334 * 25 * MiB + 3333 * 50 * MiB + 3333 * 75 * MiB);
    const last = previewAssignment(plan, 47999);
    expect(last).toEqual({ guestIndex: 499, shard: 499 % 6, localGuest: Math.floor(499 / 6), visit: 1, tile: 47 });
  });

  it('requires an exact expiring preview authorization with private inputs and an idle-window assertion', () => {
    expect(authorizeLoad({}, authorization(), {}, context)).toBe(false);
    expect(() => authorizeLoad({ live: true, scenario: 'cold' }, authorization(), {}, context)).toThrow();
    for (const scenario of ['cold', 'warm', 'mixed']) expect(authorizeLoad({ live: true, scenario }, authorization(scenario), env, context)).toBe(true);
    const inside = resolve('package.json');
    for (const change of [{ target: 'https://candidary.com/' }, { target: 'https://rehearsal.example.workers.dev/' }, { target: `https://${PREVIEW_ROOT_HOST}/api` },
      { environment: 'production' }, { dedicatedRehearsalEvent: false }, { expiresAt: 'invalid' }, { expiresAt: new Date(Date.now() + 100 * 3600_000).toISOString() },
      { approvedRequests: 58000 }, { approvedRequests: 58271 }, { scenario: 'warm' }, { eventIds: ids('gallery', 5) }, { eventIds: ['short'] },
      { isolationEventId: 'gallery_event_0' }, { uploadEventIds: ids('upload', 6) }, { authorizedBy: ' ' }, { credentialsPath: inside },
      { sourcesPath: 'relative.json' }, { credentialsPath: join(privateDir, 'missing.json') }, { previewEnvironmentIdle: { idle: false } },
      { previewEnvironmentIdle: { idle: true, windowStart: new Date(Date.now() + 60_000).toISOString(), windowEnd: new Date(Date.now() + 7200_000).toISOString() } }]) {
      expect(() => authorizeLoad({ live: true, scenario: 'cold' }, authorization('cold', change), env, context), JSON.stringify(change)).toThrow();
    }
    expect(() => authorizeLoad({ live: true, scenario: 'mixed' }, authorization('mixed', { uploadEventIds: ids('upload', 5) }), env, context)).toThrow();
    expect(authorizeLoad({ live: true, scenario: 'cold' }, authorization('cold', { credentialsPath: inside }), env, { ...context, isIgnored: () => true })).toBe(true);
  });

  it('refuses the committed non-authorizing example', () => {
    const example = JSON.parse(readFileSync('config/mobile-image-load-authorization.example.json', 'utf8'));
    expect(example.kind).not.toBe('candidary.image-load-authorization');
    for (const scenario of ['cold', 'warm', 'mixed']) {
      expect(() => authorizeLoad({ live: true, scenario }, example, env, context)).toThrow();
      expect(() => authorizeLoad({ live: true, scenario }, { ...example, kind: 'candidary.image-load-authorization' }, env, context)).toThrow();
    }
  });

  it('keeps lanes separate, records controls, probes, window and paced concurrency, and never certifies observations', async () => {
    let uploads=0,previews=0,closed=false; const controls:string[]=[]; const probes:string[]=[];
    const plan={...buildLoadPlan({scenario:'mixed'}),guests:2,originals:4,pageTiles:2,uploadIntervalMs:0,previewIntervalMs:0,controlIntervalMs:0,eventShards:1,
      controls:{directBaseline:2,directDuringLoad:2,privacy:1,deletion:1,cancellation:1,regenerationSeeds:1}};
    const report=await runScenario(plan, {
      prepare:async()=>{},close:async()=>{closed=true;},
      upload:async({pool,guestIndex}:{pool:string;guestIndex:number})=>{expect(pool).toBe('upload');expect(guestIndex).toBeLessThan(2);uploads++;return{ok:true,secret:'not logged',hashVerified:true,verificationMs:5,filename:'IMG_1.DNG'};},
      preview:async({pool}:{pool:string})=>{expect(pool).toBe('preview');previews++;return{ok:true,previewHit:true,previewPrivate:true,body:'private bytes'};},
      control:async({phase}:{phase:string})=>{controls.push(phase);return{ok:true,error:'Error: token=abc'};},
      probe:async({kind}:{kind:string})=>{probes.push(kind);return{ok:true,violation:false,kind:'forged'};},
    },{});
    expect({uploads,previews,closed}).toEqual({uploads:4,previews:8,closed:true});
    expect(controls).toEqual(['baseline','baseline','during','during']);
    expect(probes.sort()).toEqual(['cancellation','deletion','privacy','regeneration-seed']);
    expect(report.controls.map((row:{phase:string;index:number}) => [row.phase,row.index])).toEqual([['baseline',0],['baseline',1],['during',2],['during',3]]);
    expect(report.probes.map((row:{index:number}) => row.index)).toEqual([0,1,2,3]);
    expect(report.probes.every((row:{kind:string}) => row.kind!=='forged')).toBe(true);
    expect(Date.parse(report.window.endedAt)).toBeGreaterThanOrEqual(Date.parse(report.window.startedAt));
    expect(report.concurrency.upload.configured).toBe(4); expect(report.concurrency.upload.maxActive).toBeGreaterThanOrEqual(1);
    expect(report.concurrency.upload.maxActive).toBeLessThanOrEqual(4); expect(report.concurrency.preview.maxActive).toBeLessThanOrEqual(8);
    expect(report.complete).toBe(false);
    const text=JSON.stringify(report);
    for (const secret of ['secret','IMG_1','private bytes','token=abc']) expect(text).not.toContain(secret);
    expect(assessLoadEvidence(report,{}).pass).toBe(false);
  });

  it('fails closed without external complete measurements', () => {
    expect(assessLoadEvidence(null,{}).pass).toBe(false);
  });

  it('refuses zero work even when a report labels every scenario complete', () => {
    const metrics=Object.fromEntries(['originalBytesFetched','nativeDecodes','nativeSeconds','peakRssBytes','peakScratchBytes','p50Ms','p95Ms','p99Ms',
      'previewHits','previewMisses','busyRate','throughputPerSecond','costPer10000Originals','unrecoveredTransientErrorRate',
      'warmPreviewP95Ms','verificationP95Ms','directP95Degradation','incorrectReceipts','originalHashFailures','privacyFailures',
      'uploadPoolPreviewJobs','previewPoolUploadJobs'].map(key=>[key,0]));
    const identity={buildFingerprint:'a'.repeat(64),imageRef:`registry.example/image@sha256:${'b'.repeat(64)}`};
    const report={...identity,kind:'mobile-image-load',harnessVersion:1,source:'live-rehearsal',observationsSha256:'d'.repeat(64),instrumentationSha256:'e'.repeat(64),
      versions:{harness:'test',worker:'test',decoder:'test'},scenarios:['cold','warm','mixed'].map(name=>({name,guests:500,originals:10000,pageTiles:48,visitsPerGuest:2,
        uploadConcurrency:4,previewConcurrency:8,complete:true,metrics:{...metrics}}))};
    expect(assessLoadEvidence(report,identity).pass).toBe(false);
  });
});
