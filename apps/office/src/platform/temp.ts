import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withTemp<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'matcha-office-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeTemp(directory: string, name: string, bytes: Uint8Array): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}
