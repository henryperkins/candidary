import type { ApiErrorBody } from './errors';

export type Role = 'guest' | 'manager';
export type UploadState = 'reserved' | 'stored' | 'failed' | 'deleted';
export type ModerationStatus = 'pending' | 'approved' | 'rejected';
export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiErrorBody;

