import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import plugin from '../../packages/openclaw-security-plugin/src/index';
import {
  SECURITY_CORE_PLUGIN_DESCRIPTION,
  SECURITY_CORE_PLUGIN_ID,
  SECURITY_CORE_PLUGIN_NAME,
} from '../../packages/openclaw-security-plugin/src/manifest';

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('security-core 插件规范对齐', () => {
  const pluginDir = join(process.cwd(), 'packages', 'openclaw-security-plugin');
  const pluginManifest = readJson(join(pluginDir, 'openclaw.plugin.json'));
  const packageJson = readJson(join(pluginDir, 'package.json'));

  it('入口元数据与 manifest 单一事实源一致', () => {
    expect(plugin.id).toBe(SECURITY_CORE_PLUGIN_ID);
    expect(plugin.name).toBe(SECURITY_CORE_PLUGIN_NAME);
    expect(plugin.description).toBe(SECURITY_CORE_PLUGIN_DESCRIPTION);

    expect(pluginManifest.id).toBe(SECURITY_CORE_PLUGIN_ID);
    expect(pluginManifest.name).toBe(SECURITY_CORE_PLUGIN_NAME);
    expect(pluginManifest.description).toBe(SECURITY_CORE_PLUGIN_DESCRIPTION);
  });

  it('manifest 具备稳定发现/升级所需关键字段', () => {
    expect(pluginManifest.version).toBe(packageJson.version);
    expect(pluginManifest.category).toBe('security');
    expect(pluginManifest.configSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it('package 扩展入口仍指向规范的单一入口文件', () => {
    const openclawMeta = packageJson.openclaw as { extensions?: unknown } | undefined;
    expect(Array.isArray(openclawMeta?.extensions)).toBe(true);
    expect(openclawMeta?.extensions).toContain('./src/index.ts');
    expect(typeof plugin.register).toBe('function');
  });
});
