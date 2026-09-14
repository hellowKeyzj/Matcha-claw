import type { SessionRenderToolCard } from '../types/session/tool-card';

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

export interface GeneratedFileLineStats {
  added: number;
  removed: number;
}

export interface GeneratedFile {
  filePath: string;
  fileName: string;
  ext: string;
  mimeType: string;
  contentType: FileContentType;
  sourceTool: 'write' | 'edit';
  action: 'created' | 'modified' | 'deleted';
  baseline: string;
  content: string;
  lineStats: GeneratedFileLineStats;
  toolCallId?: string;
  toolId: string;
}

interface FileMutationPayload {
  filePath: string;
  sourceTool: GeneratedFile['sourceTool'];
  action: GeneratedFile['action'];
  baseline: string;
  content: string;
  lineStats?: GeneratedFileLineStats;
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
  '.avif',
]);

const MARKDOWN_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
]);

const SHEET_EXTENSIONS = new Set([
  '.csv',
  '.xls',
  '.xlsx',
]);

const PDF_EXTENSIONS = new Set([
  '.pdf',
]);

const ARCHIVE_EXTENSIONS = new Set([
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.7z',
  '.rar',
]);

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.m4v',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.sql',
  '.php',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.vue',
  '.svelte',
  '.dockerfile',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.log',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.properties',
]);

const DOCUMENT_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.rtf',
  '.odt',
  '.ods',
  '.odp',
]);

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function getTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const WRITE_TOOL_NAMES = new Set(['write', 'filewrite', 'createfile']);
const EDIT_TOOL_NAMES = new Set(['edit', 'fileedit']);
const MULTI_EDIT_TOOL_NAMES = new Set(['multiedit']);
const PATCH_TOOL_NAMES = new Set(['applypatch', 'patch']);

function normalizeToolName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function resolveFilePath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'filePath', 'path', 'file']) {
    const resolved = getTrimmedString(input[key]);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function countChangedLines(text: string): number {
  if (!text) {
    return 0;
  }
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length;
}

function buildLineStats(baseline: string, content: string): GeneratedFileLineStats {
  return {
    added: countChangedLines(content),
    removed: countChangedLines(baseline),
  };
}

function readRawStringField(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

function readStructuredPatchLines(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value] : [];
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.lines)) {
    return record.lines.filter((line): line is string => typeof line === 'string');
  }
  const line = getString(record.text) ?? getString(record.line) ?? getString(record.content);
  return line && line.trim() ? [line] : [];
}

function readPatchText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() ? value : null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const key of ['patch', 'diff']) {
    const text = getString(record[key]);
    if (text && text.trim()) {
      return text;
    }
  }

  const gitDiff = record.gitDiff;
  if (typeof gitDiff === 'string' && gitDiff.trim()) {
    return gitDiff;
  }
  const nestedGitDiff = asRecord(gitDiff);
  if (nestedGitDiff) {
    for (const key of ['patch', 'diff']) {
      const text = getString(nestedGitDiff[key]);
      if (text && text.trim()) {
        return text;
      }
    }
  }

  const structuredPatch = record.structuredPatch;
  if (typeof structuredPatch === 'string' && structuredPatch.trim()) {
    return structuredPatch;
  }
  if (Array.isArray(structuredPatch)) {
    const lines = structuredPatch.flatMap(readStructuredPatchLines);
    return lines.length > 0 ? lines.join('\n') : null;
  }
  return null;
}

function normalizeDiffPath(filePath: string | null): string | null {
  const value = filePath?.trim().replace(/^['"]|['"]$/g, '').split('\t')[0]?.trim() ?? '';
  if (!value || value === '/dev/null') {
    return null;
  }
  return value.replace(/^[ab]\//, '');
}

function readGitDiffPath(line: string): string | null {
  const quotedTargetIndex = line.indexOf(' "b/');
  if (quotedTargetIndex >= 0) {
    return normalizeDiffPath(line.slice(quotedTargetIndex + 2));
  }
  const targetIndex = line.indexOf(' b/');
  if (targetIndex >= 0) {
    return normalizeDiffPath(line.slice(targetIndex + 1));
  }
  const parts = line.trim().split(/\s+/);
  return normalizeDiffPath(parts[parts.length - 1] ?? null);
}

interface PatchFileDraft {
  filePath: string | null;
  oldPath: string | null;
  newPath: string | null;
  sourceTool: GeneratedFile['sourceTool'];
  action: GeneratedFile['action'];
  baselineLines: string[];
  contentLines: string[];
  added: number;
  removed: number;
  fromGit: boolean;
  sawNewPath: boolean;
  inHunk: boolean;
}

function createPatchFileDraft(
  filePath: string | null,
  action: GeneratedFile['action'],
  fromGit: boolean,
): PatchFileDraft {
  return {
    filePath,
    oldPath: null,
    newPath: null,
    sourceTool: 'edit',
    action,
    baselineLines: [],
    contentLines: [],
    added: 0,
    removed: 0,
    fromGit,
    sawNewPath: false,
    inHunk: false,
  };
}

function pushPatchContentLine(draft: PatchFileDraft, line: string, requireHunk: boolean): void {
  if (line.startsWith('@@')) {
    draft.inHunk = true;
    return;
  }
  if (requireHunk && !draft.inHunk) {
    return;
  }
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***') || line.startsWith('\\')) {
    return;
  }
  if (line.startsWith('+')) {
    draft.contentLines.push(line.slice(1));
    draft.added += 1;
    return;
  }
  if (line.startsWith('-')) {
    draft.baselineLines.push(line.slice(1));
    draft.removed += 1;
    return;
  }
  if (line.startsWith(' ')) {
    const value = line.slice(1);
    draft.baselineLines.push(value);
    draft.contentLines.push(value);
  }
}

function finishPatchFileDraft(draft: PatchFileDraft | null): FileMutationPayload | null {
  if (!draft) {
    return null;
  }
  const action = draft.action !== 'modified'
    ? draft.action
    : draft.oldPath == null && draft.newPath != null
      ? 'created'
      : draft.newPath == null && draft.oldPath != null
        ? 'deleted'
        : 'modified';
  const filePath = action === 'deleted'
    ? draft.oldPath ?? draft.filePath
    : draft.newPath ?? draft.filePath ?? draft.oldPath;
  if (!filePath) {
    return null;
  }
  return {
    filePath,
    sourceTool: draft.sourceTool,
    action,
    baseline: draft.baselineLines.join('\n'),
    content: draft.contentLines.join('\n'),
    lineStats: {
      added: draft.added,
      removed: draft.removed,
    },
  };
}

function pushFinishedPatchFile(draft: PatchFileDraft | null, mutations: FileMutationPayload[]): void {
  const mutation = finishPatchFileDraft(draft);
  if (mutation) {
    mutations.push(mutation);
  }
}

function parseApplyPatchText(patchText: string): FileMutationPayload[] {
  const lines = patchText.replace(/\r\n?/g, '\n').split('\n');
  const mutations: FileMutationPayload[] = [];
  let current: PatchFileDraft | null = null;

  for (const line of lines) {
    const section = /^\*\*\*\s+(Add|Update|Delete) File:\s+(.+)$/u.exec(line);
    if (section) {
      pushFinishedPatchFile(current, mutations);
      const sectionAction = section[1] === 'Add' ? 'created' : section[1] === 'Delete' ? 'deleted' : 'modified';
      current = createPatchFileDraft(section[2]?.trim() ?? null, sectionAction, false);
      current.inHunk = true;
      continue;
    }
    if (current && line.startsWith('*** Move to:')) {
      const movedPath = normalizeDiffPath(line.slice('*** Move to:'.length));
      current.filePath = movedPath ?? current.filePath;
      current.newPath = movedPath;
      continue;
    }
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      continue;
    }
    if (current) {
      pushPatchContentLine(current, line, false);
    }
  }

  pushFinishedPatchFile(current, mutations);
  return mutations;
}

function parseUnifiedDiffText(diffText: string): FileMutationPayload[] {
  const lines = diffText.replace(/\r\n?/g, '\n').split('\n');
  const mutations: FileMutationPayload[] = [];
  let current: PatchFileDraft | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushFinishedPatchFile(current, mutations);
      current = createPatchFileDraft(readGitDiffPath(line), 'modified', true);
      continue;
    }

    if (line.startsWith('new file mode')) {
      if (current) {
        current.action = 'created';
      }
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (current) {
        current.action = 'deleted';
      }
      continue;
    }

    if (line.startsWith('--- ')) {
      if (current?.sawNewPath && !current.fromGit) {
        pushFinishedPatchFile(current, mutations);
        current = null;
      }
      if (!current) {
        current = createPatchFileDraft(null, 'modified', false);
      }
      const oldPath = normalizeDiffPath(line.slice(4));
      current.oldPath = oldPath;
      current.filePath = current.filePath ?? oldPath;
      current.inHunk = false;
      continue;
    }

    if (line.startsWith('+++ ')) {
      if (!current) {
        current = createPatchFileDraft(null, 'modified', false);
      }
      const newPath = normalizeDiffPath(line.slice(4));
      current.newPath = newPath;
      current.sawNewPath = true;
      current.filePath = newPath ?? current.filePath ?? current.oldPath;
      if (!current.oldPath && newPath) {
        current.action = 'created';
      }
      if (!newPath && current.oldPath) {
        current.action = 'deleted';
      }
      current.inHunk = false;
      continue;
    }

    if (current) {
      pushPatchContentLine(current, line, true);
    }
  }

  pushFinishedPatchFile(current, mutations);
  return mutations;
}

function parsePatchMutations(patchText: string): FileMutationPayload[] {
  const applyPatchFiles = parseApplyPatchText(patchText);
  return applyPatchFiles.length > 0 ? applyPatchFiles : parseUnifiedDiffText(patchText);
}

function parsePatchSnippetMutation(filePath: string, patchText: string): FileMutationPayload | null {
  const draft = createPatchFileDraft(filePath, 'modified', false);
  draft.inHunk = true;
  for (const line of patchText.replace(/\r\n?/g, '\n').split('\n')) {
    pushPatchContentLine(draft, line, false);
  }
  if (draft.added === 0 && draft.removed === 0) {
    return null;
  }
  return finishPatchFileDraft(draft);
}

function extractMultiEditMutation(args: Record<string, unknown>): FileMutationPayload | null {
  const filePath = resolveFilePath(args);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!filePath || edits.length === 0) {
    return null;
  }

  const baselineParts: string[] = [];
  const contentParts: string[] = [];
  let added = 0;
  let removed = 0;

  for (const editValue of edits) {
    const edit = asRecord(editValue);
    if (!edit) {
      continue;
    }
    const baseline = readRawStringField(edit, ['old_string', 'oldString']) ?? '';
    const content = readRawStringField(edit, ['new_string', 'newString']) ?? '';
    baselineParts.push(baseline);
    contentParts.push(content);
    removed += countChangedLines(baseline);
    added += countChangedLines(content);
  }

  if (baselineParts.length === 0 && contentParts.length === 0) {
    return null;
  }

  return {
    filePath,
    sourceTool: 'edit',
    action: 'modified',
    baseline: baselineParts.join('\n'),
    content: contentParts.join('\n'),
    lineStats: { added, removed },
  };
}

function extractFileMutations(tool: SessionRenderToolCard): FileMutationPayload[] {
  const normalizedName = normalizeToolName(tool.name);
  const args = asRecord(tool.input);

  if (args && WRITE_TOOL_NAMES.has(normalizedName)) {
    const filePath = resolveFilePath(args);
    const content = getString(args.content);
    if (!filePath) {
      return [];
    }
    if (content != null) {
      return [{
        filePath,
        sourceTool: 'write',
        action: 'created',
        baseline: '',
        content,
      }];
    }
  }

  const patchText = readPatchText(tool.details)
    ?? (PATCH_TOOL_NAMES.has(normalizedName) ? readPatchText(tool.input) : null);
  if (patchText) {
    const mutations = parsePatchMutations(patchText);
    if (mutations.length > 0) {
      return mutations;
    }
    const filePath = args ? resolveFilePath(args) : null;
    const snippetMutation = filePath ? parsePatchSnippetMutation(filePath, patchText) : null;
    if (snippetMutation) {
      return [snippetMutation];
    }
  }

  if (!args) {
    return [];
  }

  if (WRITE_TOOL_NAMES.has(normalizedName)) {
    const filePath = resolveFilePath(args);
    if (!filePath) {
      return [];
    }
    return [{
      filePath,
      sourceTool: 'write',
      action: 'created',
      baseline: '',
      content: '',
    }];
  }

  if (EDIT_TOOL_NAMES.has(normalizedName)) {
    const filePath = resolveFilePath(args);
    const baseline = typeof args.old_string === 'string' ? args.old_string : '';
    const content = typeof args.new_string === 'string' ? args.new_string : '';
    if (!filePath) {
      return [];
    }
    return [{
      filePath,
      sourceTool: 'edit',
      action: 'modified',
      baseline,
      content,
    }];
  }

  if (MULTI_EDIT_TOOL_NAMES.has(normalizedName)) {
    const mutation = extractMultiEditMutation(args);
    return mutation ? [mutation] : [];
  }

  return [];
}

export function extnameOf(filePath: string): string {
  if (!filePath) {
    return '';
  }
  const normalizedPath = filePath.replace(/\\/g, '/');
  const lowerPath = normalizedPath.toLowerCase();
  if (lowerPath.endsWith('/dockerfile') || lowerPath === 'dockerfile') {
    return '.dockerfile';
  }
  const slashIndex = lowerPath.lastIndexOf('/');
  const fileName = slashIndex >= 0 ? lowerPath.slice(slashIndex + 1) : lowerPath;
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex) : '';
}

function basenameOf(filePath: string): string {
  if (!filePath) {
    return '';
  }
  const normalizedPath = filePath.replace(/\\/g, '/');
  const slashIndex = normalizedPath.lastIndexOf('/');
  return slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
}

export function getMimeTypeForExt(ext: string): string {
  return EXTENSION_MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function getMimeTypeForPath(filePath: string): string {
  return getMimeTypeForExt(extnameOf(filePath));
}

export function classifyFileContentType(ext: string, mimeType: string): FileContentType {
  const normalizedExt = ext.toLowerCase();
  const normalizedMime = mimeType.toLowerCase();

  if (IMAGE_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('image/')) {
    return 'image';
  }
  if (PDF_EXTENSIONS.has(normalizedExt) || normalizedMime === 'application/pdf') {
    return 'pdf';
  }
  if (SHEET_EXTENSIONS.has(normalizedExt)) {
    return 'sheet';
  }
  if (MARKDOWN_EXTENSIONS.has(normalizedExt)) {
    return 'markdown';
  }
  if (normalizedExt === '.html' || normalizedExt === '.htm' || normalizedMime === 'text/html') {
    return 'html';
  }
  if (CODE_EXTENSIONS.has(normalizedExt)) {
    return 'code';
  }
  if (TEXT_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('text/')) {
    return 'text';
  }
  if (ARCHIVE_EXTENSIONS.has(normalizedExt) || normalizedMime.includes('zip') || normalizedMime.includes('compressed')) {
    return 'archive';
  }
  if (AUDIO_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('audio/')) {
    return 'audio';
  }
  if (VIDEO_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('video/')) {
    return 'video';
  }
  if (DOCUMENT_EXTENSIONS.has(normalizedExt)) {
    return 'document';
  }
  return 'binary';
}

export function supportsInlineDiff(
  file: Pick<GeneratedFile, 'contentType'> & Partial<Pick<GeneratedFile, 'ext' | 'baseline' | 'content' | 'action'>>,
): boolean {
  if (typeof file.baseline !== 'string' || typeof file.content !== 'string') {
    return false;
  }
  if (file.contentType === 'sheet') {
    return file.ext === '.csv';
  }
  return file.action !== 'deleted'
    && (file.contentType === 'code'
      || file.contentType === 'text'
      || file.contentType === 'markdown'
      || file.contentType === 'html');
}

export function supportsInlineDocumentPreview(ext: string): boolean {
  const contentType = classifyFileContentType(ext, getMimeTypeForExt(ext));
  return contentType === 'code'
    || contentType === 'text'
    || contentType === 'markdown'
    || contentType === 'html'
    || contentType === 'image'
    || contentType === 'pdf'
    || contentType === 'sheet';
}

export function extractGeneratedFilesFromToolCards(
  tools: ReadonlyArray<SessionRenderToolCard>,
): GeneratedFile[] {
  const filesByPath = new Map<string, GeneratedFile>();

  for (const tool of tools) {
    const mutations = extractFileMutations(tool);
    for (const mutation of mutations) {
      const ext = extnameOf(mutation.filePath);
      const mimeType = getMimeTypeForExt(ext);
      const contentType = classifyFileContentType(ext, mimeType);
      filesByPath.set(mutation.filePath, {
        filePath: mutation.filePath,
        fileName: basenameOf(mutation.filePath),
        ext,
        mimeType,
        contentType,
        sourceTool: mutation.sourceTool,
        action: mutation.action,
        baseline: mutation.baseline,
        content: mutation.content,
        lineStats: mutation.lineStats ?? buildLineStats(mutation.baseline, mutation.content),
        ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
        toolId: tool.id,
      });
    }
  }

  return [...filesByPath.values()];
}
