import { Container, getRandom } from '@cloudflare/containers';
import release from '../../../config/image-decoder-release.json';
import { decoderMetricsPoint, routeDecoderRequest } from './pool';

export class UploadImageDecoder extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = false;
  override onError(): void { throw new Error('Private decoder unavailable.'); }
}
export class PreviewImageDecoder extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = false;
  override onError(): void { throw new Error('Private decoder unavailable.'); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const upload = Number(env.UPLOAD_POOL_SIZE);
    const preview = Number(env.PREVIEW_POOL_SIZE);
    const response = await routeDecoderRequest(request, {
      upload: { name: 'upload', size: upload, draw: () => getRandom(env.UPLOAD_DECODERS, upload) },
      preview: { name: 'preview', size: preview, draw: () => getRandom(env.PREVIEW_DECODERS, preview) },
    }, release, (job) => env.DECODER_METRICS?.writeDataPoint(decoderMetricsPoint(env.DECODER_ENVIRONMENT, job)));
    const headers = new Headers(response.headers);
    headers.set('X-Decoder-Environment', env.DECODER_ENVIRONMENT);
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
