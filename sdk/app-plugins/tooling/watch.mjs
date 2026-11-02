import { watch } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { buildProject } from './build.mjs';
import { developmentRequest } from './development.mjs';

export async function watchProject(directory, { connection, signal, report = console.log } = {}) {
  const root = await realpath(resolve(directory));
  let state = 'idle';
  let pending = false;
  let active = Promise.resolve();
  let timer;
  let previewRequested = false;
  const ignored = (filename) => relative(root, resolve(root, String(filename))).split(sep)
    .some((part) => part.startsWith('.') || ['node_modules', 'dist', 'target', '__pycache__'].includes(part));
  async function drain() {
    state = 'running';
    try {
      do {
        pending = false;
        try {
          const result = await buildProject(root);
          report(JSON.stringify({ event: 'built', id: result.manifest.id, digest: result.digest }));
          if (connection && state !== 'closed') {
            const uploaded = await developmentRequest(connection, 'package', { method: 'POST', bytes: result.bytes, signal });
            report(JSON.stringify({ event: 'uploaded', ...uploaded }));
            if (!previewRequested && state !== 'closed') {
              previewRequested = true;
              report(JSON.stringify({ event: 'preview', ...await developmentRequest(connection, 'preview', { method: 'POST', json: {}, signal }) }));
            }
          }
        } catch (error) {
          if (state !== 'closed') report(JSON.stringify({ event: 'failed', message: error.message }));
        }
      } while (pending && state !== 'closed');
    } finally {
      if (state !== 'closed') state = 'idle';
    }
  }
  function schedule() {
    if (state === 'closed') return;
    pending = true;
    if (state === 'idle') active = drain();
  }
  const watcher = watch(root, { recursive: true }, (_, filename) => {
    if (!filename || ignored(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(schedule, 100);
  });
  let watcherFailure;
  const stopped = new Promise((resolveStop) => {
    watcher.once('error', (error) => { watcherFailure = error; resolveStop(); });
    if (signal?.aborted) resolveStop();
    else signal?.addEventListener('abort', resolveStop, { once: true });
  });
  try {
    schedule();
    await stopped;
  } finally {
    state = 'closed';
    pending = false;
    clearTimeout(timer);
    watcher.close();
    await active;
  }
  if (watcherFailure) throw watcherFailure;
}
