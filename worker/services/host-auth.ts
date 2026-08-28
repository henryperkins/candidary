import type { ChallengePurpose } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { AccountsRepository, normalizeEmail } from '../db/accounts';
import { AuthRateLimitsRepository, type AuthRateLimitAction, type AuthRateLimitScopeKind } from '../db/auth-rate-limits';
import type { HostAccountRecord, PendingRegistrationRecord } from '../db/types';
import type { AppEnv } from '../env';
import { canonicalOrigin } from '../origins';
import { constantTimeEqual, createSecretToken, digestSecret, type SecretToken } from '../security/crypto';
import { hashPassword, verifyPassword } from '../security/passwords';
import { EmailService, layout } from './email';
import { unsubscribeUrl } from './notifications';

const CODE_TTL_SECONDS = 15 * 60;
const MAX_CODE_ATTEMPTS = 5;

// A password verification always runs even when no account exists. Its salt and
// key are randomized so the dummy is a normal stored-hash shape, but generated
// lazily so importing the Worker performs no random I/O.
let absentAccountHash: string | null = null;

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function getAbsentAccountHash(): string {
  absentAccountHash ??= `scrypt$32768$8$3$${randomBase64Url(16)}$${randomBase64Url(32)}`;
  return absentAccountHash;
}

function sixDigitCode(): string {
  // Rejection sampling. Taking a modulus of a 32-bit draw would make the low codes
  // fractionally likelier, and there is no reason to hand that back.
  const limit = 1_000_000;
  const ceiling = Math.floor(0xffffffff / limit) * limit;
  const buffer = new Uint32Array(1);
  let draw: number;
  do {
    crypto.getRandomValues(buffer);
    draw = buffer[0]!;
  } while (draw >= ceiling);
  return String(draw % limit).padStart(6, '0');
}

export interface IssuedChallenge {
  challengeId: string;
  delivered: boolean;
}

export interface RegistrationRequestScope {
  ipAddress: string;
  creatorSessionId: string | null;
}

export interface StartedRegistration {
  registrationToken: ReturnType<typeof createSecretToken>;
  resumeExpiresAt: string;
}

export interface ResentRegistration {
  registrationToken: SecretToken;
  resumeExpiresAt: string;
}

export interface PendingRegistrationStatus {
  pending: boolean;
  expiresAt: string | null;
}

export class HostAuthService {
  private readonly accounts: AccountsRepository;
  private readonly email: EmailService;

  constructor(private readonly env: AppEnv) {
    this.accounts = new AccountsRepository(env.DB);
    this.email = new EmailService(env);
  }

  private async reserveScopes(input: {
    action: AuthRateLimitAction;
    ipAddress: string;
    ipLimit: number;
    scopeKind: AuthRateLimitScopeKind;
    scopeValue: string;
    scopeLimit: number;
    now?: Date;
  }): Promise<void> {
    const rates = new AuthRateLimitsRepository(this.env.DB, this.env.LOGIN_HMAC_KEY);
    const ipAllowed = await rates.reserve({
      action: input.action,
      scopeKind: 'ip',
      normalizedValue: input.ipAddress,
      limit: input.ipLimit,
      now: input.now,
    });
    const scopeAllowed = await rates.reserve({
      action: input.action,
      scopeKind: input.scopeKind,
      normalizedValue: input.scopeValue,
      limit: input.scopeLimit,
      now: input.now,
    });
    if (!ipAllowed || !scopeAllowed) {
      throw new ApiError('RATE_LIMITED', 'Too many requests. Try again in a few minutes.', 429);
    }
  }

  async reserveLogin(email: string, ipAddress: string, now = new Date()): Promise<void> {
    await this.reserveScopes({
      action: 'login',
      ipAddress,
      ipLimit: 20,
      scopeKind: 'email',
      scopeValue: normalizeEmail(email),
      scopeLimit: 10,
      now,
    });
  }

  async reserveVerificationResend(
    accountId: string,
    ipAddress: string,
    now = new Date(),
  ): Promise<void> {
    await this.reserveScopes({
      action: 'verification_resend',
      ipAddress,
      ipLimit: 10,
      scopeKind: 'account',
      scopeValue: accountId,
      scopeLimit: 5,
      now,
    });
  }

  async reservePasswordReset(
    email: string,
    ipAddress: string,
    now = new Date(),
  ): Promise<void> {
    await this.reserveScopes({
      action: 'password_reset_request',
      ipAddress,
      ipLimit: 10,
      scopeKind: 'email',
      scopeValue: normalizeEmail(email),
      scopeLimit: 3,
      now,
    });
  }

  async startRegistration(input: {
    email: string;
    password: string;
    displayName: string | null;
    bindEventId: string | null;
  }, requestScope: RegistrationRequestScope, now = new Date()): Promise<StartedRegistration> {
    const email = normalizeEmail(input.email);
    await this.reserveScopes({
      action: 'registration',
      ipAddress: requestScope.ipAddress,
      ipLimit: 10,
      scopeKind: 'email',
      scopeValue: email,
      scopeLimit: 3,
      now,
    });
    const passwordHash = await hashPassword(input.password);
    const registrationToken = createSecretToken();
    const code = sixDigitCode();
    const timestamp = now.toISOString();
    const resumeExpiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString();
    await this.accounts.replacePendingRegistration({
      id: registrationToken.id,
      email,
      passwordHash,
      displayName: input.displayName,
      browserSecretDigest: await digestSecret(registrationToken.secret, this.env.LOGIN_HMAC_KEY),
      codeDigest: await digestSecret(code, this.env.LOGIN_HMAC_KEY),
      bindEventId: input.bindEventId,
      creatorSessionId: input.bindEventId ? requestScope.creatorSessionId : null,
      attempts: 0,
      expiresAt: resumeExpiresAt,
      consumedAt: null,
      activationNonce: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.sendRegistrationCode(email, code);
    return { registrationToken, resumeExpiresAt };
  }

  async pendingRegistrationStatus(
    rawToken: string | undefined,
    now = new Date(),
  ): Promise<PendingRegistrationStatus> {
    if (!rawToken) return { pending: false, expiresAt: null };
    let parsed: ReturnType<HostAuthService['parseRegistrationToken']>;
    try {
      parsed = this.parseRegistrationToken(rawToken);
    } catch {
      return { pending: false, expiresAt: null };
    }
    const pending = await this.accounts.getPendingRegistration(parsed.id);
    const expiresAt = pending ? Date.parse(pending.expiresAt) : Number.NaN;
    if (!pending || pending.consumedAt || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      return { pending: false, expiresAt: null };
    }
    const browserDigest = await digestSecret(parsed.secret, this.env.LOGIN_HMAC_KEY);
    if (!constantTimeEqual(browserDigest, pending.browserSecretDigest)) {
      return { pending: false, expiresAt: null };
    }
    return { pending: true, expiresAt: pending.expiresAt };
  }

  async completeRegistration(
    rawToken: string | undefined,
    code: string,
    creatorSessionId: string | null,
    now = new Date(),
  ): Promise<{ account: HostAccountRecord; boundEvent: boolean }> {
    const parsed = this.parseRegistrationToken(rawToken);
    const pending = await this.accounts.getPendingRegistration(parsed.id);
    if (!pending || pending.consumedAt || Date.parse(pending.expiresAt) <= now.getTime()) {
      throw this.invalidRegistrationCode();
    }
    const browserDigest = await digestSecret(parsed.secret, this.env.LOGIN_HMAC_KEY);
    if (!constantTimeEqual(browserDigest, pending.browserSecretDigest)) {
      throw this.invalidRegistrationCode();
    }
    if (!await this.accounts.spendRegistrationAttempt(
      pending.id,
      MAX_CODE_ATTEMPTS,
      now.toISOString(),
    )) throw this.invalidRegistrationCode();
    const supplied = await digestSecret(code, this.env.LOGIN_HMAC_KEY);
    if (!constantTimeEqual(supplied, pending.codeDigest)) throw this.invalidRegistrationCode();

    const authorizedPending: PendingRegistrationRecord = pending.creatorSessionId
      && pending.creatorSessionId === creatorSessionId
      ? pending
      : { ...pending, bindEventId: null, creatorSessionId: null };
    const activated = await this.accounts.activateRegistration(authorizedPending, now.toISOString());
    if (!activated) throw this.invalidRegistrationCode();
    return activated;
  }

  async resendRegistration(
    rawToken: string | undefined,
    requestScope: Pick<RegistrationRequestScope, 'ipAddress'>,
    now = new Date(),
  ): Promise<ResentRegistration> {
    const parsed = this.parseRegistrationToken(rawToken);
    const pending = await this.accounts.getPendingRegistration(parsed.id);
    if (!pending || pending.consumedAt || Date.parse(pending.expiresAt) <= now.getTime()) {
      throw this.invalidRegistrationCode();
    }
    const browserDigest = await digestSecret(parsed.secret, this.env.LOGIN_HMAC_KEY);
    if (!constantTimeEqual(browserDigest, pending.browserSecretDigest)) {
      throw this.invalidRegistrationCode();
    }
    await this.reserveScopes({
      action: 'registration_resend',
      ipAddress: requestScope.ipAddress,
      ipLimit: 10,
      scopeKind: 'pending_registration',
      scopeValue: pending.id,
      scopeLimit: 5,
      now,
    });
    const code = sixDigitCode();
    const resumeExpiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString();
    const outcome = await this.sendRegistrationCode(pending.email, code);
    if (!outcome.delivered) {
      throw new ApiError('LOGIN_EMAIL_UNDELIVERABLE', 'That code could not be sent. Try again shortly.', 502);
    }
    const replaced = await this.accounts.replaceRegistrationCode({
      id: pending.id,
      browserSecretDigest: pending.browserSecretDigest,
      expectedCodeDigest: pending.codeDigest,
      expectedExpiresAt: pending.expiresAt,
      codeDigest: await digestSecret(code, this.env.LOGIN_HMAC_KEY),
      expiresAt: resumeExpiresAt,
      now: now.toISOString(),
    });
    if (!replaced) throw this.invalidRegistrationCode();
    return { registrationToken: parsed.token, resumeExpiresAt };
  }

  async authenticate(email: string, password: string): Promise<HostAccountRecord> {
    const account = await this.accounts.getByEmail(email);
    const { valid, needsRehash } = await verifyPassword(
      password,
      account?.passwordHash ?? getAbsentAccountHash(),
    );
    if (!account || !valid) {
      throw new ApiError('LOGIN_CREDENTIALS_INVALID', 'Check your email address and password.', 401);
    }
    if (account.disabledAt) throw new ApiError('ACCOUNT_DISABLED', 'This account is no longer active.', 403);
    // The plaintext is in hand exactly once per sign-in, so this is the only free
    // moment to move an old hash up to the current cost. The compare-and-swap
    // preserves a reset that changed either the hash or auth version meanwhile.
    if (needsRehash) await this.accounts.setPasswordHashIfCurrent(
      account.id,
      account.passwordHash,
      account.authVersion,
      await hashPassword(password),
    );
    return account;
  }

  // Mints and mails a code. Supersedes any live code for the same purpose so an
  // older message cannot be replayed after the host asks for another.
  async issueChallenge(
    account: HostAccountRecord,
    purpose: ChallengePurpose,
    bindEventId: string | null,
    now = new Date(),
  ): Promise<IssuedChallenge> {
    const code = sixDigitCode();
    const challenge = await this.accounts.replaceChallenge({
      id: crypto.randomUUID(),
      accountId: account.id,
      purpose,
      secretDigest: await digestSecret(code, this.env.LOGIN_HMAC_KEY),
      bindEventId,
      expiresAt: new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString(),
      createdAt: now.toISOString(),
    });

    const outcome = purpose === 'verify'
      ? await this.sendVerifyCode(account, code)
      : await this.sendResetCode(account, code);
    return { challengeId: challenge.id, delivered: outcome.delivered };
  }

  // Spends an attempt before comparing, so a wrong guess costs the same whether or
  // not the code was close. Returns the challenge so the caller can act on what it
  // was for — binding an event, or authorizing one password change.
  async consumeCode(account: HostAccountRecord, purpose: ChallengePurpose, code: string, now = new Date()) {
    const challenge = await this.accounts.getLiveChallenge(account.id, purpose, now.toISOString());
    if (!challenge) {
      throw new ApiError('LOGIN_CODE_EXPIRED', 'That code has expired. Ask for a new one.', 410);
    }
    if (!await this.accounts.spendAttempt(challenge.id, MAX_CODE_ATTEMPTS, now.toISOString())) {
      throw new ApiError('LOGIN_CODE_EXPIRED', 'That code is no longer usable. Ask for a new one.', 410);
    }

    const supplied = await digestSecret(code, this.env.LOGIN_HMAC_KEY);
    if (!constantTimeEqual(supplied, challenge.secretDigest)) {
      throw new ApiError('LOGIN_CODE_INVALID', 'That code is not correct.', 400);
    }
    if (!await this.accounts.consumeChallenge(challenge.id, now.toISOString())) {
      throw new ApiError('LOGIN_CODE_EXPIRED', 'That code was already used.', 410);
    }
    return challenge;
  }

  private sendVerifyCode(account: HostAccountRecord, code: string) {
    return this.email.send({
      to: account.email,
      subject: `${code} is your Candidary confirmation code`,
      text: `Your Candidary confirmation code is ${code}. It expires in 15 minutes.\n\n`
        + 'Confirming your address lets Candidary email you about your event. '
        + 'If you did not create an account, ignore this message.',
      html: layout('Confirm your email address', [
        `Your confirmation code is <strong style="font-size:22px;letter-spacing:2px;">${code}</strong>`,
        'It expires in 15 minutes.',
        'Confirming your address lets Candidary email you about your event. If you did not create an account, ignore this message.',
      ]),
    });
  }

  private sendResetCode(account: HostAccountRecord, code: string) {
    return this.email.send({
      to: account.email,
      subject: `${code} is your Candidary password reset code`,
      text: `Your Candidary password reset code is ${code}. It expires in 15 minutes.\n\n`
        + 'If you did not ask to reset your password, ignore this message and your password stays as it is.',
      html: layout('Reset your password', [
        `Your reset code is <strong style="font-size:22px;letter-spacing:2px;">${code}</strong>`,
        'It expires in 15 minutes.',
        'If you did not ask to reset your password, ignore this message and your password stays as it is.',
      ]),
    });
  }

  private sendRegistrationCode(email: string, code: string) {
    return this.email.send({
      to: email,
      subject: `${code} is your Candidary registration code`,
      text: `Your Candidary registration code is ${code}. It expires in 15 minutes.\n\n`
        + 'If you did not request this code, ignore this message.',
      html: layout('Finish setting up Candidary', [
        `Your registration code is <strong style="font-size:22px;letter-spacing:2px;">${code}</strong>`,
        'It expires in 15 minutes.',
        'If you did not request this code, ignore this message.',
      ]),
    });
  }

  private parseRegistrationToken(rawToken: string | undefined): { id: string; secret: string; token: SecretToken } {
    const [id, secret, extra] = rawToken?.split('.') ?? [];
    if (!id || !secret || extra) throw this.invalidRegistrationCode();
    return { id, secret, token: { id, secret, token: rawToken! } };
  }

  private invalidRegistrationCode(): ApiError {
    return new ApiError('LOGIN_CODE_INVALID', 'That code is not correct.', 400);
  }

  async sendPasswordChanged(account: HostAccountRecord) {
    const origin = canonicalOrigin(this.env);
    return this.email.send({
      to: account.email,
      subject: 'Your Candidary password was changed',
      text: 'Your Candidary password was just changed, and every signed-in device was signed out.\n\n'
        + `If this was not you, reset your password immediately: ${origin}/host/login`,
      html: layout('Your password was changed', [
        'Your Candidary password was just changed, and every signed-in device was signed out.',
        `If this was not you, <a href="${origin}/host/login">reset your password immediately</a>.`,
      ]),
    });
  }

  async unsubscribeLinkFor(account: HostAccountRecord): Promise<string> {
    return unsubscribeUrl(this.env, account.id);
  }
}

export { normalizeEmail };
