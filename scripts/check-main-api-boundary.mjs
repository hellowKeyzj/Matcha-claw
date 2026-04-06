import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ROUTES_DIR = path.join(ROOT, 'electron', 'api', 'routes');
const SERVER_FILE = path.join(ROOT, 'electron', 'api', 'server.ts');
const RUNTIME_HOST_PROXY_FILE = path.join(ROOT, 'electron', 'api', 'routes', 'runtime-host-proxy.ts');
const BOUNDARY_FILE = path.join(ROOT, 'electron', 'api', 'main-api-boundary.json');

let ALLOWED_ROUTE_FILES = new Set();

const FORBIDDEN_ROUTE_IMPORT_MODULES = [
  'chat',
  'runtime-host',
  'plugins',
  'settings',
  'security',
  'providers',
  'channels',
  'usage',
  'skills',
  'sessions',
  'task-plugin',
  'team-runtime',
  'openclaw',
  'toolchain',
  'cron',
  'license',
];

function fail(message, details = []) {
  console.error(message);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
  process.exit(1);
}

async function loadBoundarySpec() {
  const source = await readFile(BOUNDARY_FILE, 'utf8');
  const parsed = JSON.parse(source);
  const files = Array.isArray(parsed?.allowedRouteFiles) ? parsed.allowedRouteFiles : null;
  if (!files || files.some((item) => typeof item !== 'string')) {
    fail('Main API boundary check failed: boundary spec 中 allowedRouteFiles 非法。');
  }
  ALLOWED_ROUTE_FILES = new Set(files);
}

async function checkRouteFiles() {
  const entries = await readdir(ROUTES_DIR, { withFileTypes: true });
  const routeFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();

  const unexpectedFiles = routeFiles.filter((file) => !ALLOWED_ROUTE_FILES.has(file));
  const missingFiles = [...ALLOWED_ROUTE_FILES].filter((file) => !routeFiles.includes(file));

  if (unexpectedFiles.length > 0 || missingFiles.length > 0) {
    const details = [];
    if (unexpectedFiles.length > 0) {
      details.push(`发现未允许的 route 文件: ${unexpectedFiles.join(', ')}`);
    }
    if (missingFiles.length > 0) {
      details.push(`缺少必须存在的 route 文件: ${missingFiles.join(', ')}`);
    }
    fail('Main API boundary check failed: electron/api/routes 目录不符合收口边界。', details);
  }
}

async function checkServerImports() {
  const source = await readFile(SERVER_FILE, 'utf8');
  const violations = FORBIDDEN_ROUTE_IMPORT_MODULES.filter((moduleName) => {
    const pattern = new RegExp(`from\\s+['"]\\./routes/${moduleName}['"]`, 'm');
    return pattern.test(source);
  });
  if (violations.length > 0) {
    fail(
      'Main API boundary check failed: electron/api/server.ts 重新引入了被禁止的业务转发路由。',
      violations.map((moduleName) => `违规导入: ./routes/${moduleName}`),
    );
  }

  if (!source.includes("import { handleRuntimeHostProxyRoutes } from './routes/runtime-host-proxy';")) {
    fail(
      'Main API boundary check failed: electron/api/server.ts 未导入 runtime-host-proxy。',
      ['缺少 import: handleRuntimeHostProxyRoutes'],
    );
  }

  if (!source.includes('handleRuntimeHostProxyRoutes')) {
    fail(
      'Main API boundary check failed: electron/api/server.ts 未启用 runtime-host-proxy 处理链路。',
      ['routeHandlers 中必须包含 handleRuntimeHostProxyRoutes'],
    );
  }

  if (!source.includes("import { isMainOwnedRoute } from './route-boundary';")) {
    fail(
      'Main API boundary check failed: electron/api/server.ts 未导入主进程边界守卫。',
      ['缺少 import: isMainOwnedRoute'],
    );
  }

  if (!source.includes('if (isMainOwnedRoute(requestUrl.pathname))')) {
    fail(
      'Main API boundary check failed: electron/api/server.ts 缺少 main-owned 未注册守卫。',
      ['缺少保护分支: if (isMainOwnedRoute(requestUrl.pathname))'],
    );
  }
}

async function checkProxyBoundaryGuard() {
  const source = await readFile(RUNTIME_HOST_PROXY_FILE, 'utf8');
  if (!source.includes("import { isRuntimeHostBusinessRoute } from '../route-boundary';")) {
    fail(
      'Main API boundary check failed: runtime-host-proxy 未导入 business-owned 守卫。',
      ['缺少 import: isRuntimeHostBusinessRoute'],
    );
  }

  if (!source.includes('if (!isRuntimeHostBusinessRoute(url.pathname))')) {
    fail(
      'Main API boundary check failed: runtime-host-proxy 缺少 business-owned 过滤守卫。',
      ['缺少保护分支: if (!isRuntimeHostBusinessRoute(url.pathname))'],
    );
  }
}

async function main() {
  await loadBoundarySpec();
  await checkRouteFiles();
  await checkServerImports();
  await checkProxyBoundaryGuard();
  console.log('Main API boundary check passed.');
}

main().catch((error) => {
  console.error('Main API boundary check failed with runtime error:', error);
  process.exit(1);
});
