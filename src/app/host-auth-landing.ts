import type { HostSessionAccountView } from '../../shared/contracts';

export type HostAuthLandingIdentity =
  | { kind: 'account'; id: string }
  | { kind: 'email'; digest: string };

export function hostAuthLandingFromState(state: unknown): HostAuthLandingIdentity | null {
  if (!state || typeof state !== 'object') return null;
  const identity = (state as { hostAuthLanding?: unknown }).hostAuthLanding;
  if (!identity || typeof identity !== 'object') return null;
  const value = identity as Record<string, unknown>;
  if (value.kind === 'account' && typeof value.id === 'string' && value.id.length > 0) {
    return { kind: 'account', id: value.id };
  }
  if (value.kind === 'email' && typeof value.digest === 'string' && /^[a-f0-9]{64}$/u.test(value.digest)) {
    return { kind: 'email', digest: value.digest };
  }
  return null;
}

// Password reset confirms a session without returning its account ID. Carry a
// digest for that identity check so the submitted address never enters history.
export async function hostResetLandingIdentity(email: string): Promise<HostAuthLandingIdentity | null> {
  try {
    const bytes = new TextEncoder().encode(email.trim().toLowerCase());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return { kind: 'email', digest: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
  } catch {
    // Without a verifiable identity, the normal dashboard remains available.
    return null;
  }
}

export async function hostAuthLandingMatchesAccount(
  identity: HostAuthLandingIdentity,
  account: HostSessionAccountView,
): Promise<boolean> {
  if (identity.kind === 'account') return identity.id === account.id;
  const actual = await hostResetLandingIdentity(account.email);
  return actual?.kind === 'email' && actual.digest === identity.digest;
}
