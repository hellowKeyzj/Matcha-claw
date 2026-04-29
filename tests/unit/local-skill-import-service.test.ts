import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
let mockedSkillsRoot = '';

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawSkillsDir: () => mockedSkillsRoot,
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  mockedSkillsRoot = await createTempDir('matchaclaw-skills-root-');
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local-skill-import-service', () => {
  it('imports a local skill directory into the OpenClaw skills root', async () => {
    const sourceRoot = await createTempDir('matchaclaw-skill-source-');
    const sourceDir = join(sourceRoot, 'demo-skill');
    await mkdir(join(sourceDir, 'prompts'), { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# Demo Skill\n', 'utf8');
    await writeFile(join(sourceDir, 'prompts', 'system.txt'), 'hello', 'utf8');

    const { importLocalSkillSource } = await import('../../electron/services/skills/local-skill-import-service');
    const result = await importLocalSkillSource(sourceDir);

    expect(result).toMatchObject({
      skillKey: 'demo-skill',
      sourceKind: 'directory',
      installedPath: join(mockedSkillsRoot, 'demo-skill'),
    });
    await expect(readFile(join(mockedSkillsRoot, 'demo-skill', 'prompts', 'system.txt'), 'utf8')).resolves.toBe('hello');
  });

  it('imports a standalone markdown skill file as SKILL.md', async () => {
    const sourceRoot = await createTempDir('matchaclaw-skill-markdown-');
    const sourcePath = join(sourceRoot, 'solo-skill.md');
    await writeFile(
      sourcePath,
      [
        '---',
        'name: Solo Skill',
        'description: A minimal local skill.',
        '---',
        '',
        '# Solo Skill',
      ].join('\n'),
      'utf8',
    );

    const { importLocalSkillSource } = await import('../../electron/services/skills/local-skill-import-service');
    const result = await importLocalSkillSource(sourcePath);

    expect(result).toMatchObject({
      skillKey: 'solo-skill',
      sourceKind: 'markdown',
      installedPath: join(mockedSkillsRoot, 'solo-skill'),
    });
    await expect(readFile(join(mockedSkillsRoot, 'solo-skill', 'SKILL.md'), 'utf8')).resolves.toContain('name: Solo Skill');
  });
});
