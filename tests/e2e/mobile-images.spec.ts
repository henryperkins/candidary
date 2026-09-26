import { createHash } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { expect,test,type Page,type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { EVENT_FIXTURE,GUEST_EVENT_FIXTURE,stubGuestRoutes,stubLibraryRoutes } from './fixtures/routes';
import { PHOTOGRAPHIC_COVER } from './fixtures/cover-images';
import type { UploadTransferView } from '../../shared/mobile-image-contract';

const sizes=[{name:'narrow',width:320,height:568},{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:1000}];
// These bytes exercise the real File/fetch/UI contract, never native decoding.
const bytes=Buffer.from('untouched original transport fixture');
const file={name:'original.dng',mimeType:'image/dng',buffer:bytes};
const sha=createHash('sha256').update(bytes).digest('hex');
const json=(route:Route,data:unknown,status=200) => route.fulfill({status,headers:{'cache-control':'private, no-store'},json:{data,requestId:'mobile-image-ui'}});
async function uploads(page:Page,root:string) {
  const transfer:UploadTransferView={id:'transfer-mobile',mediaId:'media-mobile',state:'receiving',partBytes:8*1024**2,partCount:1,acceptedParts:[],
    expiresAt:new Date(Date.now()+3600_000).toISOString(),hardExpiresAt:new Date(Date.now()+6*3600_000).toISOString(),previewState:'pending'};
  let mode:'hold'|'outage'|'deliver'='hold'; let puts=0; const proofs:number[][]=[];
  const outcome=() => ({transfer,...(transfer.state==='delivered' ? {media:{id:transfer.mediaId,mimeType:'image/dng',uploadState:'stored'}} : {})});
  await page.route(`**${root}/**`,async route => {
    const path=new URL(route.request().url()).pathname;
    if (path.endsWith('/capabilities')) return json(route,{mimeTypes:['image/jpeg','image/dng'],extensions:['jpg','dng'],directMaxBytes:20*1024**2,maxOriginalBytes:512*1024**2,partBytes:8*1024**2});
    if (path.endsWith('/batch')) {
      const payload=route.request().postDataJSON(); expect(payload.files[0].transport).toBe('parts-v1');
      return json(route,{items:[{idempotencyKey:payload.files[0].idempotencyKey,status:'accepted',transport:'parts-v1',media:{id:transfer.mediaId,mimeType:'image/dng',uploadState:'reserved'},transfer}]},201);
    }
    if (path.endsWith('/verify')) {
      const body=route.request().postDataJSON(); expect(body.byteSize).toBe(bytes.length);
      expect(body.parts).toEqual(transfer.acceptedParts.map(index => ({index,byteSize:bytes.length,sha256:sha})));
      proofs.push(body.parts.map((p:{index:number}) => p.index)); return json(route,{verifiedParts:transfer.acceptedParts});
    }
    if (path.endsWith('/parts/0')) {
      expect(route.request().postDataBuffer()).toEqual(bytes); expect(route.request().headers()['x-part-sha256']).toBe(sha);
      puts++; transfer.acceptedParts=[0]; return json(route,{index:0,accepted:true});
    }
    if (path.endsWith('/complete')) {transfer.state='processing'; return json(route,outcome(),202);}
    if (route.request().method()==='GET') {
      if (transfer.state==='processing' && mode==='outage') transfer.state='retryable';
      if (transfer.state==='processing' && mode==='deliver') {transfer.state='delivered'; transfer.previewState='ready';}
      return json(route,outcome());
    }
    throw new Error(`Unexpected upload route ${path}`);
  });
  return {proofs,get puts(){return puts;},mode:(value:typeof mode) => {mode=value;}};
}
async function wake(page:Page) {await page.evaluate(() => window.dispatchEvent(new Event('online')));}
async function surface(page:Page) {
  expect(await page.title()).toMatch(/Candidary/i);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  const result=await new AxeBuilder({page}).options({rules:{'target-size':{enabled:true}}}).analyze();
  expect(result.violations.map(v => ({id:v.id,impact:v.impact,targets:v.nodes.map(n => n.target)}))).toEqual([]);
}
const consoleMessages=new WeakMap<Page,Array<{level:string;text:string;url:string}>>();
test.beforeEach(async ({page}) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  const messages:Array<{level:string;text:string;url:string}>=[];consoleMessages.set(page,messages);
  page.on('console',message=>{if(['error','warning'].includes(message.type())) messages.push({level:message.type(),text:message.text(),url:message.location().url});});
});
test.afterEach(async ({page},info)=>{
  await mkdir('output/playwright/mobile-images',{recursive:true});
  await writeFile(`output/playwright/mobile-images/${info.project.name}-${info.title.replace(/[^a-zA-Z0-9]+/g,'-')}-console.json`,JSON.stringify(consoleMessages.get(page)??[],null,2));
});
for (const size of sizes) {
  test(`${size.name}: guest original selection, reload proof, confirming, outage and receipt`,async ({page,browser},info) => {
    await page.setViewportSize(size); const errors:string[]=[]; page.on('pageerror',error => errors.push(error.message));
    await stubGuestRoutes(page,{event:{galleryVisible:false},gallery:[],contributions:[]});
    const h=await uploads(page,`/api/event/${GUEST_EVENT_FIXTURE.slug}/uploads`);
    await page.goto(`/event/${GUEST_EVENT_FIXTURE.slug}`);
    await expect(page.getByRole('button',{name:'Choose recent photos',exact:true})).toBeVisible();
    const camera=page.locator('input[data-photo-source="camera"]'),library=page.locator('input[data-photo-source="library"]');
    await expect(camera).toHaveAttribute('capture','environment'); await expect(library).toHaveAttribute('accept',/\.dng/);
    await page.getByLabel('Your name').fill('Avery'); await library.setInputFiles(file);
    await expect(page.getByRole('button',{name:'Add photos',exact:true})).toBeFocused();
    expect(await page.locator('.selection-card__image img').count()).toBe(0);
    await page.getByRole('button',{name:'Send 1 photo'}).focus(); await page.keyboard.press('Enter');
    await expect(page.getByText('Confirming delivery')).toBeVisible();
    await expect(page.getByRole('heading',{name:'Your 1 photo was sent.'})).toHaveCount(0);
    await page.reload(); await expect(page.getByText(/Choose the same originals to resume/)).toBeVisible();
    await camera.setInputFiles(file); await page.getByRole('button',{name:'Send 1 photo'}).click();
    await expect(page.getByText('Confirming delivery')).toBeVisible();
    expect(h.puts).toBe(1); expect(h.proofs).toContainEqual([0]);
    await surface(page);
    await mkdir('output/playwright/mobile-images',{recursive:true});
    await page.screenshot({path:`output/playwright/mobile-images/${info.project.name}-${size.name}-confirming.png`,fullPage:false});
    h.mode('outage'); await wake(page); await expect(page.getByText('Needs attention',{exact:true})).toBeVisible();
    await expect(page.locator('[aria-live="polite"]')).not.toHaveCount(0);
    h.mode('deliver'); await page.getByRole('button',{name:'Retry 1 photo'}).click();
    await expect(page.getByRole('heading',{name:'Your 1 photo was sent.'})).toBeVisible();
    expect(h.puts).toBe(1); expect(errors).toEqual([]);
    await surface(page); await page.screenshot({path:`output/playwright/mobile-images/${info.project.name}-${size.name}-receipt.png`,fullPage:false});
    await info.attach('browser-evidence',{body:JSON.stringify({browser:info.project.name,version:browser.version(),viewport:size,apiStubs:true,physicalDevice:false}),contentType:'application/json'});
  });
  test(`${size.name}: manager original receipt, private preview and Trash confirmation`,async ({page},info) => {
    await page.setViewportSize(size); const errors:string[]=[]; page.on('pageerror',error => errors.push(error.message));
    const fixture=await stubLibraryRoutes(page,2); const h=await uploads(page,`/api/manage/events/${EVENT_FIXTURE.id}/uploads`);
    const previews:string[]=[];
    await page.route('**/api/media/*/preview',route => {previews.push(route.request().url()); return route.fulfill({headers:{'cache-control':'private, no-store','content-type':'image/png'},body:PHOTOGRAPHIC_COVER});});
    await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
    await page.getByRole('button',{name:'Add photos',exact:true}).click(); const dialog=page.getByRole('dialog',{name:'Add photos'});
    await expect(dialog.locator('input[data-photo-source="library"]')).toHaveAttribute('accept',/\.dng/);
    await dialog.locator('input[data-photo-source="library"]').setInputFiles(file);
    await dialog.getByRole('button',{name:'Send 1 photo'}).click(); await expect(dialog.getByText('Confirming delivery')).toBeVisible();
    h.mode('deliver'); await wake(page); await expect(dialog.getByRole('heading',{name:'1 photo was added.'})).toBeVisible();
    await surface(page); await page.screenshot({path:`output/playwright/mobile-images/${info.project.name}-${size.name}-manager.png`,fullPage:false});
    await dialog.getByRole('button',{name:'Return to Library'}).click();
    await expect(page.getByRole('button',{name:'Add photos',exact:true})).toBeFocused();
    await page.locator('.gallery-private [data-photo-id]').first().locator('.gallery-mosaic__open').click();
    await expect(page.getByRole('dialog')).toBeVisible(); expect(previews.length).toBeGreaterThan(0);
    await page.getByRole('button',{name:'Move to Trash',exact:true}).click(); await expect(page.getByRole('button',{name:'Keep photo'})).toBeFocused();
    await page.getByRole('button',{name:'Move to Trash',exact:true}).click(); await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
    expect(fixture.requests.some(path => path.endsWith('/trash'))).toBe(true); expect(errors).toEqual([]);
  });
}
