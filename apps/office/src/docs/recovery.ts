import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface RecoveryCopy {
  revision: number;
  data: string;
}

export function createDocsRecovery(storagePath: string) {
  const root = join(storagePath, 'docs', 'recovery');
  const epochs = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();
  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    pending.set(id, next);
    void next.finally(() => { if (pending.get(id) === next) pending.delete(id); }).catch(() => {});
    return next;
  }
  const pathFor = (id: string) => join(root, `${createHash('sha256').update(id).digest('hex')}.json`);

  async function clear(id: string): Promise<void> {
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    await serial(id, () => rm(pathFor(id), { force: true }));
  }

  return {
    clear,
    epoch: (id: string) => epochs.get(id) ?? 0,
    async read(id: string): Promise<RecoveryCopy | null> {
      try {
        return JSON.parse(await readFile(pathFor(id), 'utf8')) as RecoveryCopy;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(id: string, revision: number, bytes: Uint8Array, epoch: number): Promise<boolean> {
      return serial(id, async () => {
        if ((epochs.get(id) ?? 0) !== epoch) return false;
        await mkdir(root, { recursive: true, mode: 0o700 });
        const temporary = join(root, `.${randomUUID()}.json`);
        try {
          await writeFile(temporary, JSON.stringify({ revision, data: Buffer.from(bytes).toString('base64') }), { mode: 0o600 });
          if ((epochs.get(id) ?? 0) !== epoch) return false;
          await rename(temporary, pathFor(id));
          // A queued clear removes this copy before any newer recovery write can run.
          return (epochs.get(id) ?? 0) === epoch;
        } finally {
          await rm(temporary, { force: true });
        }
      });
    }
  };
}
