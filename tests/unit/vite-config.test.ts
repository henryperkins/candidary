import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/vite-plugin', () => ({
  cloudflare: () => ({ name: 'cloudflare-test-stub' }),
}));
vi.mock('@vitejs/plugin-react', () => ({
  default: () => ({ name: 'react-test-stub' }),
}));

import { omitLocalDevVars } from '../../vite.config';

describe('Vite build security', () => {
  it('removes the local secret file without changing built Worker assets', () => {
    const devVars = { type: 'asset', source: 'SECRET=value' };
    const worker = { type: 'chunk', code: 'export default {}' };
    const bundle = { '.dev.vars': devVars, 'chunks/worker.js': worker };

    omitLocalDevVars(bundle);

    expect(bundle).toEqual({ 'chunks/worker.js': worker });
  });
});
