import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
// API-stub browser proof, deliberately independent of Worker/D1/native setup.
export default defineConfig({plugins:[react()],server:{watch:{ignored:['**/output/**']},fs:{allow:[process.cwd(),realpathSync('node_modules')]}}});
