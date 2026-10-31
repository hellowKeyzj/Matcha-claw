import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { getRuntimeHostStateDir } from '../../utils/paths';

const executeFile = promisify(execFile);
const DESCRIPTOR_NAME = 'app-plugin-agent.json';

export async function publishAppPluginMcp(input: {
  root: string;
  port: number;
  token: string;
}): Promise<() => Promise<void>> {
  if (!isAbsolute(input.root)) throw new Error('App plugin MCP root must be absolute.');
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  if (!(await lstat(input.root)).isDirectory()) throw new Error('App plugin MCP root must be a regular directory.');
  const identity = randomUUID();
  const directory = join(input.root, identity);
  await mkdir(directory, { mode: 0o700 });
  const published: { path: string; contents: string }[] = [];
  const retire = async () => {
    for (const { path, contents } of published.reverse()) {
      try {
        if (await readFile(path, 'utf8') === contents) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try { await rmdir(directory); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  };
  try {
    if (process.platform === 'win32') {
      const systemDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      const { stdout } = await executeFile(join(systemDirectory, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
      const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error('App plugin MCP could not determine the private directory owner.');
      await executeFile(join(systemDirectory, 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
    } else {
      await chmod(directory, 0o700);
    }
    const discovery = join(directory, 'discovery.json');
    const contents = JSON.stringify({ identity, port: input.port, token: input.token });
    await writeFile(discovery, contents, { flag: 'wx', mode: 0o600 });
    published.push({ path: discovery, contents });
    const descriptor = JSON.stringify({ discovery });
    const stateDir = getRuntimeHostStateDir();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, DESCRIPTOR_NAME);
    const temporary = `${path}.${identity}.tmp`;
    try {
      await writeFile(temporary, descriptor, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      });
      throw error;
    }
    published.push({ path, contents: descriptor });
    return retire;
  } catch (error) {
    await retire();
    throw error;
  }
}
