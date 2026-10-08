import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// Browser evidence uses explicitly stubbed APIs and the real frontend modules.
// Avoid the Worker HTML fallback so React's dev preamble is served by Vite.
export default defineConfig({
  plugins: [react()],
  define: { __CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__: 'false' },
  worker: { format: 'es' },
});
