import type { AppTextModelRequest } from '../../../src/types/desktop/app-plugin-sdk';
import { MAX_PLUGIN_TEXT_REQUEST_BYTES, validatePluginTextRequest } from '../../main/app-plugins/media';
import type { AppApiContext } from '../context';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = { success: false, error: 'Provider text request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Text generation is unavailable. Check the configured model and provider account.' } as const;

export async function handleProviderTextRoutes(
  req: HostApiRequest, url: URL, ctx: Pick<AppApiContext, 'generatePluginText'>,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/providers/text/generate' || req.method !== 'POST') return undefined;
  if (url.search) return jsonResult(400, INVALID);
  try {
    if (req.signal.aborted) return null;
    let body: unknown;
    try {
      const bytes = await req.readBytes(MAX_PLUGIN_TEXT_REQUEST_BYTES, true);
      body = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
    } catch {
      return req.signal.aborted ? null : jsonResult(400, INVALID);
    }
    if (req.signal.aborted) return null;
    const error = validatePluginTextRequest(body);
    if (error) {
      return jsonResult(400, { success: false, error });
    }
    const result = await ctx.generatePluginText(body as AppTextModelRequest, req.signal);
    return req.signal.aborted ? null : jsonResult(200, result);
  } catch {
    return req.signal.aborted ? null : jsonResult(503, UNAVAILABLE);
  }
}
