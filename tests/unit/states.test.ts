import { describe, expect, it } from 'vitest';

import {
  classifyApiErrorCode,
  failureDecisionForCode,
} from '../../shared/load-failure';
import { ClientApiError } from '../../src/app/api';
import { describeLoadFailure } from '../../src/components/States';

describe('load failure classification', () => {
  it.each([
    ['SESSION_REQUIRED', 'latest-link'],
    ['SESSION_EXPIRED', 'latest-link'],
    ['ROLE_FORBIDDEN', 'latest-link'],
    ['RESOURCE_FORBIDDEN', 'retry'],
    ['OWNER_CLAIM_REQUIRED', 'retry'],
    ['GUEST_LINK_UNAVAILABLE', 'retry'],
    ['EVENT_NOT_FOUND', 'ended-event'],
    ['EVENT_EXPIRED', 'ended-event'],
    ['UPLOADS_DISABLED', 'retry'],
    ['VALIDATION_FAILED', 'retry'],
    ['TOKEN_REVOKED', 'latest-link'],
    ['HOST_SESSION_REQUIRED', 'sign-in'],
    ['ACCOUNT_DISABLED', 'latest-link'],
    ['INTERNAL_ERROR', 'retry'],
  ] as const)('classifies %s as %s', (code, expected) => {
    expect(classifyApiErrorCode(code)).toBe(expected);
  });

  it('keeps explicit recovery decisions alongside the failure kind', () => {
    expect(failureDecisionForCode('SESSION_EXPIRED'))
      .toEqual({ kind: 'latest-link', offerSignIn: true });
    expect(failureDecisionForCode('HOST_SESSION_REQUIRED'))
      .toEqual({ kind: 'sign-in', offerSignIn: true });
    expect(failureDecisionForCode('ACCOUNT_DISABLED'))
      .toEqual({ kind: 'latest-link', offerSignIn: false });
  });

  it('exposes shared failure decisions through component descriptions', () => {
    const disabled = describeLoadFailure(
      new ClientApiError('ACCOUNT_DISABLED', 'This account is no longer active.'),
      'manager',
      'fallback',
    );
    expect(disabled.kind).toBe('latest-link');
    expect(disabled.offerSignIn).toBe(false);

    const guest = describeLoadFailure(
      new ClientApiError('SESSION_REQUIRED', 'Open a link.'),
      'guest',
      'fallback',
    );
    expect(guest.kind).toBe('latest-link');
    expect(guest.offerSignIn).toBe(false);
  });
});
