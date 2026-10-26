export type FileContentType =
  | 'code'
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'sheet'
  | 'document'
  | 'archive'
  | 'audio'
  | 'video'
  | 'binary';

export interface FileFormatContribution {
  readonly id: string;
  readonly priority: number;
  readonly contentType: FileContentType;
  readonly extensions: readonly string[];
  readonly mimeTypes?: Readonly<Record<string, string>>;
  readonly matchesMime?: (mimeType: string) => boolean;
}

// The same descriptors serve pure metadata projection and assembled reader matching.
export const builtinFileFormats: readonly FileFormatContribution[] = [
  {
    id: 'image', priority: 100, contentType: 'image',
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif'],
    mimeTypes: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif' },
    matchesMime: (mime) => mime.startsWith('image/'),
  },
  {
    id: 'pdf', priority: 90, contentType: 'pdf', extensions: ['.pdf'],
    mimeTypes: { '.pdf': 'application/pdf' }, matchesMime: (mime) => mime === 'application/pdf',
  },
  {
    id: 'sheet', priority: 80, contentType: 'sheet', extensions: ['.csv', '.xls', '.xlsx'],
    mimeTypes: { '.csv': 'text/csv', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  },
  {
    id: 'markdown', priority: 70, contentType: 'markdown', extensions: ['.md', '.markdown', '.mdx'],
    mimeTypes: { '.md': 'text/markdown', '.markdown': 'text/markdown', '.mdx': 'text/markdown' },
  },
  {
    id: 'html', priority: 60, contentType: 'html', extensions: ['.html', '.htm'],
    mimeTypes: { '.html': 'text/html', '.htm': 'text/html' }, matchesMime: (mime) => mime === 'text/html',
  },
  {
    id: 'code', priority: 50, contentType: 'code',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.vue', '.svelte', '.dockerfile'],
    mimeTypes: { '.json': 'application/json', '.jsonc': 'application/json', '.xml': 'application/xml', '.css': 'text/css', '.js': 'text/javascript', '.jsx': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.py': 'text/x-python', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml' },
  },
  {
    id: 'text', priority: 40, contentType: 'text', extensions: ['.txt', '.log', '.ini', '.cfg', '.conf', '.env', '.properties'],
    mimeTypes: { '.txt': 'text/plain', '.log': 'text/plain' }, matchesMime: (mime) => mime.startsWith('text/'),
  },
  {
    id: 'archive', priority: 30, contentType: 'archive', extensions: ['.zip', '.gz', '.tar', '.tgz', '.7z', '.rar'],
    mimeTypes: { '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.tgz': 'application/gzip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar' },
    matchesMime: (mime) => mime.includes('zip') || mime.includes('compressed'),
  },
  {
    id: 'audio', priority: 20, contentType: 'audio', extensions: ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'],
    mimeTypes: { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4' },
    matchesMime: (mime) => mime.startsWith('audio/'),
  },
  {
    id: 'video', priority: 10, contentType: 'video', extensions: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'],
    mimeTypes: { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.m4v': 'video/x-m4v' },
    matchesMime: (mime) => mime.startsWith('video/'),
  },
  {
    id: 'document', priority: 0, contentType: 'document', extensions: ['.doc', '.docx', '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp'],
    mimeTypes: { '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  },
];

export function extnameOf(filePath: string): string {
  if (!filePath) return '';
  const lowerPath = filePath.replace(/\\/g, '/').toLowerCase();
  if (lowerPath.endsWith('/dockerfile') || lowerPath === 'dockerfile') return '.dockerfile';
  const fileName = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex) : '';
}

export function getMimeTypeForExt(ext: string, formats = builtinFileFormats): string {
  const normalizedExt = ext.toLowerCase();
  let matched: FileFormatContribution | undefined;
  for (const format of formats) {
    if (format.mimeTypes?.[normalizedExt] && (!matched || format.priority > matched.priority)) matched = format;
  }
  return matched?.mimeTypes?.[normalizedExt] ?? 'application/octet-stream';
}

export function getMimeTypeForPath(filePath: string, formats = builtinFileFormats): string {
  return getMimeTypeForExt(extnameOf(filePath), formats);
}

export function classifyFileContentType(ext: string, mimeType: string, formats = builtinFileFormats): FileContentType {
  const normalizedExt = ext.toLowerCase();
  const normalizedMime = mimeType.toLowerCase();
  let matched: FileFormatContribution | undefined;
  for (const format of formats) {
    if ((format.extensions.includes(normalizedExt) || format.matchesMime?.(normalizedMime))
      && (!matched || format.priority > matched.priority)) matched = format;
  }
  return matched?.contentType ?? 'binary';
}
