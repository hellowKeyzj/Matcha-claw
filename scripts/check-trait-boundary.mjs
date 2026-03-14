import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const APPLICATION_DIR = path.join(ROOT, 'electron', 'core', 'application');
const FORBIDDEN_PATTERNS = [
  /adapters\//,
  /gateway\/manager/,
  /main\/ipc-handlers/,
];

async function collectTsFiles(dir) {
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      files.push(...await collectTsFiles(fullPath));
      continue;
    }
    if (entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const files = await collectTsFiles(APPLICATION_DIR);
  const violations = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(source)) {
        violations.push({ file, pattern: pattern.source });
      }
    }
  }

  if (violations.length > 0) {
    console.error('Trait boundary check failed: application layer imports forbidden modules.');
    for (const violation of violations) {
      console.error(`- ${path.relative(ROOT, violation.file)} matched /${violation.pattern}/`);
    }
    process.exit(1);
  }

  console.log(`Trait boundary check passed (${files.length} files).`);
}

main().catch((error) => {
  console.error('Trait boundary check failed with runtime error:', error);
  process.exit(1);
});
