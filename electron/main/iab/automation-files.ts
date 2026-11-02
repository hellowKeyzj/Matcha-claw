import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { DownloadFile } from './automation-port';
import type { IabCdpLease, IabDownloads, IabLog } from './contracts';
import type { WebContents } from 'electron';
import path from 'node:path';
import type { IabTrustedContext } from './contracts';
import { iabError } from './error';
import { replaceFileAtomically } from './persistence';

export async function resolveWorkspacePath(context: IabTrustedContext, requested: string, output: boolean): Promise<string> {
  context.assertCurrent();
  if (!context.workspaceDir) throw iabError('IAB_WORKSPACE_REQUIRED', 'A verified host workspace is required for browser files');
  const root = await realpath(context.workspaceDir);
  const resolved = path.resolve(root, requested);
  const target = output ? path.join(await realpath(path.dirname(resolved)), path.basename(resolved)) : await realpath(resolved);
  assertWithinWorkspace(root, target);
  if (!output && !(await stat(target)).isFile()) throw iabError('IAB_UPLOAD_FILE_INVALID', 'Browser upload must refer to a regular file');
  return target;
}

function assertWithinWorkspace(root: string, target: string, allowRoot = false): void {
  const relative = path.relative(root, target);
  if ((!relative && !allowRoot) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw iabError('IAB_WORKSPACE_PATH_FORBIDDEN', 'Browser file must stay inside the verified workspace');
  if (relative.split(path.sep).some((segment) => ['.git', '.claude', '.ssh', '.aws', '.gnupg'].includes(segment.toLowerCase()))) throw iabError('IAB_WORKSPACE_PATH_FORBIDDEN', 'Browser files cannot access protected workspace directories');
}

export async function prepareWorkspaceDirectory(context: IabTrustedContext, requested: string): Promise<string> {
  if (!context.workspaceDir) throw iabError('IAB_WORKSPACE_REQUIRED', 'A verified host workspace is required for browser files');
  const root = await realpath(context.workspaceDir);
  const resolved = path.resolve(root, requested);
  assertWithinWorkspace(root, resolved, true);
  let ancestor = resolved;
  const missing: string[] = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  assertWithinWorkspace(root, ancestor, true);
  const directory = path.join(ancestor, ...missing);
  assertWithinWorkspace(root, directory, true);
  context.assertCurrent();
  await mkdir(directory, { recursive: true });
  const final = await realpath(directory);
  assertWithinWorkspace(root, final, true);
  return final;
}

export async function saveWorkspaceFile(context: IabTrustedContext, requested: string, buffer: Buffer, signal: AbortSignal, atomic = false): Promise<string> {
  await prepareWorkspaceDirectory(context, path.dirname(requested));
  const target = await resolveWorkspacePath(context, requested, true);
  const check = () => { signal.throwIfAborted(); context.assertCurrent(); };
  check();
  if (atomic) await replaceFileAtomically(target, buffer, check);
  else {
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (existing && (!existing.isFile() || existing.nlink !== 1)) throw iabError('IAB_OUTPUT_FILE_INVALID', 'Browser output must refer to a regular file without hard links');
    check();
    const file = await open(target, constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1) throw iabError('IAB_OUTPUT_FILE_INVALID', 'Browser output must refer to a regular file without hard links');
      check(); await file.truncate(0);
      check(); await file.writeFile(buffer, { signal });
    } finally { await file.close(); }
  }
  return target;
}

export async function finishWorkspaceDownload(context: IabTrustedContext, file: DownloadFile, lease: IabCdpLease, contents: WebContents, downloads: IabDownloads, signal: AbortSignal, log?: IabLog): Promise<string> {
  if (!/^[A-Za-z0-9-]+$/u.test(file.guid)) throw iabError('IAB_DOWNLOAD_GUID_INVALID', 'Invalid native download identifier');
  const source = await resolveWorkspacePath(context, path.join(file.directory, file.guid), false);
  const destination = await resolveWorkspacePath(context, file.savePath ?? path.join(file.directory, safeFilename(file.filename)), true);
  if ((await stat(source)).size !== file.bytes) throw iabError('IAB_DOWNLOAD_SIZE_MISMATCH', 'Native download byte count does not match the captured file');
  const check = () => { signal.throwIfAborted(); context.assertCurrent(); };
  check();
  if (source !== destination) {
    const deadline = Date.now() + 2_000;
    for (;;) {
      check();
      try { await rename(source, destination); break; }
      catch (error) {
        check();
        const code = (error as NodeJS.ErrnoException).code;
        if (Date.now() >= deadline || code !== 'EPERM' && code !== 'ENOENT') throw new Error(`Downloaded file is at '${source}' but rename to '${destination}' failed`, { cause: error });
        await delay(100, undefined, { signal });
      }
    }
  }
  check();
  try { await downloads.reportDownloadSaved(contents, lease.id, file.guid, destination, check); }
  catch (error) {
    check();
    log?.warn(`[iab] Download history path confirmation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return destination;
}

function safeFilename(value: string): string {
  let name = path.posix.basename(value.replace(/\\/gu, '/')).replace(/\p{Cc}/gu, '');
  if (process.platform === 'win32') {
    name = name.replace(/[<>:"|?*]/gu, '_').replace(/[ .]+$/gu, '');
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name)) name = `_${name}`;
  }
  return !name || name === '.' || name === '..' ? 'download' : name;
}
