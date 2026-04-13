import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type PackageJsonShape = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('runtime dependency guard', () => {
  it('显式声明 @slack/web-api，避免 gateway-http slack stage 运行期缺模块', () => {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJsonShape;
    const version = packageJson.dependencies?.['@slack/web-api']
      ?? packageJson.devDependencies?.['@slack/web-api'];

    expect(typeof version === 'string' && version.trim().length > 0).toBe(true);
  });
});
