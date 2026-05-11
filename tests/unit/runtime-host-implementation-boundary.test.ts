import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CHECKED_ROOTS = ['electron', 'src'] as const;
const FORBIDDEN_RUNTIME_HOST_SEGMENTS = [
  'runtime-host/application/',
  'runtime-host/api/',
  'runtime-host/bootstrap/',
  'runtime-host/plugin-engine/',
] as const;
const RUNTIME_HOST_STORAGE_HOT_PATHS = [
  'runtime-host/application/sessions',
  'runtime-host/application/usage',
  'runtime-host/application/cron',
  'runtime-host/application/settings',
  'runtime-host/application/providers/provider-store-repository.ts',
  'runtime-host/application/openclaw/openclaw-environment-repository.ts',
  'runtime-host/application/team-runtime',
] as const;
const RUNTIME_HOST_APPLICATION_ROOTS = [
  'runtime-host/application',
] as const;
const RUNTIME_HOST_APPLICATION_JOB_FILES = [
  /runtime-host\/application\/.*-jobs\.ts$/,
  /runtime-host\/application\/runtime-host\/runtime-task-ports\.ts$/,
  /runtime-host\/application\/runtime-host\/runtime-long-task-service\.ts$/,
] as const;
const RUNTIME_HOST_SHARED_ROOTS = [
  'runtime-host/shared',
] as const;
const RUNTIME_HOST_API_ROOTS = [
  'runtime-host/api',
] as const;
const RUNTIME_HOST_ROUTE_FILES = [
  'runtime-host/api/routes',
] as const;
const RUNTIME_HOST_COMPOSITION_ROOT_FILES = [
  'runtime-host/composition/runtime-host-composition.ts',
] as const;
const RUNTIME_HOST_RUNNER_FILE = 'runtime-host/composition/runtime-host-runner.ts';
const RUNTIME_HOST_SYSTEM_MODULE_REGISTRY_FILE = 'runtime-host/composition/runtime-host-runtime-module-registry.ts';
const RUNTIME_HOST_APPLICATION_MODULE_REGISTRY_FILE = 'runtime-host/composition/runtime-host-module-registry.ts';
const RUNTIME_HOST_OPENCLAW_APPLICATION_MODULE_FILE = 'runtime-host/composition/modules/openclaw-application-module.ts';
const RUNTIME_HOST_INFRASTRUCTURE_MODULE_FILE = 'runtime-host/composition/modules/runtime-infrastructure-module.ts';
const RUNTIME_HOST_COMPOSITION_MODULE_ROOT = 'runtime-host/composition/modules';
const RUNTIME_HOST_MODULE_LIFECYCLE_FILES = [
  'runtime-host/composition/modules/gateway-bridge-module.ts',
  'runtime-host/composition/modules/openclaw-application-module.ts',
  'runtime-host/composition/modules/operations-application-module.ts',
  'runtime-host/composition/modules/plugin-runtime-module.ts',
  'runtime-host/composition/modules/runtime-infrastructure-module.ts',
  'runtime-host/composition/modules/session-runtime-module.ts',
] as const;
const RUNTIME_HOST_LAZY_MODULE_REGISTRATION_FILES = [
  'runtime-host/composition/modules/gateway-bridge-module.ts',
  'runtime-host/composition/modules/openclaw-infrastructure-module.ts',
  'runtime-host/composition/modules/openclaw-application-module.ts',
  'runtime-host/composition/modules/operations-application-module.ts',
  'runtime-host/composition/modules/platform-runtime-module.ts',
  'runtime-host/composition/modules/plugin-runtime-module.ts',
  'runtime-host/composition/modules/runtime-application-module.ts',
  'runtime-host/composition/modules/session-runtime-module.ts',
] as const;
const FORBIDDEN_RUNTIME_LAYER_IMPORTS = [
  /from ['"]node:(fs|fs\/promises)['"]/,
  /from ['"](fs|fs\/promises)['"]/,
] as const;
const FORBIDDEN_APPLICATION_INFRASTRUCTURE_IMPORTS = [
  /from ['"]node:(fs|fs\/promises|crypto)['"]/,
  /from ['"](fs|fs\/promises)['"]/,
  /from ['"]node:fs['"]/,
  /from ['"]\.\.\/\.\.\/openclaw-bridge/,
  /from ['"]\.\.\/openclaw-bridge/,
  /from ['"]\.\.\/\.\.\/composition/,
  /from ['"]\.\.\/composition/,
  /promises as fsPromises/,
] as const;
const FORBIDDEN_SHARED_INFRASTRUCTURE_IMPORTS = [
  /from ['"]node:(fs|fs\/promises|crypto|child_process|http|net|os)['"]/,
  /from ['"](fs|fs\/promises)['"]/,
  /import\s+\w+\s+from ['"]node:(fs|fs\/promises|crypto|child_process|http|net|os)['"]/,
  /promises as fsPromises/,
] as const;
const FORBIDDEN_API_LAYER_IMPORTS = [
  /from ['"]\.\.\/\.\.\/composition/,
  /from ['"]\.\.\/\.\.\/openclaw-bridge/,
  /from ['"]\.\.\/\.\.\/plugin-engine/,
  /from ['"]node:(fs|fs\/promises|crypto|child_process|http|net|os)['"]/,
  /from ['"](fs|fs\/promises)['"]/,
] as const;
const FORBIDDEN_API_CONSTRUCTION_PATTERNS = [
  /new\s+\w+(Service|Repository|Adapter|Client)\s*\(/,
  /container\.resolve/,
  /scope\.resolve/,
] as const;
const FORBIDDEN_ROUTE_IF_DISPATCH_PATTERNS = [
  /if\s*\(\s*method\s*===/,
  /if\s*\(\s*!\s*\(\s*method\s*===/,
] as const;
const FORBIDDEN_SYNC_IO_PATTERNS = [
  'readFileSync',
  'writeFileSync',
  'readdirSync',
  'statSync',
  'existsSync',
  'mkdirSync',
  'rmSync',
  'renameSync',
] as const;
const FORBIDDEN_COMPOSITION_ROOT_MODULE_IMPORTS = [
  /from ['"]\.\/modules\/openclaw-infrastructure-module['"]/,
  /from ['"]\.\/modules\/gateway-bridge-module['"]/,
  /from ['"]\.\/modules\/platform-runtime-module['"]/,
  /from ['"]\.\/modules\/plugin-runtime-module['"]/,
  /from ['"]\.\/modules\/session-runtime-module['"]/,
] as const;

async function listSourceFiles(dir: string): Promise<string[]> {
  const pathStat = await stat(dir);
  if (pathStat.isFile()) {
    return /\.(ts|tsx|js|mjs|cjs)$/.test(dir) ? [dir] : [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('runtime-host implementation boundary', () => {
  it('electron/src 不允许 import runtime-host 内部实现', async () => {
    const checkedFiles = (
      await Promise.all(CHECKED_ROOTS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = (await readFile(file, 'utf8')).replace(/\\/g, '/');
      for (const segment of FORBIDDEN_RUNTIME_HOST_SEGMENTS) {
        if (source.includes(segment)) {
          violations.push(`${path.relative(process.cwd(), file)} -> ${segment}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('session/usage/cron 请求链路不直接 import Node 文件系统', async () => {
    const checkedFiles = (
      await Promise.all(RUNTIME_HOST_STORAGE_HOT_PATHS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_RUNTIME_LAYER_IMPORTS) {
        if (pattern.test(source)) {
          violations.push(path.relative(process.cwd(), file));
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host application 层不直接 import Node 文件系统或 crypto 基础设施', async () => {
    const checkedFiles = (
      await Promise.all(RUNTIME_HOST_APPLICATION_ROOTS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_APPLICATION_INFRASTRUCTURE_IMPORTS) {
        if (pattern.test(source)) {
          violations.push(path.relative(process.cwd(), file));
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host application service 只通过业务 job port 提交任务', async () => {
    const checkedFiles = (
      await Promise.all(RUNTIME_HOST_APPLICATION_ROOTS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const normalizedPath = path.relative(process.cwd(), file).replace(/\\/g, '/');
      if (RUNTIME_HOST_APPLICATION_JOB_FILES.some((pattern) => pattern.test(normalizedPath))) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      if (source.includes('RuntimeLongTaskSubmissionPort')) {
        violations.push(normalizedPath);
      }
    }

    expect(violations).toEqual([]);
  });

  it('task/subagent 插件能力判断只通过 gateway capability service，不在业务服务里重复拼错误', async () => {
    const checkedFiles = [
      'runtime-host/application/tasks/service.ts',
      'runtime-host/application/subagents/service.ts',
    ];
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      if (source.includes('inspectGatewayMethodReadiness')) {
        violations.push(`${file} -> inspectGatewayMethodReadiness`);
      }
      if (source.includes('PLUGIN_CAPABILITY_UNAVAILABLE')) {
        violations.push(`${file} -> PLUGIN_CAPABILITY_UNAVAILABLE`);
      }
      expect(source).toContain('GatewayPluginCapabilityPort');
      expect(source).toContain('requirePluginMethod');
    }

    expect(violations).toEqual([]);
  });

  it('gateway capability service 由 application module registry 注册', async () => {
    const registrySource = await readFile(path.join(process.cwd(), RUNTIME_HOST_APPLICATION_MODULE_REGISTRY_FILE), 'utf8');
    const runtimeModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/runtime-application-module.ts'), 'utf8');

    expect(registrySource).toContain("name: 'application-foundation'");
    expect(registrySource).toContain("container.register('gateway.capabilities'");
    expect(runtimeModuleSource).not.toContain("container.register('gateway.capabilities'");
  });

  it('runtime-host shared 层只保留纯协议/类型，不直接 import Node 基础设施', async () => {
    const checkedFiles = (
      await Promise.all(RUNTIME_HOST_SHARED_ROOTS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_SHARED_INFRASTRUCTURE_IMPORTS) {
        if (pattern.test(source)) {
          violations.push(path.relative(process.cwd(), file));
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host api 层只做 handler/response，不直接绑定 bridge、composition 或实例化服务', async () => {
    const checkedFiles = (
      await Promise.all(RUNTIME_HOST_API_ROOTS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_API_LAYER_IMPORTS) {
        if (pattern.test(source)) {
          violations.push(path.relative(process.cwd(), file));
          break;
        }
      }
      for (const pattern of FORBIDDEN_API_CONSTRUCTION_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(path.relative(process.cwd(), file));
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host api 响应契约复用 application response，不再维护双轨响应类型', async () => {
    const dispatcherTypes = await readFile(path.join(process.cwd(), 'runtime-host/api/dispatch/runtime-route-dispatcher-types.ts'), 'utf8');
    const routeUtils = await readFile(path.join(process.cwd(), 'runtime-host/api/routes/route-utils.ts'), 'utf8');

    expect(dispatcherTypes).toContain("import type { ApplicationResponse }");
    expect(dispatcherTypes).toContain('export type RuntimeRouteResponse = ApplicationResponse');
    expect(dispatcherTypes).not.toContain('export interface RuntimeRouteResponse');
    expect(routeUtils).toContain("from '../../application/common/application-response'");
    expect(routeUtils).not.toMatch(/export function (ok|accepted|badRequest)\(/);
  });

  it('runtime-host route 文件通过 route table 分发，不保留 method/path 手写 if 链', async () => {
    const checkedFiles = (
      await Promise.all(RUNTIME_HOST_ROUTE_FILES.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_ROUTE_IF_DISPATCH_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(path.relative(process.cwd(), file));
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host 不允许同步文件 IO 回到请求热路径', async () => {
    const checkedFiles = await listSourceFiles(path.join(process.cwd(), 'runtime-host'));
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_SYNC_IO_PATTERNS) {
        if (source.includes(pattern)) {
          violations.push(`${path.relative(process.cwd(), file)} -> ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host composition root 只通过模块注册表装配系统能力', async () => {
    const violations: string[] = [];

    for (const file of RUNTIME_HOST_COMPOSITION_ROOT_FILES) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      for (const pattern of FORBIDDEN_COMPOSITION_ROOT_MODULE_IMPORTS) {
        if (pattern.test(source)) {
          violations.push(file);
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host composition root 不直接绑定进程信号或关闭 server', async () => {
    const source = await readFile(path.join(process.cwd(), 'runtime-host/composition/runtime-host-composition.ts'), 'utf8');

    expect(source).not.toMatch(/process\.on/);
    expect(source).not.toMatch(/process\.exit/);
    expect(source).not.toContain('closeRuntimeHostHttpServer');
    expect(source).toContain('new RuntimeHostServerRunner');
  });

  it('runtime-host server runner 通过生命周期统一启动和停止本地服务', async () => {
    const source = await readFile(path.join(process.cwd(), RUNTIME_HOST_RUNNER_FILE), 'utf8');

    expect(source).toContain("registerCleanup({");
    expect(source).toContain("name: 'http.server'");
    expect(source).toContain('lifecycle.startBackgroundServices()');
    expect(source).toContain('lifecycle.stop()');
    expect(source).toContain("processControl.onSignal('SIGTERM'");
    expect(source).toContain("processControl.onSignal('SIGINT'");
  });

  it('runtime-host 系统模块通过 RuntimeHostRegistry 注册，避免散装模块数组绕开重复检查', async () => {
    const source = await readFile(path.join(process.cwd(), RUNTIME_HOST_SYSTEM_MODULE_REGISTRY_FILE), 'utf8');

    expect(source).toContain('new RuntimeHostModuleRegistry<RuntimeHostSystemModule>()');
    expect(source).toContain('registry.register(module)');
    expect(source).toContain("RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('");
  });

  it('runtime-host application 模块同样通过 RuntimeHostRegistry 注册', async () => {
    const source = await readFile(path.join(process.cwd(), RUNTIME_HOST_APPLICATION_MODULE_REGISTRY_FILE), 'utf8');

    expect(source).toContain('new RuntimeHostModuleRegistry<RuntimeHostApplicationModule>()');
    expect(source).toContain('registry.register(module)');
    expect(source).toContain("RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('");
  });

  it('runtime-host application service 注册和解析分离，注册阶段不提前实例化服务', async () => {
    const moduleFiles = [
      'runtime-host/composition/modules/openclaw-application-module.ts',
      'runtime-host/composition/modules/runtime-application-module.ts',
      'runtime-host/composition/modules/operations-application-module.ts',
    ];

    for (const file of moduleFiles) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      const registerFunction = source.match(/export function register\w+ApplicationServices[\s\S]*?\n}\n\nexport function resolve\w+ApplicationServices/);
      expect(registerFunction?.[0] ?? '').not.toContain('return {');
      expect(source).toContain('export function register');
      expect(source).toContain('export function resolve');
      expect(source).not.toMatch(/export function create\w+ApplicationServices/);
    }

    const registrySource = await readFile(path.join(process.cwd(), RUNTIME_HOST_APPLICATION_MODULE_REGISTRY_FILE), 'utf8');
    expect(registrySource).toContain("RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('services'");
    expect(registrySource).toContain("RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('service-resolution'");
    expect(registrySource).toContain('export function registerRuntimeHostModuleServices');
    expect(registrySource).toContain('export function resolveRuntimeHostModuleServices');
    expect(registrySource).not.toMatch(/create\w+ApplicationServices/);
  });

  it('runtime-host 基础设施注册和解析分离，组合根显式按阶段装配', async () => {
    const moduleSource = await readFile(path.join(process.cwd(), RUNTIME_HOST_INFRASTRUCTURE_MODULE_FILE), 'utf8');
    const compositionSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/runtime-host-composition.ts'), 'utf8');

    const registerFunction = moduleSource.match(/export function registerRuntimeHostInfrastructure[\s\S]*?\n}\n\nexport function resolveRuntimeHostInfrastructure/);
    expect(registerFunction?.[0] ?? '').not.toContain('return {');
    expect(moduleSource).toContain('export function resolveRuntimeHostInfrastructure');
    expect(moduleSource).not.toContain('export function createRuntimeHostInfrastructure');
    expect(compositionSource).toContain('registerRuntimeHostInfrastructure(container)');
    expect(compositionSource).toContain('resolveRuntimeHostInfrastructure(container)');
  });

  it('runtime-host 模块生命周期通过 definition 清单注册，不在模块里散装调用生命周期对象', async () => {
    const lifecycleSource = await readFile(path.join(process.cwd(), 'runtime-host/core/lifecycle.ts'), 'utf8');
    expect(lifecycleSource).toContain('export function registerRuntimeLifecycleDefinitions');

    const violations: string[] = [];
    for (const file of RUNTIME_HOST_MODULE_LIFECYCLE_FILES) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      expect(source).toContain('registerRuntimeLifecycleDefinitions');
      if (source.includes('deps.lifecycle.registerBackgroundService') || source.includes('deps.lifecycle.registerCleanup')) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host 模块注册阶段只登记工厂，不提前 resolve 依赖实例', async () => {
    const violations: string[] = [];

    for (const file of RUNTIME_HOST_LAZY_MODULE_REGISTRATION_FILES) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      const registerFunctions = source.match(/function register\w+[\s\S]*?\n}\n\n/g)
        ?? source.match(/export function register\w+[\s\S]*?\n}\n\n/g)
        ?? [];
      for (const registerFunction of registerFunctions) {
        if (registerFunction.includes('container.resolve<') || registerFunction.includes('container.resolve(')) {
          violations.push(file);
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('runtime-host 系统 runtime module 内部同样先注册后解析', async () => {
    const moduleFiles = [
      'runtime-host/composition/modules/gateway-bridge-module.ts',
      'runtime-host/composition/modules/plugin-runtime-module.ts',
      'runtime-host/composition/modules/platform-runtime-module.ts',
      'runtime-host/composition/modules/session-runtime-module.ts',
    ];

    for (const file of moduleFiles) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      expect(source).toContain('): void {');
      expect(source).toMatch(/export function register\w+/);
      expect(source).toMatch(/export function resolve\w+/);
      expect(source).not.toMatch(/export function create\w+/);
    }

    const registrySource = await readFile(path.join(process.cwd(), RUNTIME_HOST_SYSTEM_MODULE_REGISTRY_FILE), 'utf8');
    expect(registrySource).toContain("RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('services'");
    expect(registrySource).toContain('module.registerServices?.(context, {})');
    expect(registrySource).toContain("RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('service-resolution'");
    expect(registrySource).toContain('module.resolveServices?.(context, modules)');
    expect(registrySource).toContain('export function registerRuntimeHostSystemServices');
    expect(registrySource).toContain('export function resolveRuntimeHostSystemModules');
    expect(registrySource).not.toContain('export function createRuntimeHostSystemModules');
    expect(registrySource).not.toContain("RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('create'");
    expect(registrySource).not.toContain('gateway bridge module must be resolved before');
  });

  it('runtime-host route registry 只暴露 route definition 注册入口', async () => {
    const source = await readFile(path.join(process.cwd(), 'runtime-host/composition/route-registry.ts'), 'utf8');

    expect(source).toContain('registerDefinitions<Deps>');
    expect(source).not.toContain('registerExact(');
    expect(source).not.toContain('registerPrefix(');
    expect(source).not.toContain('registerPattern(');
    expect(source).toContain('private register(');
  });

  it('gateway control 属于系统模块能力，不允许藏在 openclaw application service 注册里', async () => {
    const source = await readFile(path.join(process.cwd(), RUNTIME_HOST_OPENCLAW_APPLICATION_MODULE_FILE), 'utf8');

    expect(source).not.toContain("container.register('gateway.control'");
    expect(source).not.toContain('new ParentShellGatewayControl');
  });

  it('runtime-host 任务 handler 通过 definition 清单批量注册，不在模块里散装注册', async () => {
    const checkedFiles = await listSourceFiles(path.join(process.cwd(), RUNTIME_HOST_COMPOSITION_MODULE_ROOT));
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(file, 'utf8');
      if (source.includes('jobRegistry.register(')) {
        violations.push(path.relative(process.cwd(), file));
      }
    }

    expect(violations).toEqual([]);
  });
});
