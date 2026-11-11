import { fetchRemoteImage, MAX_REMOTE_IMAGE_BYTES, readBodyCapped } from '../../genoffice/packages/electron-utils/src/remote-image';
import { remoteExportImageMime } from '../../genoffice/apps/markdown/src/shared/export-image-mime';

export async function readRemoteImage(source: unknown): Promise<{ base64: string; mime: string }> {
  if (typeof source !== 'string' || !/^https?:\/\//i.test(source)) throw new Error('A remote image requires an HTTP or HTTPS URL.');
  const response = await fetchRemoteImage(source);
  if (!response?.ok) {
    await response?.body?.cancel();
    throw new Error('The remote image could not be read or its address is blocked.');
  }
  const bytes = await readBodyCapped(response, MAX_REMOTE_IMAGE_BYTES);
  const mime = remoteExportImageMime(bytes, response.headers.get('content-type'), source);
  if (!mime || !bytes.length) throw new Error('The remote image format is not supported.');
  return { base64: Buffer.from(bytes).toString('base64'), mime };
}
