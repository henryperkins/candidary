import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { liveStagingReleaseAdapters } from './staging-release-live.ts';
import { runTask11Cli } from './task11-staging-release.ts';

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  runTask11Cli(process.argv.slice(2), process.cwd(), liveStagingReleaseAdapters()).catch((error: unknown) => {
    const code = error instanceof Error && /^[A-Z0-9_.:-]{1,96}$/u.test(error.message)
      ? error.message
      : 'TASK11_STAGING_RELEASE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
