/* global console */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { resolveConfig } from 'vite';

const config = await resolveConfig({}, 'build');
const outDir = config.environments?.client?.build?.outDir;
if (!outDir) throw new Error('Vite client build output could not be resolved.');
const clientOut = resolve(config.root, outDir);

const requiredFiles = [
  'manifest.webmanifest',
  'icons/candidary-180.png',
  'icons/candidary-192.png',
  'icons/candidary-512.png',
  'icons/candidary-maskable-512.png',
  'index.html',
  '_headers',
];

const contents = new Map();
for (const path of requiredFiles) {
  contents.set(path, await readFile(resolve(clientOut, path)));
}

const manifest = JSON.parse(contents.get('manifest.webmanifest').toString());
if (manifest.name !== 'Candidary'
  || manifest.short_name !== 'Candidary'
  || manifest.display !== 'standalone'
  || manifest.scope !== '/'
  || manifest.theme_color !== '#42103b'
  || manifest.background_color !== '#f7f1e7') {
  throw new Error('Built manifest metadata does not match the approved PWA contract.');
}
if (Object.hasOwn(manifest, 'start_url') || Object.hasOwn(manifest, 'id')) {
  throw new Error('Built manifest must preserve the installing route by omitting start_url and id.');
}

const html = contents.get('index.html').toString();
const htmlRequirements = [
  /<meta\s+name="theme-color"\s+content="#42103b"\s*\/?>/u,
  /<meta\s+name="mobile-web-app-capable"\s+content="yes"\s*\/?>/u,
  /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"\s*\/?>/u,
  /<meta\s+name="apple-mobile-web-app-title"\s+content="Candidary"\s*\/?>/u,
  /<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="default"\s*\/?>/u,
  /<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="\/icons\/candidary-180\.png"\s*\/?>/u,
  /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/?>/u,
];
if (htmlRequirements.some((requirement) => !requirement.test(html))) {
  throw new Error('Built index.html is missing approved PWA metadata.');
}
if (/<link[^>]+rel="manifest"[^>]+crossorigin/iu.test(html)) {
  throw new Error('The same-origin public manifest link must not use crossorigin.');
}

const headers = contents.get('_headers').toString();
if (!/\/manifest\.webmanifest\s+Content-Type: application\/manifest\+json/u.test(headers)) {
  throw new Error('Built static headers are missing the manifest content type.');
}

console.log(`Verified PWA build output at ${clientOut}.`);
