import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
export default defineConfig({ plugins: [react()], server: { fs: { allow: [process.cwd(), realpathSync('node_modules')] } } });
