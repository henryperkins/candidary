import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Node release script's actual evidence interface is tested here.
import { verifyRelease } from '../../scripts/verify-mobile-image-release.mjs';
// @ts-expect-error Node rehearsal script's derived-metric interface is tested here.
import { buildLoadPlan, observationMetrics } from '../../scripts/mobile-image-load-harness.mjs';
const fp='a'.repeat(64),imageRef=`registry.example/decoder@sha256:${'b'.repeat(64)}`,manifestSha256='c'.repeat(64);
const profile='mobile-preview-v1';
// Literal closed baselines: the committed release files may hold preview candidate or qualified records.
const emptyDecoder={protocolVersion:1,previewProfile:profile,releases:[]};
const emptyMobile={kind:'candidary.mobile-image-release',schemaVersion:26,protocolVersion:1,previewProfile:profile,maxOriginalBytes:512*1024**2,cases:[]};
function fixture() {
  const evidence=new Map<string,Buffer>();
  const store=(value:unknown)=>{const data=Buffer.from(JSON.stringify(value));const sha=createHash('sha256').update(data).digest('hex');evidence.set(sha,data);return sha;};
  // Fabricated complete reports are unit controls only, never committed release evidence.
  const window={startedAt:'2026-09-25T00:00:00.000Z',endedAt:'2026-09-25T02:00:00.000Z'};
  const observed=['cold','warm','mixed'].map(name=>{
    const plan={...buildLoadPlan({scenario:name}),live:true};
    const uploads=name==='warm'?0:10000;
    return {kind:'mobile-image-load-observations',harnessVersion:1,plan,window,
      uploads:Array.from({length:uploads},(_,index)=>({index,ok:true,elapsedMs:1,verificationMs:100,hashVerified:true,receiptVerified:true})),
      previews:Array.from({length:48000},(_,index)=>({index,ok:true,elapsedMs:1,previewHit:true,previewPrivate:true})),
      controls:Array.from({length:200},(_,index)=>({index,ok:true,elapsedMs:10,phase:index<100?'baseline':'during'})),
      probes:[...Array(50).fill('privacy'),...Array(10).fill('deletion'),...Array(10).fill('cancellation'),...Array(plan.controls.regenerationSeeds).fill('regeneration-seed')]
        .map((kind,index)=>({index,kind,ok:true,elapsedMs:1,violation:false}))};
  });
  // A real warm window has no decoder activity at all: no RSS, scratch or busy failover to observe.
  const deployment=(name:string)=>({originalBytesFetched:name==='warm'?0:10000*50*1024**2,nativeDecodes:name==='warm'?0:name==='mixed'?10001:10000,
    nativeSeconds:name==='warm'?0:100,peakRssBytes:name==='warm'?0:1024**2,peakScratchBytes:0,previewHits:name==='mixed'?47999:48000,previewMisses:name==='mixed'?1:0,
    busyRate:0,costPer10000Originals:0,uploadPoolPreviewJobs:0,previewPoolUploadJobs:0,busyFailoverChecks:name==='warm'?0:1,regenerationDecodes:name==='mixed'?1:0});
  const scenarios=observed.map(o=>({name:o.plan.scenario,guests:500,originals:10000,pageTiles:48,visitsPerGuest:2,uploadConcurrency:4,previewConcurrency:8,complete:true,
    metrics:{...deployment(o.plan.scenario),...observationMetrics(o)}}));
  const observations={kind:'mobile-image-load-observations-bundle',harnessVersion:1,buildFingerprint:fp,imageRef,scenarios:observed};
  const instrumentation={kind:'mobile-image-load-instrumentation',harnessVersion:1,source:'deployment-instrumentation',buildFingerprint:fp,imageRef,
    scenarios:scenarios.map(item=>({name:item.name,window,metrics:item.metrics}))};
  const load={kind:'mobile-image-load',harnessVersion:1,source:'live-rehearsal',buildFingerprint:fp,imageRef,observationsSha256:'d'.repeat(64),instrumentationSha256:'e'.repeat(64),
    versions:{harness:'unit',worker:'unit',decoder:'unit'},scenarios};
  load.observationsSha256=store(observations);load.instrumentationSha256=store(instrumentation);
  const qualification={kind:'mobile-image-qualification',harnessVersion:1,buildFingerprint:fp,imageRef,previewProfile:profile,manifestSha256,maxOriginalBytes:512*1024**2,caseIds:['png'],loadEvidenceSha256:store(load)};
  const proof=()=>store(qualification);
  const corpus={structureValid:true,complete:false,qualifiedCaseIds:['png'],cases:[{id:'png',status:'pass',fixtures:[{id:'control',sourceSha256:'f'.repeat(64),evidence:
    Object.fromEntries(['local','live','ios','android'].map(lane=>[lane,{status:'pass',buildFingerprint:fp,imageRefs:[imageRef],evidenceSha256:'a'.repeat(64)}]))}]},
    {id:'live-photo-library',status:'platform-limited',fixtures:[]}]};
  const run=()=>verifyRelease({decoderRelease:{...emptyDecoder,releases:[{imageRef,buildFingerprint:fp,protocolVersion:1,previewProfile:profile,verifiedCaseIds:['png'],evidenceSha256:proof()}]},
    mobileRelease:{...emptyMobile,cases:[{caseId:'png',buildFingerprint:fp,evidenceSha256:proof(),maxOriginalBytes:512*1024**2}]},
    corpus,manifestSha256,readEvidence:async(sha:string)=>evidence.get(sha)});
  return {run,corpus,qualification,load,store,evidence,observations,instrumentation};
}
describe('external mobile image release evidence',()=>{
  it('accepts empty closed configs without claiming mobile qualification',async()=>{
    const result=await verifyRelease({decoderRelease:emptyDecoder,mobileRelease:emptyMobile,corpus:{structureValid:true,complete:false,cases:[]},manifestSha256,
      readEvidence:()=>{throw Error('No report needed for closed intake');}});
    expect(result).toMatchObject({valid:true,admittedCaseIds:[],universal:false});
  });
  it('allows a qualified still while paired resources keep the universal gate closed',async()=>{
    const result=await fixture().run();expect(result).toMatchObject({valid:true,admittedCaseIds:['png'],universal:false});
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
