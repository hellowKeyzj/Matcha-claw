import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

const SKILL_IMPORT_MAX_FILES = 256;
const SKILL_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const SKILL_IMPORT_MAX_DEPTH = 8;
const SKILL_IMPORT_MAX_KEY_BYTES = 96;

export async function readSkillImport(sourcePath: string) {
  const selectedStat = await stat(sourcePath);
  if (selectedStat.isFile()) {
    if (!['.md', '.markdown'].includes(extname(sourcePath).toLowerCase())) throw new Error('invalid');
    const content = await readBoundedText(sourcePath);
    return {
      canceled: false,
      kind: 'markdown',
      skillKey: deriveSkillKey(content),
      content,
    };
  }
  if (!selectedStat.isDirectory()) throw new Error('invalid');
  const files: Array<{ path: string; content: string }> = [];
  await collectSkillFiles(sourcePath, sourcePath, files, 0);
  const manifest = files.find((file) => file.path.toLowerCase() === 'skill.md');
  if (!manifest) throw new Error('invalid');
  return {
    canceled: false,
    kind: 'bundle',
    skillKey: deriveSkillKey(manifest.content),
    files,
  };
}

function deriveSkillKey(content: string): string {
  const frontmatterStart = content.startsWith('---\n')
    ? '---\n'
    : content.startsWith('---\r\n')
      ? '---\r\n'
      : null;
  if (!frontmatterStart) {
    throw new Error('invalid');
  }
  const frontmatterContent = content.slice(frontmatterStart.length);
  const closingMarker = frontmatterContent.indexOf('\n---');
  if (closingMarker < 0) {
    throw new Error('invalid');
  }
  const frontmatter = frontmatterContent.slice(0, closingMarker);
  let document: unknown;
  try {
    document = parseYaml(frontmatter);
  } catch {
    throw new Error('invalid');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('invalid');
  }
  const manifest = document as Record<string, unknown>;
  const name = manifest.name;
  const description = manifest.description;
  if (typeof name !== 'string' || typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('invalid');
  }
  const normalized = name.trim().split(/\s+/u).join('-').replace(/[A-Z]/g, (character) => character.toLowerCase());
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, 'utf8') > SKILL_IMPORT_MAX_KEY_BYTES
    || !normalized
      .split('')
      .every((character, index) => /^[A-Za-z0-9]$/.test(character) || (index > 0 && character === '-'))
    || normalized.endsWith('-')
  ) {
    throw new Error('invalid');
  }
  return normalized;
}

async function readBoundedText(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > SKILL_IMPORT_MAX_BYTES) throw new Error('invalid');
  const content = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > SKILL_IMPORT_MAX_BYTES || content.includes('\0')) throw new Error('invalid');
  return content;
}

async function collectSkillFiles(root: string, current: string, files: Array<{ path: string; content: string }>, depth: number, total = { value: 0 }): Promise<void> {
  if (depth > SKILL_IMPORT_MAX_DEPTH || files.length >= SKILL_IMPORT_MAX_FILES) throw new Error('invalid');
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = `${current}${sep}${entry.name}`;
    if (entry.isDirectory()) {
      await collectSkillFiles(root, absolute, files, depth + 1, total);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (!relativePath || relativePath.includes('..')) throw new Error('invalid');
    const content = await readBoundedText(absolute);
    total.value += Buffer.byteLength(content, 'utf8');
    if (total.value > SKILL_IMPORT_MAX_BYTES) throw new Error('invalid');
    files.push({ path: relativePath, content });
  }
}
