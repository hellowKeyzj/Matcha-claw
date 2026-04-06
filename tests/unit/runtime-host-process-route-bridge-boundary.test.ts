import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime-host process route bridge boundary', () => {
  it('除 gateway 入口路由外，业务路由目录不得直接调用 gatewayRpc', async () => {
    const routesDir = path.join(process.cwd(), 'runtime-host', 'api', 'routes');
    const files = await readdir(routesDir, { withFileTypes: true });
    const routeFiles = files
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name);

    const violations: string[] = [];
    for (const fileName of routeFiles) {
      if (fileName === 'gateway-routes.ts') {
        continue;
      }
      const filePath = path.join(routesDir, fileName);
      const content = await readFile(filePath, 'utf8');
      if (content.includes('gatewayRpc(') || content.includes('deps.gatewayRpc')) {
        violations.push(fileName);
      }
    }

    expect(violations).toEqual([]);
  });
});
