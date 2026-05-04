import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('subagent template service', () => {
  let workspaceDir: string;
  let packagedResourcesDir: string;
  let previousCwd: string;
  let previousResourcesPath: string | undefined;
  let previousTemplateDir: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    workspaceDir = mkdtempSync(join(tmpdir(), 'matchaclaw-subagent-template-workspace-'));
    packagedResourcesDir = mkdtempSync(join(tmpdir(), 'matchaclaw-subagent-template-resources-'));
    previousCwd = process.cwd();
    previousResourcesPath = process.resourcesPath;
    previousTemplateDir = process.env.MATCHACLAW_SUBAGENT_TEMPLATE_DIR;
    delete process.env.MATCHACLAW_SUBAGENT_TEMPLATE_DIR;
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousResourcesPath === undefined) {
      delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    } else {
      process.resourcesPath = previousResourcesPath;
    }
    if (previousTemplateDir === undefined) {
      delete process.env.MATCHACLAW_SUBAGENT_TEMPLATE_DIR;
    } else {
      process.env.MATCHACLAW_SUBAGENT_TEMPLATE_DIR = previousTemplateDir;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(packagedResourcesDir, { recursive: true, force: true });
  });

  function writeTemplate(rootDir: string, templateId: string, marker: string): void {
    const templateDir = join(rootDir, templateId);
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, 'IDENTITY.md'), `# ${marker} Template\n${marker} summary\n`, 'utf8');
    writeFileSync(join(templateDir, 'AGENTS.md'), `# ${marker} Agents\n`, 'utf8');
    writeFileSync(join(templateDir, 'SOUL.md'), `${marker} soul\n`, 'utf8');
    writeFileSync(join(templateDir, 'TOOLS.md'), `${marker} tools\n`, 'utf8');
    writeFileSync(join(templateDir, 'USER.md'), `${marker} user\n`, 'utf8');
  }

  it('prefers packaged subagent templates from process.resourcesPath over cwd resources', async () => {
    const packagedTemplateRoot = join(packagedResourcesDir, 'resources', 'subagent-templates');
    const cwdTemplateRoot = join(workspaceDir, 'resources', 'subagent-templates');
    writeTemplate(packagedTemplateRoot, 'packaged-template', 'Packaged');
    writeTemplate(cwdTemplateRoot, 'cwd-template', 'Workspace');

    process.resourcesPath = packagedResourcesDir;

    const { SubagentTemplateService } = await import('../../runtime-host/application/openclaw/templates');
    const service = new SubagentTemplateService();
    const catalog = service.listCatalog();

    expect(catalog.sourceDir).toBe(packagedTemplateRoot);
    expect(catalog.templates.map((template) => template.id)).toEqual(['packaged-template']);
  });

  it('falls back to workspace templates when packaged resources are unavailable', async () => {
    const workspaceTemplateRoot = join(workspaceDir, 'src', 'features', 'subagents', 'templates');
    writeTemplate(workspaceTemplateRoot, 'workspace-template', 'Workspace');

    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

    const { SubagentTemplateService } = await import('../../runtime-host/application/openclaw/templates');
    const service = new SubagentTemplateService();
    const catalog = service.listCatalog();

    expect(catalog.sourceDir).toBe(workspaceTemplateRoot);
    expect(catalog.templates.map((template) => template.id)).toEqual(['workspace-template']);
  });
});
