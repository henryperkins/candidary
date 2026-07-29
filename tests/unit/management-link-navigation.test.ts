// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { replaceManagementLocation } from '../../src/app/management-link';

afterEach(() => { vi.unstubAllGlobals(); });

describe('management link navigation', () => {
  it('uses window.location.replace by default', () => {
    const replace = vi.fn();
    vi.stubGlobal('window', { location: { replace } });

    replaceManagementLocation('/manage/Abc_123.Xyz-789');

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('/manage/Abc_123.Xyz-789');
  });
});
