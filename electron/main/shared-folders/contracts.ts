// Keep text JSON escaping plus the encrypted/base64 request below the network's 64 KiB limit.
export const SHARED_FOLDER_WRITE_MAX_LENGTH = 7 * 1024;
export const SHARED_FOLDER_WRITE_MAX_BYTES = 32 * 1024;
export const SHARED_FOLDER_READ_MAX_BYTES = 64 * 1024;
export const SHARED_FOLDER_PATH_MAX_LENGTH = 1024;
export const SHARED_FOLDER_LIST_MAX_LIMIT = 100;
export const SHARED_FOLDER_CURSOR_TTL_MS = 60_000;
export const SHARED_FOLDER_MAX_CURSORS = 32;

export type FolderOutcome = 'invalid-input' | 'forbidden-path' | 'not-found' | 'not-file' | 'not-directory'
  | 'not-text' | 'too-large' | 'cursor-expired' | 'cursor-mismatch' | 'busy' | 'cancelled' | 'unavailable' | 'outcome-unknown';
export class FolderError extends Error {
  constructor(readonly outcome: FolderOutcome) { super(outcome); }
}
export interface FolderEntry { name: string; kind: 'file' | 'directory'; relativePath: string }

export function isValidComponent(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== '.' && value !== '..'
    && !/[\\/:<>"|?*]/u.test(value) && !Array.from(value).some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127) && !/[. ]$/u.test(value)
    && !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value)
    && !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));
}

export function relativeComponents(value: unknown, allowRoot = false): string[] {
  if (typeof value !== 'string' || value.length > SHARED_FOLDER_PATH_MAX_LENGTH) throw new FolderError('invalid-input');
  if (allowRoot && value === '') return [];
  const parts = value.split('/');
  if (parts.length > 32 || !parts.every(isValidComponent)) throw new FolderError('invalid-input');
  return parts;
}

const PROTECTED_NAMES = new Set([
  '.git', '.claude', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.config', '.codex', '.cursor', '.vscode',
  '.mcp.json', 'mcp.json', 'settings.json', 'settings.local.json', '.claude.json', 'claude.json',
  '.gitconfig', '.gitmodules', '.git-credentials', '.npmrc', '.yarnrc', '.netrc',
  '.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin',
  'credentials', 'credentials.json', 'credential', 'auth.json', 'authorized_keys', 'known_hosts',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'ntuser.dat', 'config.fish',
]);

export function isProtectedComponent(value: string, directory = false): boolean {
  const lower = value.toLowerCase();
  return PROTECTED_NAMES.has(lower) || /^\.env(?:\.|$)/u.test(lower)
    || (!directory && /\.(?:pem|key|p12|pfx)$/u.test(lower)) || /^(?:microsoft\..*\.)?profile\.ps1$/u.test(lower)
    || lower.startsWith('.matcha-folder-write-');
}

export function assertText(text: string): void {
  // UTF-8 decoding is checked separately; text rejects NUL and binary control characters, not replacement characters in actual text.
  if (Array.from(text).some((char) => {
    const code = char.codePointAt(0)!;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff);
  })) throw new FolderError('not-text');
}

export function decodeText(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new FolderError('not-text'); }
  assertText(text);
  return text;
}
