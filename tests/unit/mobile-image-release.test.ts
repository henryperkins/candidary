import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Node release script's actual evidence interface is tested here.
import { evidenceReader, verifyRelease } from '../../scripts/verify-mobile-image-release.mjs';
// @ts-expect-error Node rehearsal script's derived-metric interface is tested here.
import { buildLoadPlan, observationMetrics } from '../../scripts/mobile-image-load-harness.mjs';
const fp='a'.repeat(64),imageRef=`registry.example/decoder@sha256:${'b'.repeat(64)}`,manifestSha256='c'.repeat(64);
const profile='mobile-preview-v1';
type MutableWorkloadProfile = 'capacity-v1'|'operational-v1';
// Literal closed baselines: the committed release files may hold preview candidate or qualified records.
const emptyDecoder={protocolVersion:1,previewProfile:profile,releases:[]};
const emptyMobile={kind:'candidary.mobile-image-release',schemaVersion:26,protocolVersion:1,previewProfile:profile,maxOriginalBytes:512*1024**2,cases:[]};
function fixture(workloadProfile: 'capacity-v1'|'operational-v1' = 'capacity-v1') {
  const operational=workloadProfile==='operational-v1';
  const evidence=new Map<string,Buffer>();
  const store=(value:unknown)=>{const data=Buffer.from(JSON.stringify(value));const sha=createHash('sha256').update(data).digest('hex');evidence.set(sha,data);return sha;};
  // Fabricated complete reports are unit controls only, never committed release evidence.
  const window={startedAt:'2026-09-25T00:00:00.000Z',endedAt:'2026-09-25T02:00:00.000Z'};
  const observed=['cold','warm','mixed'].map(name=>{
    const plan={...buildLoadPlan({scenario:name,workloadProfile}),live:true};
    const uploads=name==='warm'?0:plan.originals;
    return {kind:'mobile-image-load-observations',harnessVersion:1,plan,window,
      uploads:Array.from({length:uploads},(_,index)=>({index,ok:true,elapsedMs:1,verificationMs:100,hashVerified:true,receiptVerified:true})),
      previews:Array.from({length:plan.guests*plan.pageTiles*plan.visitsPerGuest},(_,index)=>({index,ok:true,elapsedMs:1,previewHit:true,previewPrivate:true})),
      controls:Array.from({length:plan.controls.directBaseline+plan.controls.directDuringLoad},(_,index)=>({index,ok:true,elapsedMs:10,phase:index<plan.controls.directBaseline?'baseline':'during'})),
      probes:[...Array(plan.controls.privacy).fill('privacy'),...Array(plan.controls.deletion).fill('deletion'),...Array(plan.controls.cancellation).fill('cancellation'),
        ...Array(plan.controls.regenerationSeeds).fill('regeneration-seed'),...Array(plan.controls.retryChecks??0).fill('multipart-retry')]
        .map((kind,index)=>({index,kind,ok:true,elapsedMs:1,violation:false,...(kind==='multipart-retry'?{retryVerified:true,receiptVerified:true,hashVerified:true}:{})}))};
  });
  // A real warm window has no decoder activity at all: no RSS, scratch or busy failover to observe.
  const deployment=(name:string)=>({originalBytesFetched:name==='warm'?0:(operational?25*24:10000*50)*1024**2,nativeDecodes:name==='warm'?0:name==='mixed'?(operational?26:10001):(operational?24:10000),
    nativeSeconds:name==='warm'?0:100,peakRssBytes:name==='warm'?0:1024**2,peakScratchBytes:0,previewHits:name==='mixed'?(operational?94:47999):(operational?96:48000),previewMisses:name==='mixed'?(operational?2:1):0,
    busyRate:0,...(operational?{}:{costPer10000Originals:0}),uploadPoolPreviewJobs:0,previewPoolUploadJobs:0,busyFailoverChecks:name==='warm'?0:1,regenerationDecodes:name==='mixed'?(operational?2:1):0});
  const scenarios=observed.map(o=>({name:o.plan.scenario,...(operational?{workloadProfile:'operational-v1',eventShards:1,
    payloadBounds:o.plan.payloadBounds,declaredOperations:o.uploads.length+o.previews.length+o.controls.length+o.probes.length,
    concurrency:{upload:{configured:4,maxActive:o.plan.scenario==='warm'?0:2}}}:{}),guests:o.plan.guests,originals:o.plan.originals,
    pageTiles:o.plan.pageTiles,visitsPerGuest:o.plan.visitsPerGuest,uploadConcurrency:4,previewConcurrency:8,complete:true,
    metrics:{...deployment(o.plan.scenario),...observationMetrics(o)}}));
  const observations={kind:'mobile-image-load-observations-bundle',harnessVersion:1,buildFingerprint:fp,imageRef,
    ...(operational?{workloadProfile}:{}),scenarios:observed};
  const instrumentation={kind:'mobile-image-load-instrumentation',harnessVersion:1,source:'deployment-instrumentation',buildFingerprint:fp,imageRef,
    ...(operational?{workloadProfile,scope:{kind:'candidary.image-load-scope',environment:'preview',workloadProfile:'operational-v1',
      imageDataset:'candidary_image_metrics_preview',decoderDataset:'candidary_image_decoder_preview',mainScript:'candidary-preview',
      buckets:['candidary-preview-media','candidary-preview-media-canonical'],
      containers:{instanceType:'standard-2',pools:{upload:2,preview:2},sleepAfterSeconds:600},
      eventIds:{cold:['gallery_event_0'],warm:['gallery_event_0'],mixed:['gallery_event_0','upload_event_0']}}}:{}),
    scenarios:scenarios.map(item=>({name:item.name,window,metrics:item.metrics}))};
  const load={kind:'mobile-image-load',harnessVersion:1,source:'live-rehearsal',buildFingerprint:fp,imageRef,observationsSha256:'d'.repeat(64),instrumentationSha256:'e'.repeat(64),
    ...(operational?{workloadProfile,capacityQualified:false}:{}),
    versions:{harness:'unit',worker:'unit',decoder:'unit'},scenarios};
  load.observationsSha256=store(observations);load.instrumentationSha256=store(instrumentation);
  const qualification={kind:'mobile-image-qualification',harnessVersion:1,buildFingerprint:fp,imageRef,previewProfile:profile,manifestSha256,
    ...(operational?{qualificationProfile:workloadProfile}:{}),maxOriginalBytes:operational?128*1024**2:512*1024**2,caseIds:['png'],loadEvidenceSha256:store(load)};
  const proof=()=>store(qualification);
  const corpus={structureValid:true,complete:false,qualifiedCaseIds:['png'],cases:[{id:'png',status:'pass',fixtures:[{id:'control',sourceSha256:'f'.repeat(64),evidence:
    Object.fromEntries(['local','live','ios','android'].map(lane=>[lane,{status:'pass',buildFingerprint:fp,imageRefs:[imageRef],evidenceSha256:'a'.repeat(64)}]))}]},
    {id:'live-photo-library',status:'platform-limited',fixtures:[]}]};
  const run=()=>verifyRelease({decoderRelease:{...emptyDecoder,releases:[{imageRef,buildFingerprint:fp,protocolVersion:1,previewProfile:profile,verifiedCaseIds:['png'],evidenceSha256:proof()}]},
    mobileRelease:{...emptyMobile,cases:[{caseId:'png',buildFingerprint:fp,evidenceSha256:proof(),maxOriginalBytes:operational?128*1024**2:512*1024**2}]},
    corpus,manifestSha256,readEvidence:async(sha:string)=>evidence.get(sha)});
  return {run,corpus,qualification,load,store,evidence,observations,instrumentation};
}
function practicalFixture() {
  const evidence=new Map<string,Buffer>();
  const store=(value:unknown)=>{const data=Buffer.from(JSON.stringify(value));const digest=createHash('sha256').update(data).digest('hex');evidence.set(digest,data);return digest;};
  const caseIds=['png'];
  const qualification={kind:'mobile-image-qualification',harnessVersion:1,qualificationProfile:'practical-v1',buildFingerprint:fp,
    imageRef,previewProfile:profile,manifestSha256,maxOriginalBytes:134217728,caseIds,
    practicalScope:{caseIds:[...caseIds],maxOriginalBytes:134217728,capacityQualified:false,universal:false,deviceCertified:false}};
  const lane=()=>({status:'pass',buildFingerprint:fp,imageRefs:[imageRef],evidenceSha256:'a'.repeat(64)});
  const corpus={structureValid:true,complete:false,qualifiedCaseIds:['png'],cases:[{id:'png',status:'missing',fixtures:[
    {id:'control',sourceSha256:'f'.repeat(64),evidence:{local:lane(),live:lane(),ios:{status:'missing'},android:{status:'missing'}}},
  ]}]};
  const decoderRelease={...emptyDecoder,releases:[{imageRef,buildFingerprint:fp,protocolVersion:1,previewProfile:profile,verifiedCaseIds:caseIds,evidenceSha256:''}]};
  const mobileRelease={...emptyMobile,cases:[{caseId:'png',buildFingerprint:fp,evidenceSha256:'',maxOriginalBytes:134217728}]};
  const run=(pinned=true)=>{
    if(pinned){const digest=store(qualification);decoderRelease.releases[0]!.evidenceSha256=digest;mobileRelease.cases[0]!.evidenceSha256=digest;}
    return verifyRelease({decoderRelease,mobileRelease,corpus,manifestSha256,readEvidence:async(sha:string)=>evidence.get(sha)});
  };
  return {run,store,evidence,qualification,corpus,decoderRelease,mobileRelease};
}
describe('external mobile image release evidence',()=>{
  it('admits bounded practical native/live proof with missing device lanes, without certification',async()=>{
    expect(await practicalFixture().run()).toMatchObject({valid:true,admittedCaseIds:['png'],capacityQualified:false,universal:false});
    const purportedComplete=practicalFixture();purportedComplete.corpus.complete=true;
    expect(await purportedComplete.run()).toMatchObject({valid:true,capacityQualified:false,universal:false});
  });
  it('rejects missing or mismatched practical proof and identity',async()=>{
    for(const mutate of [
      (f:ReturnType<typeof practicalFixture>)=>{f.corpus.cases[0]!.fixtures[0]!.evidence.local.status='fail';},
      (f:ReturnType<typeof practicalFixture>)=>{f.corpus.cases[0]!.fixtures[0]!.evidence.live.status='missing';},
      (f:ReturnType<typeof practicalFixture>)=>{const second=structuredClone(f.corpus.cases[0]!.fixtures[0]!);second.id='second';
        second.evidence.live.status='fail';f.corpus.cases[0]!.fixtures.push(second);},
      (f:ReturnType<typeof practicalFixture>)=>{f.corpus.cases[0]!.fixtures[0]!.evidence.live.imageRefs=[];},
      (f:ReturnType<typeof practicalFixture>)=>{f.corpus.cases[0]!.fixtures[0]!.evidence.local.buildFingerprint='0'.repeat(64);},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.manifestSha256='0'.repeat(64);},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.imageRef=`registry.example/decoder@sha256:${'0'.repeat(64)}`;},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.buildFingerprint='0'.repeat(64);},
    ]){const f=practicalFixture();mutate(f);expect((await f.run()).valid).toBe(false);}
    const badHash=practicalFixture();await badHash.run();badHash.evidence.set(badHash.decoderRelease.releases[0]!.evidenceSha256,Buffer.from('{}'));
    expect((await badHash.run(false)).valid).toBe(false);
  });
  it('rejects excluded cases, expanded sizes and certification declarations',async()=>{
    for(const mutate of [
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.caseIds=['heic-sequence'];},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.practicalScope.caseIds=['live-photo-camera'];},
      (f:ReturnType<typeof practicalFixture>)=>{f.mobileRelease.cases[0]!.caseId='live-photo-library';},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.maxOriginalBytes=134217729;},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.practicalScope.maxOriginalBytes=134217729;},
      (f:ReturnType<typeof practicalFixture>)=>{f.mobileRelease.cases[0]!.maxOriginalBytes=134217729;},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.practicalScope.universal=true;},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.practicalScope.capacityQualified=true;},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.practicalScope.deviceCertified=true;},
      (f:ReturnType<typeof practicalFixture>)=>{Object.assign(f.qualification,{universal:true});},
    ]){const f=practicalFixture();mutate(f);expect((await f.run()).valid).toBe(false);}
  });
  it('keeps omitted profile as capacity and rejects unknown or confused profiles',async()=>{
    expect(await fixture().run()).toMatchObject({valid:true,capacityQualified:true});
    for(const mutate of [
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.qualificationProfile='unknown';},
      (f:ReturnType<typeof practicalFixture>)=>{f.qualification.qualificationProfile='operational-v1';},
      (f:ReturnType<typeof practicalFixture>)=>{delete (f.qualification as {qualificationProfile?:string}).qualificationProfile;},
    ]){const f=practicalFixture();mutate(f);expect((await f.run()).valid).toBe(false);}
  });
  it('reads hash-named evidence from corpus layout or explicit legacy root and confines real paths',async()=>{
    const root=await mkdtemp(join(tmpdir(),'mobile-image-release-'));
    try{
      const bytes=Buffer.from('{"kind":"proof"}');const digest=createHash('sha256').update(bytes).digest('hex');
      await mkdir(join(root,'evidence'));await writeFile(join(root,'evidence',`${digest}.json`),bytes);
      expect(await evidenceReader(root,digest)).toEqual(bytes);
      expect(await evidenceReader(join(root,'evidence'),digest)).toEqual(bytes);
      const external=await mkdtemp(join(tmpdir(),'mobile-image-private-'));
      try{
        await writeFile(join(external,`${digest}.json`),bytes);
        await rm(join(root,'evidence',`${digest}.json`));
        await symlink(join(external,`${digest}.json`),join(root,'evidence',`${digest}.json`));
        await expect(evidenceReader(root,digest)).rejects.toThrow();
      }finally{await rm(external,{recursive:true,force:true});}
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('accepts empty closed configs without claiming mobile qualification',async()=>{
    const result=await verifyRelease({decoderRelease:emptyDecoder,mobileRelease:emptyMobile,corpus:{structureValid:true,complete:false,cases:[]},manifestSha256,
      readEvidence:()=>{throw Error('No report needed for closed intake');}});
    expect(result).toMatchObject({valid:true,admittedCaseIds:[],universal:false});
  });
  it('allows a qualified still while paired resources keep the universal gate closed',async()=>{
    const result=await fixture().run();expect(result).toMatchObject({valid:true,admittedCaseIds:['png'],capacityQualified:true,universal:false});
  });
  it('rejects a re-pinned capacity report with a substituted embedded operational scope',async()=>{
    for(const workloadProfile of ['operational-v1','unknown']){
      const f=fixture();
      Object.assign(f.instrumentation,{scope:{workloadProfile}});
      f.load.instrumentationSha256=f.store(f.instrumentation);
      f.qualification.loadEvidenceSha256=f.store(f.load);
      expect(await f.run()).toMatchObject({valid:false,admittedCaseIds:[],capacityQualified:false,universal:false});
    }
  });
  it('admits only pinned operational evidence with native/live/device proof and keeps capacity and universal false',async()=>{
    const valid=fixture('operational-v1');
    expect(await valid.run()).toMatchObject({valid:true,admittedCaseIds:['png'],capacityQualified:false,universal:false});
    for(const mutate of [
      (f:ReturnType<typeof fixture>)=>{const q: {qualificationProfile?:MutableWorkloadProfile}=f.qualification;
        q.qualificationProfile='capacity-v1';},
      (f:ReturnType<typeof fixture>)=>{const load: {workloadProfile?:MutableWorkloadProfile}=f.load;
        load.workloadProfile='capacity-v1';},
      (f:ReturnType<typeof fixture>)=>{f.observations.scenarios[0]!.plan.guests=3;f.load.observationsSha256=f.store(f.observations);},
      (f:ReturnType<typeof fixture>)=>{f.instrumentation.scenarios[0]!.metrics.costPer10000Originals=1;
        f.load.instrumentationSha256=f.store(f.instrumentation);},
      (f:ReturnType<typeof fixture>)=>{f.instrumentation.scope!.workloadProfile='capacity-v1';
        f.load.instrumentationSha256=f.store(f.instrumentation);},
      (f:ReturnType<typeof fixture>)=>{const scope: {workloadProfile?:string}=f.instrumentation.scope!;
        delete scope.workloadProfile;
        f.load.instrumentationSha256=f.store(f.instrumentation);},
      (f:ReturnType<typeof fixture>)=>{f.corpus.cases[0]!.fixtures[0]!.evidence.ios!.status='missing';},
      (f:ReturnType<typeof fixture>)=>{f.qualification.manifestSha256='0'.repeat(64);},
    ]) {const f=fixture('operational-v1');mutate(f);f.qualification.loadEvidenceSha256=f.store(f.load);
      expect(await f.run()).toMatchObject({valid:false,admittedCaseIds:[],capacityQualified:false,universal:false});}
  });
  it('reads a pinned observations bundle larger than 32 MiB, as the declared 58,290-operation workload produces',async()=>{
    const f=fixture();
    f.load.observationsSha256=f.store({...f.observations,rows:'x'.repeat(40*1024**2)});
    f.qualification.loadEvidenceSha256=f.store(f.load);
    expect(await f.run()).toMatchObject({valid:true,admittedCaseIds:['png']});
    // The bound still applies: a document one byte over 128 MiB is refused before hashing.
    const g=fixture(); const loadSha=g.qualification.loadEvidenceSha256;
    const oversized=await verifyRelease({decoderRelease:{...emptyDecoder,releases:[{imageRef,buildFingerprint:fp,protocolVersion:1,previewProfile:profile,verifiedCaseIds:['png'],evidenceSha256:g.store(g.qualification)}]},mobileRelease:{...emptyMobile,cases:[{caseId:'png',buildFingerprint:fp,evidenceSha256:g.store(g.qualification),maxOriginalBytes:512*1024**2}]},
      corpus:g.corpus,manifestSha256,readEvidence:async(sha:string)=>sha===loadSha?{length:128*1024**2+1}:g.evidence.get(sha)});
    expect(oversized.valid).toBe(false);expect(oversized.issues.join(' ')).toMatch(/size mismatch/i);
  },60_000);
  it('refuses a Docker-local image digest where an external registry digest is required',async()=>{
    // Docker's containerd store reports RepoDigests such as name@sha256:<id> for images never pushed.
    for(const local of [`candidary-image-decoder@sha256:${'b'.repeat(64)}`,`localhost:5000/decoder@sha256:${'b'.repeat(64)}`,`127.0.0.1:5000/decoder@sha256:${'b'.repeat(64)}`]){
      const f=fixture();
      for(const lane of Object.values(f.corpus.cases[0]!.fixtures[0]!.evidence)) lane.imageRefs=[local];
      for(const artifact of [f.qualification,f.load,f.observations,f.instrumentation]) artifact.imageRef=local;
      f.load.observationsSha256=f.store(f.observations);f.load.instrumentationSha256=f.store(f.instrumentation);
      f.qualification.loadEvidenceSha256=f.store(f.load);
      const result=await verifyRelease({decoderRelease:{...emptyDecoder,releases:[{imageRef:local,buildFingerprint:fp,protocolVersion:1,previewProfile:profile,verifiedCaseIds:['png'],evidenceSha256:f.store(f.qualification)}]},
        mobileRelease:{...emptyMobile,cases:[{caseId:'png',buildFingerprint:fp,evidenceSha256:f.store(f.qualification),maxOriginalBytes:512*1024**2}]},
        corpus:f.corpus,manifestSha256,readEvidence:async(sha:string)=>f.evidence.get(sha)});
      expect(result).toMatchObject({valid:false,admittedCaseIds:[]});
    }
  });
  it('rejects cross-lane identity drift and missing device evidence',async()=>{
    for(const change of [{buildFingerprint:'0'.repeat(64)},{imageRefs:[]},{status:'missing'}]){
      const f=fixture();Object.assign(f.corpus.cases[0]!.fixtures[0]!.evidence.ios!,change);expect((await f.run()).valid).toBe(false);
    }
  });
  it('rejects hash substitution, unmeasured bytes and failing warm load',async()=>{
    const f=fixture();f.qualification.maxOriginalBytes=20*1024**2;expect((await f.run()).valid).toBe(false);
    const g=fixture();g.load.scenarios[1]!.metrics.nativeDecodes=1;g.qualification.loadEvidenceSha256=g.store(g.load);expect((await g.run()).valid).toBe(false);
    // Warm decoder traffic that never decoded (busy only) still means the persisted previews were not warm.
    // Report and instrumentation agree here, so only the load gate itself can refuse these.
    for (const [index,key,value,issue] of [[1,'busyFailoverChecks',1,'warm: go/no-go target failed.'],[1,'peakRssBytes',1,'warm: go/no-go target failed.'],
      [0,'busyFailoverChecks',0,'cold: measurements do not account for the declared workload.'],
      [2,'regenerationDecodes',0,'mixed: measurements do not account for the declared workload.'],[1,'regenerationDecodes',1,'warm: go/no-go target failed.']] as const) {
      const f=fixture();f.load.scenarios[index]!.metrics[key]=value;f.instrumentation.scenarios[index]!.metrics[key]=value;
      f.load.instrumentationSha256=f.store(f.instrumentation);f.qualification.loadEvidenceSha256=f.store(f.load);
      const result=await f.run();expect(result.valid).toBe(false);expect(result.issues).toContain(issue);
    }
    const h=fixture();h.qualification.manifestSha256='0'.repeat(64);expect((await h.run()).valid).toBe(false);
  });
  it('requires pinned observation bytes and request accounting, not report assertions alone',async()=>{
    const missing=fixture();missing.evidence.delete(missing.load.observationsSha256);expect((await missing.run()).valid).toBe(false);
    const short=fixture();short.observations.scenarios[0]!.uploads.pop();short.load.observationsSha256=short.store(short.observations);
    short.qualification.loadEvidenceSha256=short.store(short.load);expect((await short.run()).valid).toBe(false);
    const forged=fixture();forged.evidence.set(forged.load.instrumentationSha256,Buffer.from('{}'));expect((await forged.run()).valid).toBe(false);
    const control=fixture();control.observations.scenarios[0]!.controls.pop();control.load.observationsSha256=control.store(control.observations);
    control.qualification.loadEvidenceSha256=control.store(control.load);expect((await control.run()).valid).toBe(false);
    const derived=fixture();derived.load.scenarios[2]!.metrics.p99Ms=2;derived.instrumentation.scenarios[2]!.metrics.p99Ms=2;
    derived.load.instrumentationSha256=derived.store(derived.instrumentation);derived.qualification.loadEvidenceSha256=derived.store(derived.load);
    expect((await derived.run()).valid).toBe(false);
  });
});
