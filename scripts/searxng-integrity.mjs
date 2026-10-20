import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function treeDigest(directory) {
  const digest = createHash('sha256');
  let bytes = 0;
  let files = 0;
  async function visit(current, prefix) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), `${relative}/`);
      else if (entry.isFile()) {
        const content = await readFile(path.join(current, entry.name));
        digest.update(`${relative}\0${createHash('sha256').update(content).digest('hex')}\n`);
        bytes += content.length;
        files++;
      } else throw new Error('SearXNG artifact may contain only regular files and directories');
    }
  }
  await visit(directory, '');
  return { sha256: digest.digest('hex'), bytes, files };
}
