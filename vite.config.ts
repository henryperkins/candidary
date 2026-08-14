import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

export function omitLocalDevVars(bundle: Record<string, unknown>): void {
  delete bundle['.dev.vars'];
}

function omitLocalDevVarsPlugin(): Plugin {
  return {
    name: 'candidary-omit-local-dev-vars',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      omitLocalDevVars(bundle);
    },
  };
}

export default defineConfig({
    plugins: [react(), cloudflare(), omitLocalDevVarsPlugin()],
    // The first Web Worker in this application. The composition model runs off
    // the main thread on the authorized natural preview, so choosing a cover
    // never blocks the manager's own scrolling or typing. ES output because the
    // worker imports the shared saliency module rather than inlining it.
    worker: {
      format: 'es',
    },
    build: {
      assetsInlineLimit: 0,
    },
    environments: {
      candidary: {
        define: {
          __CANDIDARY_TEST_LEGACY_R2_SIGNING__: 'false',
        },
      },
    },
});

