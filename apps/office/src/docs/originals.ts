import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 500 * 1024 * 1024;

/** Upstream open-time originals: hash-deduplicated, encrypted bytes kept as-is. */
export function createDocsOriginals(storagePath: string) {
  const root = join(storagePath, 'docs', 'originals');
  let pending: Promise<void> = Promise.resolve();
  return {
    archive(file: string, hash: string): Promise<void> {
      const next = pending.catch(() => {}).then(async () => {
        const source = await stat(file);
        if (source.size > MAX_BYTES) return;
        await mkdir(root, { recursive: true, mode: 0o700 });
        const target = join(root, `${hash}.docx`);
        try { await copyFile(file, target, constants.COPYFILE_EXCL); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const files = await Promise.all((await readdir(root)).map(async name => {
          const path = join(root, name);
          return { path, ...await stat(path) };
        }));
        let total = files.reduce((sum, item) => sum + item.size, 0);
        for (const item of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
          if (total <= MAX_BYTES) break;
          await rm(item.path);
          total -= item.size;
        }
      });
      pending = next;
      return next;
    }
  };
}
