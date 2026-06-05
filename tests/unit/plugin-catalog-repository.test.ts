import { describe, expect, it, vi } from 'vitest';
import { OpenClawPluginCatalogKindPolicy } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-plugin-catalog-kind-policy';
import { PluginCatalogRepository } from '../../runtime-host/application/plugins/catalog';
import { PluginCatalogDiscoveryWorkflow } from '../../runtime-host/application/workflows/plugin-runtime/plugin-catalog-discovery-workflow';

const manifestPath = '/runtime/dist/extensions/browser/openclaw.plugin.json';
const rootDir = '/runtime/dist/extensions/browser';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

describe('plugin catalog repository', () => {
  it('maps bundled runtime plugins to managed catalog entries through neutral location ports', async () => {
    const locations = {
      getRuntimeDataRootDir: vi.fn(() => '/runtime-data'),
      getRuntimeDistributionDir: vi.fn(() => '/runtime'),
      getWorkingDir: vi.fn(() => '/workspace'),
      getUserMatchaClawPluginDir: vi.fn(() => '/user-plugins'),
    };
    const fileSystem = {
      pathExists: vi.fn(async (path: string) => normalizePath(path) === manifestPath),
      listDirectoryEntries: vi.fn(async (path: string) => (normalizePath(path) === '/runtime/dist/extensions' ? [{ name: 'browser', isDirectory: true }] : [])),
      readText: vi.fn(async () => JSON.stringify({
        id: 'browser',
        name: 'Browser',
        version: '1.0.0',
        category: 'general',
      })),
      readJsonRecord: vi.fn(async (path: string) => {
        if (normalizePath(path) === manifestPath) {
          return {
            id: 'browser',
            name: 'Browser',
            version: '1.0.0',
            category: 'general',
          };
        }
        return normalizePath(path) === `${rootDir}/package.json` ? { version: '1.0.1' } : {};
      }),
    };
    const repository = new PluginCatalogRepository(new PluginCatalogDiscoveryWorkflow({
      locations,
      companionSkills: { getSlugsForPlugin: vi.fn(() => []) },
      fileSystem,
      kindPolicy: new OpenClawPluginCatalogKindPolicy(),
    }));

    const catalog = await repository.discover();

    expect(locations.getRuntimeDataRootDir).toHaveBeenCalled();
    expect(locations.getRuntimeDistributionDir).toHaveBeenCalled();
    expect(fileSystem.readText).toHaveBeenCalledWith(expect.stringContaining('openclaw.plugin.json'));
    expect(catalog).toEqual([expect.objectContaining({
      id: 'browser',
      controlMode: 'managed',
      source: 'bundled',
    })]);
  });
});
