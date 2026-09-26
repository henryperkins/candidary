/* global URL */
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Compile only the admission boundary using the actual production definitions. */
export async function prepareMobileReleaseTest() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc',await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  if (parsed.error || [parsed.config,parsed.config.env?.preview].some((config) => config?.define?.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__ !== 'false')) throw new Error('Production mobile-image override is not disabled.');
  await build({absWorkingDir:root,entryPoints:['worker/mobile-image-release.ts'],outfile:'output/verification/mobile-image-baseline/production-mobile-release.mjs',
    bundle:true,packages:'external',external:['cloudflare:*','node:*'],platform:'neutral',format:'esm',define:parsed.config.define});
}
