import { defineConfig } from 'vite';

// Deliberately plugin-free: smoke serves the downloaded client artifact and
// must not depend on build-job state under .wrangler/ or invoke a second build.
export default defineConfig({});
