import type { ApiErrorBody } from './errors';

// Access links only ever grant these two. Keeping `Role` narrow is what stops a
// host account from being mistaken for something an event token can mint.
export type Role = 'guest' | 'manager';
// What a session's subject is. `host` sessions belong to an account rather than
// to one event, and no access token can produce one.
export type SessionRole = Role | 'host';
export type EventHostRole = 'owner' | 'cohost';
// Emailed codes prove control of an address. They never sign a host in on their
// own — `verify` unlocks notifications, `reset` authorizes one password change.
export type ChallengePurpose = 'verify' | 'reset';
export type NotificationKind = 'getting_started' | 'event_reminder' | 'retention_warning';
export type UploadState = 'reserved' | 'stored' | 'failed' | 'deleted';
export type ModerationStatus = 'pending' | 'approved' | 'rejected';
export type PublicationStatus = 'unpublished' | 'published' | 'hidden';
export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiErrorBody;
