import type { ChallengePurpose } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { AccountsRepository, normalizeEmail } from '../db/accounts';
import type { HostAccountRecord } from '../db/types';
import type { AppEnv } from '../env';
import { constantTimeEqual, digestSecret } from '../security/crypto';
import { hashPassword, verifyPassword } from '../security/passwords';
import { EmailService, layout } from './email';
import { unsubscribeUrl } from './notifications';

const CODE_TTL_SECONDS = 15 * 60;
const MAX_CODE_ATTEMPTS = 5;
// Five requests per quarter hour is far above any honest use — a host asks once,
// maybe twice — and far below what makes an inbox flood worth attempting.
const MAX_CODES_PER_WINDOW = 5;
const CODE_WINDOW_SECONDS = 15 * 60;

// A password verification that always runs, even for an address with no account.
// Returning early on a miss would make sign-in measurably faster for unregistered
// addresses, which turns the login form into an account-existence oracle.
const ABSENT_ACCOUNT_HASH = 'scrypt$32768$8$3$'
  + 'AAAAAAAAAAAAAAAAAAAAAA$'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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

export class HostAuthService {
  private readonly accounts: AccountsRepository;
  private readonly email: EmailService;

  constructor(private readonly env: AppEnv) {
    this.accounts = new AccountsRepository(env.DB);
    this.email = new EmailService(env);
  }

  async register(input: {
    email: string;
    password: string;
    displayName: string | null;
    bindEventId: string | null;
  }, now = new Date()): Promise<HostAccountRecord | null> {
    const passwordHash = await hashPassword(input.password);
    const account = await this.accounts.create({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      createdAt: now.toISOString(),
    });

    if (!account) {
      // The address is taken. The caller answers exactly as it would for a new
      // account, so the only signal goes to the inbox that actually owns it.
      const existing = await this.accounts.getByEmail(input.email);
      if (existing) await this.sendAlreadyRegistered(existing);
      return null;
    }

    if (input.bindEventId) {
      await this.accounts.addEventHost(input.bindEventId, account.id, 'owner', now.toISOString());
    }
    await this.issueChallenge(account, 'verify', input.bindEventId, now);
    return account;
  }

  async authenticate(email: string, password: string): Promise<HostAccountRecord> {
    const account = await this.accounts.getByEmail(email);
    const { valid, needsRehash } = await verifyPassword(password, account?.passwordHash ?? ABSENT_ACCOUNT_HASH);
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
    const windowStart = new Date(now.getTime() - CODE_WINDOW_SECONDS * 1000).toISOString();
    const recent = await this.accounts.countRecentChallenges(account.id, purpose, windowStart);
    if (recent >= MAX_CODES_PER_WINDOW) {
      throw new ApiError('LOGIN_RATE_LIMITED', 'Too many codes requested. Try again in a few minutes.', 429);
    }

    const code = sixDigitCode();
    await this.accounts.supersedeChallenges(account.id, purpose, now.toISOString());
    const challenge = await this.accounts.createChallenge({
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

  private sendAlreadyRegistered(account: HostAccountRecord) {
    const origin = this.env.APP_ORIGIN.replace(/\/$/u, '');
    return this.email.send({
      to: account.email,
      subject: 'You already have a Candidary account',
      text: `Someone tried to create a Candidary account with this address, which already has one.\n\n`
        + `Sign in instead: ${origin}/host/login\n\n`
        + 'If that was you and you have forgotten your password, you can reset it from the sign-in page. '
        + 'If it was not you, no action is needed — nothing about your account changed.',
      html: layout('You already have an account', [
        'Someone tried to create a Candidary account with this address, which already has one.',
        `<a href="${origin}/host/login">Sign in instead</a>`,
        'If that was you and you have forgotten your password, you can reset it from the sign-in page. If it was not you, no action is needed — nothing about your account changed.',
      ]),
    });
  }

  async sendPasswordChanged(account: HostAccountRecord) {
    const origin = this.env.APP_ORIGIN.replace(/\/$/u, '');
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
