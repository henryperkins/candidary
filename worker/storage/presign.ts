import { AwsClient } from 'aws4fetch';

import { UPLOAD_URL_TTL_SECONDS, type SupportedImageType } from '../../shared/constants';
interface LegacyTestSigningEnv {
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

function encodedKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export async function presignUpload(
  env: LegacyTestSigningEnv,
  key: string,
  mimeType: SupportedImageType,
): Promise<{ url: string; expiresAt: string }> {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 presigning credentials are not configured.');
  }
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${encodedKey(key)}`);
  url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_TTL_SECONDS));
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const signed = await client.sign(url, {
    method: 'PUT',
    headers: { 'content-type': mimeType },
    aws: { signQuery: true, allHeaders: true },
  });
  return {
    url: signed.url,
    expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
  };
}
