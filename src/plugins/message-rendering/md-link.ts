import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { HTML_TAG_RE } from 'markdown-it/lib/common/html_re.mjs';
import { parseLinkDestination, parseLinkTitle } from 'markdown-it/lib/helpers/index.mjs';

const FILE_LINK_EXTENSIONS = 'md|txt|json|ya?ml|csv|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|mp4|mov|avi|mkv|webm|mp3|wav|ogg|aac|zip|tar|gz|rar|7z';
const FILE_HINT_PATTERN = String.raw`(?:\.{1,2}[\\/])?[\p{L}\p{N}_./\\-]+?\.(?:${FILE_LINK_EXTENSIONS})`;
const MEDIA_FILE_EXTENSIONS = `${FILE_LINK_EXTENSIONS}|html?|mdx|bmp|ts|tsx|js|jsx|log`;
const MEDIA_LOCAL_PATH = String.raw`(?:\/(?!\/)|~[\\/]|[A-Za-z]:[\\/]|\\\\)`;
const MEDIA_DIRECTIVE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9/\\])MEDIA:((?:https?:\/\/|\/api\/chat\/media\/outgoing\/)[^\s\n"'()\[\],<>]+|${MEDIA_LOCAL_PATH}[^\n"'()\[\],<>]*?\.(?:${MEDIA_FILE_EXTENSIONS})(?=$|[\s\n"'()\[\],<>，。；;,.!?])|${MEDIA_LOCAL_PATH}[^\s\n"'()\[\],<>，。；;!?]+)`, 'gi',
);
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;
// Assistant envelopes also use XML-style names (for example, underscores).
const ENVELOPE_TAG_RE = /^<\/?[A-Za-z_][\w:.-]*(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*\/?>/u;
const markdownSyntax = new MarkdownIt({ html: false, linkify: false });
markdownSyntax.inline.ruler.enableOnly(['backticks']);
const parseBackticks = markdownSyntax.inline.ruler.getRules('')[0];

export type FileHintPathResolver = (displayPath: string) => string | undefined;

export function decodeMaybeEncodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function getFileNameFromPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0];
  const parts = withoutQuery.split(/[\\/]/);
  return parts[parts.length - 1] || withoutQuery;
}

function isAbsoluteLikePath(path: string): boolean {
  const normalized = path.trim();
  return (
    normalized.startsWith('/')
    || /^~[\\/]/u.test(normalized)
    || normalized.startsWith('\\\\')
    || WINDOWS_ABSOLUTE_PATH_RE.test(normalized)
  );
}

export function createFileHintPathResolver(
  attachedFiles: AttachedFileMeta[],
): FileHintPathResolver | undefined {
  const nameToAbsolutePaths = new Map<string, string[]>();
  const attachedAbsolutePaths = new Set<string>();

  const addAbsolutePath = (candidate?: string): void => {
    if (!candidate) {
      return;
    }
    const normalized = candidate.trim();
    if (!isAbsoluteLikePath(normalized)) {
      return;
    }
    attachedAbsolutePaths.add(normalized);
    const fileName = getFileNameFromPath(normalized).toLowerCase();
    if (!fileName) {
      return;
    }
    const existingPaths = nameToAbsolutePaths.get(fileName);
    if (!existingPaths) {
      nameToAbsolutePaths.set(fileName, [normalized]);
      return;
    }
    if (!existingPaths.includes(normalized)) {
      existingPaths.push(normalized);
    }
  };

  for (const file of attachedFiles) {
    addAbsolutePath(file.filePath);
  }

  if (nameToAbsolutePaths.size === 0) {
    return undefined;
  }

  return (displayPath: string): string | undefined => {
    const normalized = displayPath.trim();
    if (!normalized) {
      return undefined;
    }
    if (isAbsoluteLikePath(normalized)) {
      return attachedAbsolutePaths.has(normalized) ? normalized : undefined;
    }
    const fileName = getFileNameFromPath(normalized).toLowerCase();
    const candidates = nameToAbsolutePaths.get(fileName);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    return candidates[0];
  };
}

function shouldMigrateLegacyLocalMarkdownHref(rawHref: string): boolean {
  const href = rawHref.trim().replace(/^<|>$/g, '');
  if (!href || href.startsWith('#') || href.startsWith('filehint:')) {
    return false;
  }

  const decoded = decodeMaybeEncodedPath(href);
  if (decoded.startsWith('//') || decoded.startsWith('/api/')
    || /^(https?:\/\/|mailto:|tel:|data:|javascript:)/i.test(decoded)) {
    return false;
  }

  if (/^file:\/\//i.test(decoded)) return true;
  const isWindowsAbsolutePath = WINDOWS_ABSOLUTE_PATH_RE.test(decoded);
  if (URI_SCHEME_RE.test(decoded) && !isWindowsAbsolutePath) {
    return false;
  }

  return true;
}

export function localPathFromMarkdownHref(href: string): string | undefined {
  if (!shouldMigrateLegacyLocalMarkdownHref(href)) return undefined;
  let normalized = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(href) ? href : decodeMaybeEncodedPath(href);
  if (/^file:\/\//i.test(normalized)) {
    try {
      const url = new URL(href);
      normalized = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== 'localhost') normalized = `\\\\${url.hostname}${normalized.replace(/\//g, '\\')}`;
      else if (/^\/[A-Za-z]:\//.test(normalized)) normalized = normalized.slice(1);
    } catch { return undefined; }
  }
  return normalized;
}

export function mapMediaDirectives(text: string, map: (reference: string) => string): string {
  return text.replace(MEDIA_DIRECTIVE_RE, (_marker, reference: string) => map(reference));
}

export function markdownMediaResourceId(source: string): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(source)))}`;
}

export function createAttachedMediaMatcher(files: ReadonlyArray<AttachedFileMeta>): (source: string) => boolean {
  const refs = new Set(files.flatMap((file) => [file.filePath, file.gatewayUrl, file.mediaReference].filter((ref): ref is string => !!ref)));
  const ids = new Set(files.flatMap((file) => file.resourceId ? [file.resourceId] : []));
  return (source) => refs.has(source) || (ids.size > 0 && ids.has(markdownMediaResourceId(source)));
}

export function mapMarkdownLinks(
  text: string,
  map: (full: string, label: string, href: string) => string,
  mapLiteral: (source: string, kind: 'code_inline' | 'code_block' | 'tag') => string = (source) => source,
  mapText: (source: string) => string = (source) => source,
): string {
  const mapInline = (chunk: string): string => {
    const state = new markdownSyntax.inline.State(chunk, markdownSyntax, {}, []);
    let output = '';
    let cursor = 0;
    const append = (start: number, end: number, replacement: string) => {
      output += mapText(chunk.slice(cursor, start)) + replacement;
      cursor = state.pos = end;
    };
    while (state.pos < chunk.length) {
      const pos = state.pos;
      const char = chunk[pos];
      if (char === '\\') {
        state.pos += 2;
        continue;
      }
      if (char === '`') {
        const tokenCount = state.tokens.length;
        parseBackticks(state, false);
        if (state.tokens.length > tokenCount && state.tokens.at(-1)?.type === 'code_inline') {
          append(pos, state.pos, mapLiteral(chunk.slice(pos, state.pos), 'code_inline'));
        }
        continue;
      }
      if (char === '<') {
        const tag = HTML_TAG_RE.exec(chunk.slice(pos)) ?? ENVELOPE_TAG_RE.exec(chunk.slice(pos));
        if (tag) {
          append(pos, pos + tag[0].length, mapLiteral(tag[0], 'tag'));
          continue;
        }
      }
      state.pos++;
      if (char !== '[' && char !== '!') continue;
      const match = /^!?\[[^\]\n]*\]\(/u.exec(chunk.slice(pos));
      if (!match) continue;
      const afterLabel = pos + match[0].length;
      const start = afterLabel + /^\s*/.exec(chunk.slice(afterLabel))![0].length;
      const destination = parseLinkDestination(chunk, start, chunk.length);
      if (!destination.ok) continue;
      const afterHref = destination.pos;
      let end = afterHref + /^\s*/.exec(chunk.slice(afterHref))![0].length;
      if (end > afterHref && chunk[end] !== ')') {
        const title = parseLinkTitle(chunk, end, chunk.length);
        if (!title.ok) continue;
        end = title.pos + /^\s*/.exec(chunk.slice(title.pos))![0].length;
      }
      if (chunk[end] !== ')') continue;
      const rawHref = chunk.slice(start, destination.pos);
      const href = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(rawHref) ? rawHref : destination.str;
      append(pos, end + 1, map(chunk.slice(pos, end + 1), match[0].slice(0, -1), href));
    }
    return output + mapText(chunk.slice(cursor));
  };

  // Keep source offsets and rendering intact, including CRLF; only inspect syntax.
  const syntaxText = text.replace(/\r\n?/g, (newline) => newline.length === 2 ? ' \n' : '\n');
  const lineOffsets = [0];
  for (const newline of syntaxText.matchAll(/\n/g)) lineOffsets.push(newline.index + 1);
  lineOffsets.push(text.length);
  const tokens: Token[] = [];
  markdownSyntax.block.parse(syntaxText, markdownSyntax, {}, tokens);
  const boundaries = new Set([0, text.length]);
  const codeBlocks = new Map<number, number>();
  for (const token of tokens) {
    if (!token.map) continue;
    const start = lineOffsets[token.map[0]];
    const end = lineOffsets[token.map[1]];
    boundaries.add(start).add(end);
    if (token.type === 'fence' || token.type === 'code_block') codeBlocks.set(start, end);
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  let output = '';
  for (let index = 0; index < offsets.length - 1; index++) {
    const start = offsets[index];
    const codeEnd = codeBlocks.get(start);
    const end = codeEnd ?? offsets[index + 1];
    const source = text.slice(start, end);
    output += codeEnd === undefined ? mapInline(source) : mapLiteral(source, 'code_block');
    while (offsets[index + 1] < end) index++;
  }
  return output;
}

export function migrateLegacyMarkdownFileLinks(
  text: string,
  resolveFileHintPath?: FileHintPathResolver,
  attachedFiles: ReadonlyArray<AttachedFileMeta> = [],
): string {
  const attached = createAttachedMediaMatcher(attachedFiles);
  return mapMarkdownLinks(text, (full, label, href) => {
    const normalized = localPathFromMarkdownHref(href);
    if (normalized !== undefined) {
      const resolvedPath = resolveFileHintPath?.(normalized) ?? normalized;
      return `${label.replace(/^!/, '')}(filehint:${encodeURIComponent(resolvedPath)})`;
    }
    return label.startsWith('!') && attached(href) ? full.slice(1) : full;
  });
}

export function linkifyFileHintsInMarkdown(
  text: string,
  resolveFileHintPath?: FileHintPathResolver,
  filePaths: readonly string[] = [],
): string {
  if (!text) return text;
  const paths = [...new Set(filePaths)].filter(Boolean).sort((left, right) => right.length - left.length)
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const fileHintPattern = [...paths, FILE_HINT_PATTERN].join('|');
  const inlineFileHint = new RegExp(`^(?:${fileHintPattern})$`, 'iu');
  const fileHints = new RegExp(
    String.raw`(^|[^\p{L}\p{N}_./\\-])(${fileHintPattern})(?=$|[^\p{L}\p{N}_./\\-])`, 'giu',
  );
  return mapMarkdownLinks(text, (full) => full, (source, kind) => {
    const inlinePath = kind === 'code_inline' ? /^(`+)([^`\n]+)\1$/u.exec(source)?.[2] : undefined;
    const resolvedPath = inlinePath && inlineFileHint.test(inlinePath) ? resolveFileHintPath?.(inlinePath) : undefined;
    return resolvedPath ? `[${source}](filehint:${encodeURIComponent(resolvedPath)})` : source;
  }, (chunk) => chunk.replace(fileHints, (full, prefix: string, path: string) => {
    if (!path || path.includes('://')) return full;
    const normalized = path.trim();
    const resolvedPath = resolveFileHintPath?.(normalized);
    if (!resolvedPath || !isAbsoluteLikePath(resolvedPath)) return full;
    return `${prefix}[${normalized}](filehint:${encodeURIComponent(resolvedPath)})`;
  }));
}
