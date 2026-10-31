import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const ROUTES_DIR = path.join(ROOT, 'electron', 'api', 'routes');
const SERVER_FILE = path.join(ROOT, 'electron', 'api', 'server.ts');
const BOUNDARY_FILE = path.join(ROOT, 'electron', 'api', 'main-api-boundary.json');

let ALLOWED_ROUTE_FILES = new Set();

const FORBIDDEN_ROUTE_IMPORT_MODULES = [
  'chat',
  'runtime-host',
  'providers',
  'channels',
  'sessions',
  'task-plugin',
  'team-runtime',
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
  const files = [SERVER_FILE, path.join(ROOT, 'electron', 'api', 'dispatcher.ts')];
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  for (const [index, source] of sources.entries()) {
    const violations = FORBIDDEN_ROUTE_IMPORT_MODULES.filter((moduleName) => {
      const pattern = new RegExp(`from\\s+['"]\\./routes/${moduleName}['"]`, 'm');
      return pattern.test(source);
    });
    if (violations.length > 0) {
      fail(
        `Main API boundary check failed: ${path.relative(ROOT, files[index])} 重新引入了被禁止的业务转发路由。`,
        violations.map((moduleName) => `违规导入: ./routes/${moduleName}`),
      );
    }
  }
  const source = sources[1];
  const importsMainOwnedRoute = /import\s+\{[^}]*\bisMainOwnedRoute\b[^}]*\}\s+from\s+['"]\.\/route-boundary['"];?/m.test(source);
  if (!importsMainOwnedRoute) {
    fail(
      'Main API boundary check failed: electron/api/dispatcher.ts 未导入主进程边界守卫。',
      ['缺少 import: isMainOwnedRoute'],
    );
  }

  if (!source.includes('if (isMainOwnedRoute(requestUrl.pathname))')) {
    fail(
      'Main API boundary check failed: electron/api/dispatcher.ts 缺少 main-owned 未注册守卫。',
      ['缺少保护分支: if (isMainOwnedRoute(requestUrl.pathname))'],
    );
  }
}

async function checkDesktopDependencies() {
  const violations = [];
  const mainRoot = path.join(ROOT, 'electron', 'main');
  const apiRoot = path.join(ROOT, 'electron', 'api');
  const compositionRoot = path.join(mainRoot, 'composition') + path.sep;
  const deliveryRoot = path.join(mainRoot, 'runtime-host-delivery') + path.sep;
  const apiAdapters = ['routes', 'ipc', 'events'].map((name) => path.join(apiRoot, name) + path.sep);

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filename);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      const composition = filename === path.join(mainRoot, 'app-bootstrap.ts') || filename.startsWith(compositionRoot);
      function check(node) {
        const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
          : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteral(specifier)) {
          const dependency = path.resolve(path.dirname(filename), specifier.text).replace(/\.ts$/, '');
          const importsAdapter = apiAdapters.some((directory) => dependency.startsWith(directory))
            || dependency === path.join(apiRoot, 'context')
            || dependency === path.join(apiRoot, 'dispatcher')
            || dependency === path.join(apiRoot, 'execution')
            || dependency === path.join(apiRoot, 'http-adapter')
            || dependency === path.join(apiRoot, 'server')
            || dependency === path.join(apiRoot, 'private-credentials');
          if (!composition && importsAdapter) {
            violations.push(`${path.relative(ROOT, filename)} → ${specifier.text}: 业务模块不得依赖接口装配或适配器`);
          }
          if (filename.startsWith(deliveryRoot) && dependency.startsWith(compositionRoot)) {
            violations.push(`${path.relative(ROOT, filename)} → ${specifier.text}: Delivery 不得反向依赖应用组合`);
          }
          if (specifier.text === 'electron' && ts.isImportDeclaration(node)
            && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
            && node.importClause.namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === 'ipcMain')) {
            violations.push(`${path.relative(ROOT, filename)}: ipcMain 注册必须位于 electron/api/ipc`);
          }
        }
        ts.forEachChild(node, check);
      }
      check(source);
    }
  }
  await visit(mainRoot);
  if (violations.length > 0) fail('Main API boundary check failed: 桌面模块依赖方向错误。', violations);
}

async function main() {
  await loadBoundarySpec();
  await checkRouteFiles();
  await checkServerImports();
  await checkDesktopDependencies();
  console.log('Main API boundary check passed.');
}

main().catch((error) => {
  console.error('Main API boundary check failed with runtime error:', error);
  process.exit(1);
});
