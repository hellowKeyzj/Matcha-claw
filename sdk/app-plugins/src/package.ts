import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';
import { zipSync } from 'fflate';
import type { AppPluginManifest } from './manifest.js';

export const MAX_APP_PLUGIN_ZIP_BYTES = 64 * 1024 * 1024;
export const MAX_APP_PLUGIN_CONTENT_BYTES = 128 * 1024 * 1024;
export const MAX_APP_PLUGIN_FILE_BYTES = 96 * 1024 * 1024;
export const MAX_APP_PLUGIN_FILES = 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export class AppPluginError extends Error {
  constructor(readonly code: 'invalid_package' | 'conflict' | 'not_found' | 'closed' | 'busy', message: string) {
    super(message);
    this.name = 'AppPluginError';
  }
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AppPluginError('invalid_package', message);
}

export function requireObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValid(!!value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.');
  const record = value as Record<string, unknown>;
  requireValid(Object.keys(record).every((key) => keys.includes(key)), 'Unsupported field in app plugin request or manifest.');
  return record;
}

function requireText(value: unknown, maximum: number, label: string): asserts value is string {
  requireValid(typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32), `Invalid ${label}.`);
}

function optionalText(value: unknown, maximum: number, label: string): void {
  if (value !== undefined) requireText(value, maximum, label);
}

export function requirePluginId(value: unknown): asserts value is string {
  requireValid(typeof value === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) && value.length <= 96, 'Invalid app plugin identifier.');
  requireValid(!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value), 'Reserved app plugin identifier.');
}

export function requireDigest(value: unknown): asserts value is string {
  requireValid(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid app plugin digest.');
}

function requirePackagePath(value: unknown): asserts value is string {
  requireValid(typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value), 'Invalid package file path.');
  requireValid(value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'
    && !part.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)), 'Package path contains an alias or reserved name.');
}

function requireBoundedObject(value: unknown, label: string): Record<string, unknown> {
  requireValid(!!value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new AppPluginError('invalid_package', `${label} must be JSON serializable.`); }
  requireValid(Buffer.byteLength(json, 'utf8') <= MAX_SCHEMA_BYTES, `${label} must be at most ${MAX_SCHEMA_BYTES} bytes.`);
  return value as Record<string, unknown>;
}

export function validateAppPluginManifest(value: unknown): AppPluginManifest {
  const manifest = requireObject(value, ['schemaVersion', 'id', 'name', 'version', 'description', 'apiVersion', 'minSdkVersion', 'main', 'backend', 'background', 'contributes']);
  requireValid(manifest.schemaVersion === 1, 'Only app plugin manifest schemaVersion 1 is supported.');
  requirePluginId(manifest.id);
  requireText(manifest.name, 120, 'plugin name');
  requireText(manifest.version, 64, 'plugin version');
  requireValid(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version), 'Plugin version must be a semantic version.');
  optionalText(manifest.description, 2000, 'plugin description');
  requireValid(manifest.apiVersion === undefined || manifest.apiVersion === 1, 'Only app plugin apiVersion 1 is supported.');
  requireValid(manifest.minSdkVersion === undefined || (typeof manifest.minSdkVersion === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(manifest.minSdkVersion)), 'Minimum SDK version must use major.minor.patch.');
  if (manifest.main !== undefined) {
    requirePackagePath(manifest.main);
    requireValid(manifest.apiVersion === 1 && /\.(?:cjs|js)$/i.test(manifest.main), 'Plugin main requires apiVersion 1 and a package CommonJS .cjs or .js file.');
  }
  if (manifest.backend !== undefined) {
    requireValid(manifest.main === undefined && manifest.apiVersion === 1, 'Plugin backend requires apiVersion 1 and cannot be combined with main.');
    const backend = requireObject(manifest.backend, ['language', 'entry', 'pythonVersion', 'platform', 'arch']);
    requirePackagePath(backend.entry);
    if (backend.language === 'python') {
      requireObject(backend, ['language', 'entry', 'pythonVersion']);
      requireValid(backend.pythonVersion === '3.12' && /\.py$/i.test(backend.entry), 'Python backend requires pythonVersion 3.12 and a package .py entry.');
    } else {
      requireObject(backend, ['language', 'entry', 'platform', 'arch']);
      requireValid(backend.language === 'rust' && ['win32', 'darwin', 'linux'].includes(backend.platform as string)
        && ['x64', 'arm64'].includes(backend.arch as string), 'Rust backend requires a supported platform and architecture.');
    }
  }
  requireValid(manifest.background === undefined || (manifest.background === true && (manifest.main !== undefined || manifest.backend !== undefined)), 'Background activation requires a declared backend and background: true.');
  const contributes = requireObject(manifest.contributes, ['readers', 'connectors', 'applications', 'chat', 'tools']);
  for (const key of ['readers', 'connectors', 'applications', 'tools'] as const) {
    requireValid(contributes[key] === undefined || (Array.isArray(contributes[key]) && contributes[key].length <= 32), `At most 32 ${key} are supported.`);
  }
  const readers = (contributes.readers ?? []) as unknown[];
  const connectors = (contributes.connectors ?? []) as unknown[];
  const applications = (contributes.applications ?? []) as unknown[];
  const tools = (contributes.tools ?? []) as unknown[];
  requireValid(readers.length + connectors.length + applications.length + tools.length > 0, 'An app plugin must contribute a reader, connector, application, or tool.');
  requireValid(applications.length === 0 || manifest.apiVersion === 1, 'Applications require apiVersion 1.');
  if (contributes.chat !== undefined) {
    const chat = requireObject(contributes.chat, ['contextTag']);
    requireValid(typeof chat.contextTag === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.exec(chat.contextTag)?.[0] === chat.contextTag, 'Invalid chat context tag.');
    requireValid(applications.length > 0, 'Chat contributions require an application.');
  }
  requireValid(tools.length === 0 || manifest.main !== undefined || manifest.backend !== undefined, 'Plugin tools require a declared backend entry.');
  const readerIds = new Set<string>();
  for (const value of readers) {
    const reader = requireObject(value, ['id', 'name', 'entry', 'extensions', 'mimeTypes', 'contentType', 'source', 'priority']);
    requirePluginId(reader.id);
    requireValid(!readerIds.has(reader.id), 'Duplicate reader identifier.');
    readerIds.add(reader.id);
    requireText(reader.name, 120, 'reader name');
    requirePackagePath(reader.entry);
    requireValid(/\.html$/i.test(reader.entry), 'Reader entry must be a package HTML file.');
    requireValid(Array.isArray(reader.extensions) && reader.extensions.length > 0 && reader.extensions.length <= 64
      && reader.extensions.every((extension) => typeof extension === 'string' && /^\.[a-z0-9][a-z0-9.+-]{0,31}$/.test(extension))
      && new Set(reader.extensions).size === reader.extensions.length, 'Reader extensions must be unique lowercase extensions starting with a dot.');
    requireValid(reader.mimeTypes === undefined || (Array.isArray(reader.mimeTypes) && reader.mimeTypes.length <= 64
      && reader.mimeTypes.every((mime) => typeof mime === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/.test(mime))
      && new Set(reader.mimeTypes).size === reader.mimeTypes.length), 'Invalid reader MIME types.');
    requireValid(['text', 'code', 'markdown', 'html', 'image', 'document', 'binary'].includes(reader.contentType as string), 'Invalid reader content type.');
    requireValid(reader.source === 'text' || reader.source === 'binary', 'Invalid reader source.');
    requireValid(reader.priority === undefined || (typeof reader.priority === 'number' && Number.isInteger(reader.priority)
      && Math.abs(reader.priority) <= 1000), 'Reader priority must be an integer between -1000 and 1000.');
  }
  const connectorIds = new Set<string>();
  for (const value of connectors) {
    const connector = requireObject(value, ['id', 'displayName', 'description', 'kind', 'defaultUrl', 'defaultTransport', 'fieldHints']);
    requirePluginId(connector.id);
    requireValid(!connectorIds.has(connector.id), 'Duplicate connector identifier.');
    connectorIds.add(connector.id);
    requireText(connector.displayName, 120, 'connector name');
    optionalText(connector.description, 2000, 'connector description');
    requireValid(connector.kind === 'mcp-http', 'App plugin connectors only support declarative MCP HTTP.');
    requireValid(connector.defaultTransport === undefined || connector.defaultTransport === 'streamable-http'
      || connector.defaultTransport === 'sse', 'Unsupported MCP HTTP transport.');
    if (connector.defaultUrl !== undefined) {
      requireText(connector.defaultUrl, 2048, 'connector URL');
      let url: URL;
      try { url = new URL(connector.defaultUrl); } catch { throw new AppPluginError('invalid_package', 'Invalid connector URL.'); }
      requireValid((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash, 'Connector URL must be HTTP(S) without credentials or fragment.');
    }
    if (connector.fieldHints !== undefined) {
      const hints = requireObject(connector.fieldHints, ['url', 'transport', 'connectionTimeoutMs', 'headers', 'secretHeaders']);
      for (const value of Object.values(hints)) {
        const hint = requireObject(value, ['label', 'description', 'placeholder']);
        optionalText(hint.label, 120, 'field label');
        optionalText(hint.description, 1000, 'field description');
        optionalText(hint.placeholder, 500, 'field placeholder');
      }
    }
  }
  const applicationIds = new Set<string>();
  for (const value of applications) {
    const application = requireObject(value, ['id', 'name', 'entry', 'placement', 'scope', 'imageEditor']);
    requirePluginId(application.id);
    requireValid(!applicationIds.has(application.id), 'Duplicate application identifier.');
    applicationIds.add(application.id);
    requireText(application.name, 120, 'application name');
    requirePackagePath(application.entry);
    requireValid(/\.html$/i.test(application.entry), 'Application entry must be a package HTML file.');
    requireValid(application.placement === undefined || ['page', 'chat-panel', 'both'].includes(application.placement as string), 'Invalid application placement.');
    requireValid(application.scope === undefined || application.scope === 'session' || application.scope === 'workspace', 'Invalid application scope.');
    if (application.imageEditor !== undefined) {
      const editor = requireObject(application.imageEditor, ['label', 'tool', 'translations']);
      requireText(editor.label, 80, 'image editor label');
      if (editor.translations !== undefined) {
        const translations = requireObject(editor.translations, ['en', 'zh', 'ja', 'ru']);
        for (const label of Object.values(translations)) requireText(label, 80, 'translated image editor label');
      }
      requireValid(application.placement === 'chat-panel' || application.placement === 'both', 'Image editors require chat-panel placement.');
      requireValid(tools.some((value) => !!value && typeof value === 'object' && (value as Record<string, unknown>).name === editor.tool), 'Image editor tool must be declared by the plugin.');
    }
  }
  const toolNames = new Set<string>();
  for (const value of tools) {
    const tool = requireObject(value, ['name', 'description', 'inputSchema', 'outputSchema', '_meta']);
    requireValid(typeof tool.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tool.name), 'Tool names must be local identifiers of at most 64 letters, digits, underscores, or hyphens.');
    requireValid(!toolNames.has(tool.name), 'Duplicate tool name.');
    toolNames.add(tool.name);
    requireText(tool.description, 2000, 'tool description');
    requireValid(requireBoundedObject(tool.inputSchema, 'Tool input schema').type === 'object', 'Tool input schema must have type object.');
    if (tool.outputSchema !== undefined) requireValid(requireBoundedObject(tool.outputSchema, 'Tool output schema').type === 'object', 'Tool output schema must have type object.');
    if (tool._meta !== undefined) requireBoundedObject(tool._meta, 'Tool metadata');
  }
  requireValid(Buffer.byteLength(JSON.stringify(manifest), 'utf8') <= MAX_MANIFEST_BYTES, 'Plugin manifest is too large.');
  return structuredClone(manifest) as unknown as AppPluginManifest;
}

export interface ValidatedAppPluginPackage {
  readonly manifest: AppPluginManifest;
  readonly digest: string;
  readonly bytes: Buffer;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

function decodeText(bytes: Uint8Array): string {
  try { return utf8.decode(bytes); } catch { throw new AppPluginError('invalid_package', 'Package files must contain valid UTF-8.'); }
}

function validatePackageFiles(files: ReadonlyMap<string, Uint8Array>): AppPluginManifest {
  requireValid(files.size > 0 && files.size <= MAX_APP_PLUGIN_FILES, `Package must contain 1 to ${MAX_APP_PLUGIN_FILES} files.`);
  const manifestBytes = files.get('manifest.json');
  requireValid(manifestBytes && manifestBytes.length <= MAX_MANIFEST_BYTES, 'Package must contain a bounded root manifest.json.');
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(decodeText(manifestBytes)); } catch { throw new AppPluginError('invalid_package', 'Package manifest JSON is invalid.'); }
  const manifest = validateAppPluginManifest(manifestValue);
  const readerEntries = new Set(manifest.contributes.readers?.map((reader) => reader.entry) ?? []);
  const applicationEntries = new Set(manifest.contributes.applications?.map((application) => application.entry) ?? []);
  const backendEntry = manifest.backend?.entry;
  const entries = new Set([...readerEntries, ...applicationEntries, ...(manifest.main ? [manifest.main] : []), ...(backendEntry ? [backendEntry] : [])]);
  const trusted = manifest.apiVersion === 1 && (manifest.main !== undefined || backendEntry !== undefined || applicationEntries.size > 0);
  if (manifest.backend?.language === 'python') {
    requireValid(files.has('pyproject.toml') === files.has('uv.lock'), 'Python dependencies require both root pyproject.toml and uv.lock.');
    for (const name of ['pyproject.toml', 'uv.lock']) {
      const bytes = files.get(name);
      if (bytes) requireValid(decodeText(bytes).length > 0, 'Python dependency files must be nonempty UTF-8.');
    }
  }
  const aliases = new Set<string>();
  let total = 0;
  for (const [name, bytes] of files) {
    requirePackagePath(name);
    const alias = name.toLowerCase();
    requireValid(!aliases.has(alias), 'Package contains duplicate or aliased paths.');
    aliases.add(alias);
    requireValid(trusted || name === 'manifest.json' || readerEntries.has(name), 'Package files must be manifest.json or declared reader HTML entries.');
    requireValid(bytes.length <= MAX_APP_PLUGIN_FILE_BYTES, `A package file must be at most ${MAX_APP_PLUGIN_FILE_BYTES / 1024 / 1024} MiB.`);
    total += bytes.length;
    requireValid(total <= MAX_APP_PLUGIN_CONTENT_BYTES, `Unpacked package must be at most ${MAX_APP_PLUGIN_CONTENT_BYTES / 1024 / 1024} MiB.`);
    if (entries.has(name)) {
      requireValid(bytes.length > 0, 'Package entries must be nonempty.');
      if (name === backendEntry && manifest.backend?.language === 'rust') continue;
      const text = decodeText(bytes);
      requireValid(text.length > 0 && !text.includes('\0'), 'Package HTML and main entries must be nonempty UTF-8.');
      if (readerEntries.has(name)) {
        // Packaging diagnostics only. The opaque reader host, not an HTML regex, enforces executable-content isolation.
        requireValid(!/<(?:base|iframe|frame|object|embed|link)\b/i.test(text)
          && !/<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/i.test(text)
          && !/<script\b[^>]*\bsrc\s*=/i.test(text), 'Reader HTML must be self-contained: inline scripts/styles and no nested frames, external scripts, or refresh.');
      }
    }
  }
  requireValid([...entries].every((entry) => files.has(entry)), 'A declared package entry is missing.');
  for (const name of files.keys()) {
    const segments = name.toLowerCase().split('/');
    segments.pop();
    while (segments.length > 0) {
      requireValid(!aliases.has(segments.join('/')), 'Package paths conflict as files and directories.');
      segments.pop();
    }
  }
  return manifest;
}

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  size: number;
  checksum: number;
  dataStart: number;
}

function validateExtra(bytes: Buffer, start: number, end: number): void {
  while (start < end) {
    requireValid(start + 4 <= end, 'Malformed ZIP extra field.');
    const kind = bytes.readUInt16LE(start);
    const size = bytes.readUInt16LE(start + 2);
    requireValid(kind !== 1 && kind !== 0x7075 && kind !== 0x6375 && start + 4 + size <= end, 'ZIP64 and alternate ZIP paths are not supported.');
    start += 4 + size;
  }
}

function readZipDirectory(bytes: Buffer): ZipEntry[] {
  requireValid(bytes.length >= 22 && bytes.length <= MAX_APP_PLUGIN_ZIP_BYTES, `ZIP package must be at most ${MAX_APP_PLUGIN_ZIP_BYTES / 1024 / 1024} MiB.`);
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
  requireValid(end >= minimum, 'ZIP end directory is missing.');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  requireValid(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0
    && bytes.readUInt16LE(end + 8) === count && count > 0 && count <= MAX_APP_PLUGIN_FILES
    && directoryStart + directorySize === end, 'Split, ZIP64, or oversized ZIP directory is not supported.');
  const entries: ZipEntry[] = [];
  const aliases = new Set<string>();
  const spans: { start: number; end: number }[] = [];
  let cursor = directoryStart;
  let total = 0;
  for (let index = 0; index < count; index++) {
    requireValid(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'Malformed ZIP central directory.');
    const flags = bytes.readUInt16LE(cursor + 8);
    const compression = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const attributes = bytes.readUInt32LE(cursor + 38);
    const offset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    requireValid(next <= end && bytes.readUInt16LE(cursor + 6) <= 20 && bytes.readUInt16LE(cursor + 34) === 0
      && (flags & ~0x080e) === 0 && (compression === 0 || compression === 8)
      && (compression === 8 || (flags & 6) === 0), 'Unsupported ZIP entry flags or compression.');
    const fileType = (attributes >>> 16) & 0xf000;
    requireValid((fileType === 0 || fileType === 0x8000) && (attributes & 0x18) === 0, 'ZIP links, directories, and special files are not allowed.');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeText(nameBytes);
    requirePackagePath(name);
    requireValid(!aliases.has(name.toLowerCase()), 'Duplicate or aliased ZIP entry.');
    aliases.add(name.toLowerCase());
    requireValid(size <= MAX_APP_PLUGIN_FILE_BYTES && (name !== 'manifest.json' || size <= MAX_MANIFEST_BYTES), `ZIP entries must be at most ${MAX_APP_PLUGIN_FILE_BYTES / 1024 / 1024} MiB and manifest.json at most ${MAX_MANIFEST_BYTES / 1024} KiB.`);
    total += size;
    requireValid(total <= MAX_APP_PLUGIN_CONTENT_BYTES, `Unpacked ZIP must be at most ${MAX_APP_PLUGIN_CONTENT_BYTES / 1024 / 1024} MiB.`);
    validateExtra(bytes, cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    requireValid(offset + 30 <= directoryStart && bytes.readUInt32LE(offset) === 0x04034b50, 'Malformed ZIP local header.');
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const localExtraLength = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    requireValid(dataStart + compressedSize <= directoryStart && bytes.readUInt16LE(offset + 4) <= 20
      && bytes.readUInt16LE(offset + 6) === flags && bytes.readUInt16LE(offset + 8) === compression
      && nameBytes.equals(bytes.subarray(offset + 30, offset + 30 + localNameLength)), 'ZIP central and local headers disagree.');
    validateExtra(bytes, offset + 30 + localNameLength, dataStart);
    let dataEnd = dataStart + compressedSize;
    if (flags & 8) {
      if (dataEnd + 4 <= directoryStart && bytes.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
      requireValid(dataEnd + 12 <= directoryStart && bytes.readUInt32LE(dataEnd) === checksum
        && bytes.readUInt32LE(dataEnd + 4) === compressedSize && bytes.readUInt32LE(dataEnd + 8) === size, 'Invalid ZIP data descriptor.');
      dataEnd += 12;
    } else {
      requireValid(bytes.readUInt32LE(offset + 14) === checksum && bytes.readUInt32LE(offset + 18) === compressedSize
        && bytes.readUInt32LE(offset + 22) === size, 'ZIP local sizes disagree.');
    }
    requireValid(compression !== 0 || compressedSize === size, 'Invalid stored ZIP entry size.');
    spans.push({ start: offset, end: dataEnd });
    entries.push({ name, compression, compressedSize, size, checksum, dataStart });
    cursor = next;
  }
  requireValid(cursor === end, 'Unexpected ZIP central directory data.');
  for (const name of aliases) {
    const segments = name.split('/');
    segments.pop();
    while (segments.length > 0) {
      requireValid(!aliases.has(segments.join('/')), 'ZIP paths conflict as files and directories.');
      segments.pop();
    }
  }
  spans.sort((left, right) => left.start - right.start);
  let position = 0;
  for (const span of spans) {
    requireValid(span.start === position, 'ZIP entries overlap or contain unlisted data.');
    position = span.end;
  }
  requireValid(position === directoryStart, 'ZIP contains unlisted local entries.');
  return entries;
}

const decompress = promisify(inflateRaw);

export function verifyAppPluginPackageDigest(bytes: Buffer, expectedDigest?: string): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error('App plugin package integrity check failed.');
  return digest;
}

export async function readAppPluginPackage(bytes: Buffer, expectedDigest?: string): Promise<ValidatedAppPluginPackage> {
  const digest = verifyAppPluginPackageDigest(bytes, expectedDigest);
  // Inspect the entire central/local directory before allocating any inflated output.
  const entries = readZipDirectory(bytes);
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let content: Buffer;
    try {
      content = entry.compression === 0 ? Buffer.from(compressed)
        : await decompress(compressed, { maxOutputLength: entry.size + 1 });
    } catch { throw new AppPluginError('invalid_package', 'ZIP entry failed bounded decompression.'); }
    requireValid(content.length === entry.size && crc32(content) === entry.checksum, 'ZIP entry size or checksum is invalid.');
    files.set(entry.name, content);
  }
  return { manifest: validatePackageFiles(files), digest, bytes, files };
}

export async function decodeAppPluginPackage(packageBase64: string): Promise<ValidatedAppPluginPackage> {
  requireValid(typeof packageBase64 === 'string' && packageBase64.length > 0
    && packageBase64.length <= 4 * Math.ceil(MAX_APP_PLUGIN_ZIP_BYTES / 3)
    && packageBase64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(packageBase64), 'Invalid or oversized package base64.');
  const bytes = Buffer.from(packageBase64, 'base64');
  requireValid(bytes.toString('base64') === packageBase64, 'Noncanonical package base64.');
  return readAppPluginPackage(bytes);
}

export async function buildAppPluginPackage(input: { manifest: AppPluginManifest; files: Record<string, string> }): Promise<ValidatedAppPluginPackage> {
  const manifest = validateAppPluginManifest(input.manifest);
  requireValid(!!input.files && typeof input.files === 'object' && !Array.isArray(input.files), 'Build files must be an object.');
  requireValid(Object.keys(input.files).length < MAX_APP_PLUGIN_FILES, `Build must contain fewer than ${MAX_APP_PLUGIN_FILES} files before manifest.json.`);
  const files = new Map<string, Uint8Array>([['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')]]);
  let total = files.get('manifest.json')!.length;
  for (const [name, text] of Object.entries(input.files)) {
    requirePackagePath(name);
    requireValid(name !== 'manifest.json' && typeof text === 'string' && text.length <= MAX_APP_PLUGIN_FILE_BYTES, 'Build files must be UTF-8 text strings; use ZIP import for binary assets.');
    const bytes = Buffer.from(text, 'utf8');
    requireValid(bytes.length <= MAX_APP_PLUGIN_FILE_BYTES && bytes.toString('utf8') === text, `Build text must be valid UTF-8 and at most ${MAX_APP_PLUGIN_FILE_BYTES / 1024 / 1024} MiB.`);
    total += bytes.length;
    requireValid(total <= MAX_APP_PLUGIN_CONTENT_BYTES, `Build content must be at most ${MAX_APP_PLUGIN_CONTENT_BYTES / 1024 / 1024} MiB.`);
    files.set(name, bytes);
  }
  const validatedManifest = validatePackageFiles(files);
  const zipFiles: Record<string, Uint8Array> = Object.create(null);
  for (const [name, bytes] of files) zipFiles[name] = bytes;
  const zipped = zipSync(zipFiles, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
  const bytes = Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  requireValid(bytes.length <= MAX_APP_PLUGIN_ZIP_BYTES, `ZIP package must be at most ${MAX_APP_PLUGIN_ZIP_BYTES / 1024 / 1024} MiB.`);
  return { manifest: validatedManifest, digest: verifyAppPluginPackageDigest(bytes), bytes, files };
}
