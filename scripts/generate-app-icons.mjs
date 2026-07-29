/* global Buffer, console */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const source = await readFile(resolve(projectRoot, 'design/assets/candidary-app-icon.svg'), 'utf8');
const sourceUrl = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
const outputDirectory = resolve(projectRoot, 'public/icons');
const targets = [
  ['candidary-180.png', 180],
  ['candidary-192.png', 192],
  ['candidary-512.png', 512],
  ['candidary-maskable-512.png', 512],
];

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch();
try {
  for (const [filename, size] of targets) {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      viewport: { width: size, height: size },
    });
    const page = await context.newPage();

    await page.setContent(`
      <!doctype html>
      <html>
        <head>
          <style>
            html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #f7f1e7; }
            img { display: block; width: 100%; height: 100%; }
          </style>
        </head>
        <body><img src="${sourceUrl}" alt="" /></body>
      </html>
    `);
    await page.locator('img').evaluate((image) => image.decode());
    await page.screenshot({
      path: resolve(outputDirectory, filename),
      animations: 'disabled',
      fullPage: false,
    });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`Generated ${targets.length} app icons from design/assets/candidary-app-icon.svg.`);
