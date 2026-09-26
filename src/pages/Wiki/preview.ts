import { classifyFileContentType, extnameOf, getMimeTypeForPath, type FileContentType } from '@/lib/generated-files';

export type WikiPreviewMeta = Readonly<{
  ext: string;
  mimeType: string;
  contentType: FileContentType;
}>;

export function classifyWikiPath(path: string): WikiPreviewMeta {
  const ext = extnameOf(path);
  const mimeType = getMimeTypeForPath(path);
  return { ext, mimeType, contentType: classifyFileContentType(ext, mimeType) };
}

export function supportsWikiTextPreview(contentType: FileContentType, ext: string): boolean {
  return contentType === 'markdown'
    || contentType === 'html'
    || contentType === 'code'
    || contentType === 'text'
    || (contentType === 'sheet' && ext === '.csv');
}

export function supportsWikiBinaryPreview(contentType: FileContentType): boolean {
  return contentType === 'image' || contentType === 'pdf' || contentType === 'audio' || contentType === 'video';
}

export function wikiPreviewErrorKey(error: string | undefined): 'preview.tooLarge' | 'preview.notFound' | 'preview.invalidPath' | 'preview.unavailable' {
  if (error === 'tooLarge') return 'preview.tooLarge';
  if (error === 'notFound') return 'preview.notFound';
  if (error === 'invalidPath') return 'preview.invalidPath';
  return 'preview.unavailable';
}

export function isUnsupportedWikiSourcePreview(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('wiki source file type is not previewable');
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function typeLabel(contentType: FileContentType, ext: string): string {
  return (ext || contentType).replace(/^\./, '').toUpperCase();
}
