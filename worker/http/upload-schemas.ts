import { z } from 'zod';

import { UPLOAD_BATCH_SIZE } from '../../shared/constants';

export const uploadFileSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().max(100),
  byteSize: z.number(),
  idempotencyKey: z.string().min(1).max(128),
  caption: z.string().max(300).nullish(),
}).strict();

export const guestUploadSchema = uploadFileSchema.extend({
  guestName: z.string().trim().min(1).max(80),
}).strict();

export const guestUploadBatchSchema = z.object({
  guestName: z.string().trim().min(1).max(80),
  files: z.array(uploadFileSchema).min(1).max(UPLOAD_BATCH_SIZE),
}).strict();

export const managerUploadBatchSchema = z.object({
  files: z.array(uploadFileSchema).min(1).max(UPLOAD_BATCH_SIZE),
}).strict();
