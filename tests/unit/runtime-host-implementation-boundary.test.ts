import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeHostContainer } from '../../runtime-host/composition/container';
import { RuntimeJobRegistry, registerRuntimeJobDefinitions } from '../../runtime-host/core/jobs';
import { RuntimeHostLifecycle, registerRuntimeLifecycleDefinitions } from '../../runtime-host/core/lifecycle';
import { RuntimeHostRouteRegistry } from '../../runtime-host/composition/route-registry';
import { ApplicationServiceRegistry } from '../../runtime-host/composition/application-service-registry';
import { RuntimeHostModuleRegistry } from '../../runtime-host/core/registry';

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
  'runtime-host/application/adapters/openclaw/infrastructure/openclaw-environment-repository.ts',
] as const;
const RUNTIME_HOST_APPLICATION_ROOTS = [
  'runtime-host/application',
] as const;
const TEAM_RUNTIME_WORKER_INFRASTRUCTURE_FILES = new Set([
  'runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/sqlite-team-command-ledger.ts',
  'runtime-host/application/team-runtime/infrastructure/worker/team-runtime-worker-entry.ts',
]);
const RUNTIME_HOST_OPENCLAW_CORE_BOUNDARY_ROOTS = [
  'runtime-host/application/providers',
  'runtime-host/application/channels',
  'runtime-host/application/plugins',
  'runtime-host/application/security',
  'runtime-host/application/sessions',
  'runtime-host/application/capabilities',
  'runtime-host/application/agent-runtime/contracts',
] as const;
const RUNTIME_HOST_OPENCLAW_KERNEL_BOUNDARY_ROOTS = [
  'runtime-host/application/agent-runtime',
  'runtime-host/application/capabilities',
  'runtime-host/application/workflows',
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
const RUNTIME_HOST_ROUTE_MODULE_FILES = [
  'runtime-host/composition/modules/openclaw-route-module.ts',
  'runtime-host/composition/modules/operations-route-module.ts',
  'runtime-host/composition/modules/runtime-route-module.ts',
  'runtime-host/composition/modules/session-route-module.ts',
] as const;
const RUNTIME_HOST_COMPOSITION_ROOT_FILES = [
  'runtime-host/composition/runtime-host-composition.ts',
] as const;
const RUNTIME_HOST_RUNNER_FILE = 'runtime-host/composition/runtime-host-runner.ts';
const RUNTIME_HOST_SYSTEM_MODULE_REGISTRY_FILE = 'runtime-host/composition/runtime-host-runtime-module-registry.ts';
const RUNTIME_HOST_APPLICATION_MODULE_REGISTRY_FILE = 'runtime-host/composition/runtime-host-module-registry.ts';
const RUNTIME_HOST_APPLICATION_SERVICES_FILE = 'runtime-host/composition/application-services.ts';
const RUNTIME_HOST_OPENCLAW_APPLICATION_MODULE_FILE = 'runtime-host/composition/modules/openclaw-application-module.ts';
const RUNTIME_HOST_OPENCLAW_INFRASTRUCTURE_MODULE_FILE = 'runtime-host/composition/modules/openclaw-infrastructure-module.ts';
const RUNTIME_HOST_ACP_CONNECTOR_MODULE_FILE = 'runtime-host/composition/modules/acp-connector-module.ts';
const RUNTIME_HOST_AGENT_RUNTIME_CONTRACT_FILE = 'runtime-host/application/agent-runtime/contracts/runtime-endpoint-types.ts';
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
  'runtime-host/composition/modules/external-connectors-application-module.ts',
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
const FORBIDDEN_OPENCLAW_CORE_BOUNDARY_PATTERNS = [
  /from ['"].*adapters\/openclaw/,
  /from ['"].*openclaw-bridge/,
  /new\s+OpenClaw\w*\(/,
  /OpenClawRuntimeAdapter/,
  /OpenClawV4ProtocolAdapter/,
  /OpenClawApprovalAdapter/,
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
    if (entry.name === 'build' || entry.name === 'node_modules') {
      continue;
    }
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
  it('runtime-host container 记录每个 token 的注册 owner 元数据', () => {
    const container = new RuntimeHostContainer();

    container.withRegistrationOwner('test-module', () => {
      container.register('test.factory', () => ({ ok: true }));
      container.registerValue('test.value', 1);
    });
    container.registerValue('test.external', 2);

    expect(container.listRegistrations()).toEqual([
      {
        key: 'test.factory',
        owner: 'test-module',
        kind: 'factory',
        resolved: false,
      },
      {
        key: 'test.value',
        owner: 'test-module',
        kind: 'value',
        resolved: true,
      },
      {
        key: 'test.external',
        owner: null,
        kind: 'value',
        resolved: true,
      },
    ]);
  });

  it('runtime-host job/lifecycle/route 注册同样记录 owner 元数据', () => {
    const jobs = new RuntimeJobRegistry();
    jobs.withRegistrationOwner('jobs-module', () => {
      registerRuntimeJobDefinitions(jobs, [{ type: 'test.job', handler: () => undefined }]);
    });

    const lifecycle = new RuntimeHostLifecycle({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    lifecycle.withRegistrationOwner('lifecycle-module', () => {
      registerRuntimeLifecycleDefinitions(lifecycle, {
        backgroundServices: [{ name: 'test.background', start: () => undefined }],
        cleanupTasks: [{ name: 'test.cleanup', run: () => undefined }],
      });
    });

    const routes = new RuntimeHostRouteRegistry();
    routes.withRegistrationOwner('routes-module', () => {
      routes.registerDefinitions('test', [
        {
          method: 'GET',
          path: '/api/test',
          handle: () => ({ status: 200, data: { success: true } }),
        },
      ], {});
    });

    expect(jobs.listRegistrations()).toEqual([{ type: 'test.job', owner: 'jobs-module' }]);
    expect(lifecycle.listRegistrations()).toEqual([
      { kind: 'background-service', name: 'test.background', owner: 'lifecycle-module' },
      { kind: 'cleanup-task', name: 'test.cleanup', owner: 'lifecycle-module' },
    ]);
    expect(routes.listRegistrations()).toEqual([{ key: 'test.GET /api/test', owner: 'routes-module' }]);
  });

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

  it('session core 不直接 import OpenClaw adapter 或 ACP connector 实现', async () => {
    const checkedFiles = await listSourceFiles(path.join(process.cwd(), 'runtime-host/application/sessions'));
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = (await readFile(file, 'utf8')).replace(/\\/g, '/');
      if (
        source.includes('application/adapters/openclaw')
        || source.includes('agent-runtime/protocol-connectors/acp')
        || /from ['"].*openclaw/i.test(source)
        || /from ['"].*acp/i.test(source)
      ) {
        violations.push(path.relative(process.cwd(), file));
      }
    }

    expect(violations).toEqual([]);
  });

  it('OpenClaw provider key projection 不留在 providers runtime 语义里', async () => {
    const providerRulesPath = path.join(process.cwd(), 'runtime-host/application/providers/provider-projection-rules.ts');
    await expect(stat(providerRulesPath)).rejects.toThrow();

    const projectionSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/projections/openclaw-provider-projection-rules.ts'), 'utf8');
    expect(projectionSource).toContain('getOpenClawProviderKey');
    expect(projectionSource).toContain('getLegacyOpenClawProviderKeys');
  });

  it('非 adapter 核心业务层不直接绑定 OpenClaw 实现或 bridge', async () => {
    const checkedFiles = (
      await Promise.all(RUNTIME_HOST_OPENCLAW_CORE_BOUNDARY_ROOTS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = (await readFile(file, 'utf8')).replace(/\\/g, '/');
      for (const pattern of FORBIDDEN_OPENCLAW_CORE_BOUNDARY_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(path.relative(process.cwd(), file));
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('agent runtime、capability 与 workflow 内核不反向 import OpenClaw adapter/projection', async () => {
    const checkedFiles = (
      await Promise.all(RUNTIME_HOST_OPENCLAW_KERNEL_BOUNDARY_ROOTS.map((root) => listSourceFiles(path.join(process.cwd(), root))))
    ).flat();
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const normalizedFile = path.relative(process.cwd(), file).replace(/\\/g, '/');
      if (normalizedFile.includes('runtime-host/application/workflows/openclaw-')) {
        continue;
      }
      const source = (await readFile(file, 'utf8')).replace(/\\/g, '/');
      if (/from ['"].*adapters\/openclaw/.test(source) || /from ['"].*openclaw-bridge/.test(source)) {
        violations.push(normalizedFile);
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
      const relativeFile = path.relative(process.cwd(), file).replace(/\\/g, '/');
      if (TEAM_RUNTIME_WORKER_INFRASTRUCTURE_FILES.has(relativeFile)) {
        continue;
      }
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

  it('provider store 缓存、JSON 归一化与写盘策略留在 persistence workflow 层，不回流到 repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/providers/provider-store-repository.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-store/provider-store-persistence-workflow.ts'), 'utf8');
    const openClawInfrastructureSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class ProviderStorePersistenceWorkflow');
    expect(workflowSource).toContain('cachedStore');
    expect(workflowSource).toContain('readProviderStoreStat');
    expect(workflowSource).toContain('normalizeRecordMap');
    expect(workflowSource).toContain('normalizeStringMap');
    expect(workflowSource).toContain('writeTextFile(filePath');
    expect(repositorySource).toContain('persistenceWorkflow');
    expect(repositorySource).not.toContain('cachedStore');
    expect(repositorySource).not.toContain('readProviderStoreStat');
    expect(repositorySource).not.toContain('normalizeRecordMap');
    expect(repositorySource).not.toContain('normalizeStringMap');
    expect(repositorySource).not.toContain('writeTextFile(filePath');
    expect(repositorySource).not.toContain('new ProviderStorePersistenceWorkflow');
    expect(openClawInfrastructureSource).toContain("container.register('providers.storePersistenceWorkflow'");
    expect(openClawInfrastructureSource).toContain("persistenceWorkflow: scope.resolve<ProviderStorePersistenceWorkflow>('providers.storePersistenceWorkflow')");
  });

  it('OpenClaw provider config upsert/remove 投影编排留在 workflow 层，不回流到 config service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/projections/openclaw-provider-config-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-config-workflow.ts'), 'utf8');
    const openClawInfrastructureSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawProviderConfigWorkflow');
    expect(workflowSource).toContain('upsertOpenClawProviderEntry');
    expect(workflowSource).toContain('removeProfilesForProvider');
    expect(workflowSource).toContain('removeProviderFromAgentModels');
    expect(workflowSource).toContain('removeProviderFromOpenClawConfig');
    expect(workflowSource).toContain('markRestartCommand(config)');
    expect(serviceSource).toContain('configWorkflow');
    expect(serviceSource).not.toContain('upsertOpenClawProviderEntry');
    expect(serviceSource).not.toContain('removeProfilesForProvider');
    expect(serviceSource).not.toContain('removeProviderFromAgentModels');
    expect(serviceSource).not.toContain('removeProviderFromOpenClawConfig');
    expect(serviceSource).not.toContain('markRestartCommand');
    expect(serviceSource).not.toContain('new OpenClawProviderConfigWorkflow');
    expect(openClawInfrastructureSource).toContain("container.register('openclaw.providerConfigWorkflow'");
    expect(openClawInfrastructureSource).toContain("scope.resolve<OpenClawProviderConfigWorkflow>('openclaw.providerConfigWorkflow')");
  });

  it('OpenClaw auth-profiles 私有凭证读写编排留在 workflow 层，不回流到 profile service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-profile-store.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-profile-workflow.ts'), 'utf8');
    const openClawInfrastructureSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawAuthProfileWorkflow');
    expect(workflowSource).toContain('readAuthProfiles(id)');
    expect(workflowSource).toContain('writeAuthProfiles(store, id)');
    expect(workflowSource).toContain('removeProfileFromStore');
    expect(workflowSource).toContain('getApiKeyFromAuthProfilesStore');
    expect(workflowSource).toContain('markProfileCurrent');
    expect(serviceSource).toContain('profileWorkflow');
    expect(serviceSource).not.toContain('readAuthProfiles(id)');
    expect(serviceSource).not.toContain('writeAuthProfiles(store, id)');
    expect(serviceSource).not.toContain('getApiKeyFromAuthProfilesStore');
    expect(serviceSource).not.toContain('markProfileCurrent');
    expect(serviceSource).not.toContain('new OpenClawAuthProfileWorkflow');
    expect(openClawInfrastructureSource).toContain("container.register('openclaw.authProfileWorkflow'");
    expect(openClawInfrastructureSource).toContain("scope.resolve<OpenClawAuthProfileWorkflow>('openclaw.authProfileWorkflow')");
  });

  it('provider projection 同步计划与投影写入编排留在 workflow 层，不回流到 sync service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/providers/store-sync.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-projection-sync/provider-projection-sync-workflow.ts'), 'utf8');
    const openClawInfrastructureSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class ProviderProjectionSyncWorkflow');
    expect(workflowSource).toContain('normalizeProviderStoreForProjection');
    expect(workflowSource).toContain('buildProviderProjectionSyncPlan');
    expect(workflowSource).toContain('discoverAgentIds');
    expect(workflowSource).toContain('saveProviderKey(accountPlan.providerKey');
    expect(workflowSource).toContain('syncProviderConfig(accountPlan.providerKey');
    expect(workflowSource).toContain('upsertProviderInAgentModels');
    expect(serviceSource).toContain('syncWorkflow');
    expect(serviceSource).not.toContain('buildProviderProjectionSyncPlan');
    expect(serviceSource).not.toContain('discoverAgentIds');
    expect(serviceSource).not.toContain('saveProviderKey(accountPlan.providerKey');
    expect(serviceSource).not.toContain('syncProviderConfig(accountPlan.providerKey');
    expect(serviceSource).not.toContain('upsertProviderInAgentModels');
    expect(serviceSource).not.toContain('new ProviderProjectionSyncWorkflow');
    expect(openClawInfrastructureSource).toContain("container.register('providers.projectionSyncWorkflow'");
    expect(openClawInfrastructureSource).toContain("scope.resolve<ProviderProjectionSyncWorkflow>('providers.projectionSyncWorkflow')");
  });

  it('provider models 与 capability routing store 持久化归一化留在 workflow 层，不回流到 store repository', async () => {
    const modelsRepositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/providers/provider-models-store.ts'), 'utf8');
    const routingRepositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/providers/capability-routing-store.ts'), 'utf8');
    const modelsWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-models-store/provider-models-store-persistence-workflow.ts'), 'utf8');
    const routingWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-capability-routing-store/provider-capability-routing-store-persistence-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(modelsWorkflowSource).toContain('export class ProviderModelsStorePersistenceWorkflow');
    expect(modelsWorkflowSource).toContain('normalizeProviderModel');
    expect(modelsWorkflowSource).toContain('MODEL_CAPABILITY_SET');
    expect(modelsWorkflowSource).toContain('cachedStore');
    expect(routingWorkflowSource).toContain('export class ProviderCapabilityRoutingStorePersistenceWorkflow');
    expect(routingWorkflowSource).toContain('normalizeRouting');
    expect(routingWorkflowSource).toContain('cloneRouting');
    expect(routingWorkflowSource).toContain('cachedStore');
    expect(modelsRepositorySource).toContain('persistenceWorkflow');
    expect(modelsRepositorySource).not.toContain('normalizeProviderModel');
    expect(modelsRepositorySource).not.toContain('MODEL_CAPABILITY_SET');
    expect(modelsRepositorySource).not.toContain('cachedStore');
    expect(routingRepositorySource).toContain('persistenceWorkflow');
    expect(routingRepositorySource).not.toContain('normalizeRouting');
    expect(routingRepositorySource).not.toContain('cloneRouting');
    expect(routingRepositorySource).not.toContain('cachedStore');
    expect(openClawModuleSource).toContain("container.register('providers.modelsStorePersistenceWorkflow'");
    expect(openClawModuleSource).toContain("container.register('providers.capabilityRoutingStorePersistenceWorkflow'");
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
      {
        file: 'runtime-host/application/tasks/service.ts',
        capabilityOwner: 'runtime-host/application/workflows/task-runtime/task-runtime-workflow.ts',
      },
      {
        file: 'runtime-host/application/subagents/service.ts',
        capabilityOwner: 'runtime-host/application/workflows/subagent-runtime/subagent-runtime-workflow.ts',
      },
    ];
    const violations: string[] = [];

    for (const checked of checkedFiles) {
      const source = await readFile(path.join(process.cwd(), checked.file), 'utf8');
      if (source.includes('inspectGatewayMethodReadiness')) {
        violations.push(`${checked.file} -> inspectGatewayMethodReadiness`);
      }
      if (source.includes('PLUGIN_CAPABILITY_UNAVAILABLE')) {
        violations.push(`${checked.file} -> PLUGIN_CAPABILITY_UNAVAILABLE`);
      }
      const ownerSource = await readFile(path.join(process.cwd(), checked.capabilityOwner), 'utf8');
      expect(ownerSource).toContain('GatewayPluginCapabilityPort');
      expect(ownerSource).toContain('requirePluginMethod');
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
      const relativeFile = path.relative(process.cwd(), file).replace(/\\/g, '/');
      if (TEAM_RUNTIME_WORKER_INFRASTRUCTURE_FILES.has(relativeFile)) {
        continue;
      }
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

    expect(source).toContain('new RuntimeHostModuleRegistry<RuntimeHostSystemModule>');
    expect(source).toContain('RUNTIME_HOST_SYSTEM_MODULES,');
    expect(source).toContain('manifest: {');
    expect(source).toContain('export function listRuntimeHostSystemModuleRegistrationDiagnostics');
    expect(source).toContain('RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.listRegistrationDiagnostics');
    expect(source).toContain("RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('");
  });

  it('runtime-host application 模块同样通过 RuntimeHostRegistry 注册', async () => {
    const source = await readFile(path.join(process.cwd(), RUNTIME_HOST_APPLICATION_MODULE_REGISTRY_FILE), 'utf8');

    expect(source).toContain('new RuntimeHostModuleRegistry<RuntimeHostApplicationModule>(modules');
    expect(source).toContain('externalExports: [');
    expect(source).toContain('createRuntimeHostApplicationModuleRegistry(');
    expect(source).toContain('RUNTIME_HOST_APPLICATION_MODULES,');
    expect(source).toContain('manifest: {');
    expect(source).toContain('context.container.withRegistrationOwner(module.name');
    expect(source).toContain('context.container.withResolutionOwner(module.name');
    expect(source).toContain('container.withResolutionOwner(module.name');
    expect(source).toContain('export function listRuntimeHostApplicationModuleRegistrationDiagnostics');
    expect(source).toContain('RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.listRegistrationDiagnostics');
    expect(source).toContain('deps.jobRegistry.withRegistrationOwner(module.name');
    expect(source).toContain('deps.lifecycle.withRegistrationOwner(module.name');
    expect(source).toContain('routes.withRegistrationOwner(module.name');
    expect(source).toContain('container.withResolutionOwner(module.name');
    expect(source).toContain("RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('");
  });

  it('runtime-host route handlers 在启动期构建一次，使 route 依赖参与模块 import 校验', async () => {
    const source = await readFile(path.join(process.cwd(), 'runtime-host/composition/runtime-host-composition.ts'), 'utf8');
    const tokenSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/runtime-host-tokens.ts'), 'utf8');

    expect(tokenSource).toContain("export type RuntimeHostToken<Value>");
    expect(tokenSource).toContain("export const RUNTIME_DISPATCH_ROUTE_TOKEN = runtimeHostToken<RuntimeDispatchRoutePort>('runtime.dispatchRoute')");
    expect(tokenSource).toContain("export const SESSION_RUNTIME_TOKEN = runtimeHostToken<SessionRuntimeService>('session.runtime')");
    expect(source).toContain('facades: createApplicationServiceRegistry()');
    expect(source).toContain('const routeRegistry = createRuntimeHostRouteRegistry(applicationContext)');
    expect(source).not.toContain('const routeHandlers = routeRegistry.list()');
    expect(source).toContain('validateRuntimeHostApplicationModuleRegistrationOwners(container, {');
    expect(source).toContain('routes: routeRegistry');
    expect(source).toContain('const dispatchRuntimeRoute = routeRegistry.dispatcher()');
    expect(source).toContain('container.registerValue(RUNTIME_DISPATCH_ROUTE_TOKEN, dispatchRuntimeRoute)');
    expect(source).not.toContain('createRuntimeRouteDispatcher(createRuntimeHostRouteHandlers(container))');
    expect(source.indexOf('validateRuntimeHostApplicationModuleRegistrationOwners(container, {'))
      .toBeGreaterThan(source.indexOf('registerRuntimeHostModuleLifecycle(container'));
    expect(source.indexOf('validateRuntimeHostSystemModuleRegistrationOwners(systemModuleContext)'))
      .toBeGreaterThan(source.indexOf('registerRuntimeHostSystemModuleLifecycle(systemModuleContext'));
  });

  it('runtime-host application context 只携带 container 和 facade registry，不作为 service bag 入口', async () => {
    const source = await readFile(path.join(process.cwd(), RUNTIME_HOST_APPLICATION_SERVICES_FILE), 'utf8');
    const registrySource = await readFile(path.join(process.cwd(), 'runtime-host/composition/application-service-registry.ts'), 'utf8');

    expect(source).toContain('container: RuntimeHostContainer');
    expect(source).toContain('facades: ApplicationServiceRegistry');
    expect(source).toContain('createApplicationServiceRegistry');
    expect(registrySource).toContain('RuntimeHostToken<Facade> | string');
    expect(registrySource).toContain('runtimeHostTokenKey(token)');
    expect(registrySource).not.toContain('registerContainerToken');
    expect(source).not.toContain('runtimeState:');
    expect(source).not.toContain('transportStats:');
    expect(source).not.toContain('pluginRuntime:');
    expect(source).not.toContain('sessionRuntime:');
    expect(source).not.toContain('platformRuntime:');
    expect(source).not.toContain('parentShell:');
    expect(source).not.toContain('parentGatewayEvents:');
  });

  it('runtime-host facade resolve 参与 module import 校验', () => {
    const container = new RuntimeHostContainer();
    const facades = new ApplicationServiceRegistry();
    container.registerValue('producer.facade', { ok: true });
    const registry = new RuntimeHostModuleRegistry([
      {
        name: 'producer',
        manifest: { id: 'producer', exports: ['producer.facade'] },
      },
      {
        name: 'consumer',
        manifest: { id: 'consumer', imports: ['producer.facade'] },
      },
    ]);

    facades.register('producer', 'producer.facade', () => container.resolve('producer.facade'));
    facades.withResolutionOwner('consumer', () => {
      expect(facades.resolve<{ ok: boolean }>('producer.facade')).toEqual({ ok: true });
    });

    expect(facades.listResolveEdges()).toEqual([
      { fromOwner: 'consumer', toOwner: 'producer', key: 'producer.facade' },
    ]);
    expect(() => registry.validateResolveImports(facades.listResolveEdges())).not.toThrow();

    const missingImportRegistry = new RuntimeHostModuleRegistry([
      {
        name: 'producer',
        manifest: { id: 'producer', exports: ['producer.facade'] },
      },
      {
        name: 'consumer',
        manifest: { id: 'consumer' },
      },
    ], {
      externalExports: ['producer'],
    });

    expect(() => missingImportRegistry.validateResolveImports(facades.listResolveEdges())).toThrow(
      'Runtime host module import not declared: consumer resolves producer.facade',
    );
  });

  it('runtime-host application service 只注册显式 token，不保留隐式 service bag 解析阶段', async () => {
    const moduleFiles = [
      'runtime-host/composition/modules/openclaw-application-module.ts',
      'runtime-host/composition/modules/runtime-application-module.ts',
      'runtime-host/composition/modules/external-connectors-application-module.ts',
      'runtime-host/composition/modules/operations-application-module.ts',
    ];

    for (const file of moduleFiles) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      const registerFunction = source.match(/export function register\w+ApplicationServices[\s\S]*?\n}\n\nexport function register\w+(?:Application)?Jobs/);
      expect(registerFunction?.[0] ?? '').not.toContain('return {');
      expect(source).toContain('export function register');
      expect(source).not.toMatch(/export function resolve\w+ApplicationServices/);
      expect(source).not.toMatch(/export function create\w+ApplicationServices/);
    }

    const registrySource = await readFile(path.join(process.cwd(), RUNTIME_HOST_APPLICATION_MODULE_REGISTRY_FILE), 'utf8');
    expect(registrySource).toContain("RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('services'");
    expect(registrySource).toContain('export function registerRuntimeHostModuleServices');
    expect(registrySource).not.toContain("RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('service-resolution'");
    expect(registrySource).not.toContain('export function resolveRuntimeHostModuleServices');
    expect(registrySource).not.toContain('application.services');
    expect(registrySource).not.toContain('registerContainerToken');
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
    expect(registrySource).toContain('context.container.withRegistrationOwner(module.name');
    expect(registrySource).toContain('context.container.withResolutionOwner(module.name');
    expect(registrySource).toContain('module.registerServices?.(context, {})');
    expect(registrySource).toContain("context.container.withResolutionOwner('gateway-bridge'");
    expect(registrySource).toContain("context.container.withResolutionOwner('session-runtime'");
    expect(registrySource).toContain('context.infrastructure.jobRegistry.withRegistrationOwner(module.name');
    expect(registrySource).toContain('context.infrastructure.lifecycle.withRegistrationOwner(module.name');
    expect(registrySource).not.toContain("RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('service-resolution'");
    expect(registrySource).not.toContain('module.resolveServices?.(context, modules)');
    expect(registrySource).toContain('export function registerRuntimeHostSystemServices');
    expect(registrySource).toContain('export function resolveRuntimeHostSystemModules');
    expect(registrySource).toContain("gatewayBridge: context.container.withResolutionOwner('gateway-bridge'");
    expect(registrySource).toContain("platformRuntime: context.container.withResolutionOwner('platform-runtime'");
    expect(registrySource).toContain("pluginRuntime: context.container.withResolutionOwner('plugin-runtime'");
    expect(registrySource).toContain("sessionRuntime: context.container.withResolutionOwner('session-runtime'");
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

  it('route modules 接收显式 facade，不直接读取 facade registry 或 container service token', async () => {
    const violations: string[] = [];

    for (const file of RUNTIME_HOST_ROUTE_MODULE_FILES) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      if (
        source.includes('ApplicationServiceRegistry')
        || source.includes('facades.resolve')
        || source.includes('RuntimeHostContainer')
        || source.includes('container.resolve')
      ) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });

  it('session routes 绑定显式 session facade，不绕过模块边界读取内部 service token', async () => {
    const source = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-route-module.ts'), 'utf8');
    const registrySource = await readFile(path.join(process.cwd(), 'runtime-host/composition/runtime-host-module-registry.ts'), 'utf8');

    expect(source).toContain('readonly sessionRuntimeService: SessionRuntimeService');
    expect(registrySource).toContain('sessionRuntimeService: context.facades.resolve(SESSION_RUNTIME_TOKEN)');
    expect(source).not.toContain("container.resolve<SessionRuntimeService>('session.runtime')");
    expect(source).not.toContain("container.resolve<SessionRuntimeService>('sessionRuntimeService')");
  });

  it('application routes 绑定逐服务 facade，不再经过粗粒度 application facade', async () => {
    const openClawRouteSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-route-module.ts'), 'utf8');
    const runtimeRouteSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/runtime-route-module.ts'), 'utf8');
    const operationsRouteSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-route-module.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), RUNTIME_HOST_OPENCLAW_APPLICATION_MODULE_FILE), 'utf8');
    const runtimeModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/runtime-application-module.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');
    const externalConnectorModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/external-connectors-application-module.ts'), 'utf8');
    const registrySource = await readFile(path.join(process.cwd(), 'runtime-host/composition/runtime-host-module-registry.ts'), 'utf8');
    const tokensSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/runtime-host-tokens.ts'), 'utf8');

    expect(openClawRouteSource).toContain('services: OpenClawRouteServices');
    expect(runtimeRouteSource).toContain('services: RuntimeRouteServices');
    expect(operationsRouteSource).toContain('services: OperationsRouteServices');
    expect(registrySource).toContain('context.facades.resolve(SETTINGS_SERVICE_TOKEN)');
    expect(registrySource).toContain('context.facades.resolve(WORKBENCH_SERVICE_TOKEN)');
    expect(registrySource).toContain('context.facades.resolve(CRON_SERVICE_TOKEN)');
    expect(registrySource).not.toContain('OPENCLAW_FACADE_TOKEN');
    expect(registrySource).not.toContain('RUNTIME_FACADE_TOKEN');
    expect(registrySource).not.toContain('OPERATIONS_FACADE_TOKEN');
    for (const source of [openClawRouteSource, runtimeRouteSource, operationsRouteSource]) {
      expect(source).not.toContain('container.resolve');
      expect(source).not.toContain('ApplicationFacade');
      expect(source).not.toMatch(/container\.resolve<\w+Service>\('[^']+\.service'\)/);
    }
    expect(openClawModuleSource).not.toContain('OpenClawApplicationFacade');
    expect(openClawModuleSource).not.toContain("container.register('openclaw.facade'");
    expect(openClawModuleSource).toContain("facades.registerContainerFacade('openclaw', SETTINGS_SERVICE_TOKEN, container)");
    expect(runtimeModuleSource).not.toContain('RuntimeApplicationFacade');
    expect(runtimeModuleSource).not.toContain("container.register('runtime.facade'");
    expect(runtimeModuleSource).toContain("facades.registerContainerFacade('runtime', WORKBENCH_SERVICE_TOKEN, container)");
    expect(operationsModuleSource).not.toContain('OperationsApplicationFacade');
    expect(operationsModuleSource).not.toContain("container.register('operations.facade'");
    expect(operationsModuleSource).toContain("facades.registerContainerFacade('operations', CRON_SERVICE_TOKEN, container)");
    expect(externalConnectorModuleSource).toContain("facades.registerContainerFacade('external-connectors', EXTERNAL_CONNECTOR_SERVICE_TOKEN, container)");
    expect(tokensSource).not.toContain('OPENCLAW_FACADE_TOKEN');
    expect(tokensSource).not.toContain('RUNTIME_FACADE_TOKEN');
    expect(tokensSource).not.toContain('OPERATIONS_FACADE_TOKEN');
  });

  it('external connector core 独立于 operations 与 OpenClaw，OpenClaw 只作为 downstream projection 接入', async () => {
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');
    const externalConnectorModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/external-connectors-application-module.ts'), 'utf8');
    const externalConnectorServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/external-connectors/external-connector-service.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), RUNTIME_HOST_OPENCLAW_APPLICATION_MODULE_FILE), 'utf8');
    const registrySource = await readFile(path.join(process.cwd(), RUNTIME_HOST_APPLICATION_MODULE_REGISTRY_FILE), 'utf8');

    expect(operationsModuleSource).not.toContain('ExternalConnector');
    expect(operationsModuleSource).not.toContain('externalConnectors');
    expect(operationsModuleSource).not.toContain('external-connector');
    expect(externalConnectorModuleSource).not.toContain('OpenClaw');
    expect(externalConnectorModuleSource).not.toContain('openclaw.configRepository');
    expect(externalConnectorServiceSource).not.toContain('OpenClaw');
    expect(externalConnectorServiceSource).toContain('ExternalConnectorProjectionSourcePort');
    expect(externalConnectorServiceSource).toContain('listConnectorSpecs()');
    expect(openClawModuleSource).toContain('connectOpenClawApplicationServices');
    expect(openClawModuleSource).toContain('ExternalConnectorOpenClawMcpProjectionService');
    expect(openClawModuleSource).toContain('externalConnectors.registerProjection');
    expect(registrySource).toContain("name: 'external-connectors'");
    expect(registrySource).toContain("connectImports: ['external-connectors']");
    expect(registrySource).toContain("'runtimeHost.runtimeDataRoot'");
    expect(externalConnectorModuleSource).toContain("scope.resolve<RuntimeDataRootPort>('runtimeHost.runtimeDataRoot')");
    expect(operationsModuleSource).not.toContain("container.register('externalConnectors.");
  });

  it('gateway control 属于系统模块能力，不允许藏在 openclaw application service 注册里', async () => {
    const source = await readFile(path.join(process.cwd(), RUNTIME_HOST_OPENCLAW_APPLICATION_MODULE_FILE), 'utf8');

    expect(source).not.toContain("container.register('gateway.control'");
    expect(source).not.toContain('new ParentShellGatewayControl');
  });

  it('session routes are explicit endpoint/session identity API boundaries, not implicit OpenClaw defaults', async () => {
    const routeSource = await readFile(path.join(process.cwd(), 'runtime-host/api/routes/session-routes.ts'), 'utf8');
    const hostApiSource = await readFile(path.join(process.cwd(), 'src/lib/host-api.ts'), 'utf8');
    const commandWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-command/session-command-operations-workflow.ts'), 'utf8');
    const catalogWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-catalog/session-catalog-workflow.ts'), 'utf8');

    expect(routeSource).toContain('LEGACY_READ_ONLY_SESSION_ROUTES');
    expect(routeSource).toContain("sessionReadOnlyRoute('/api/sessions/list'");
    expect(routeSource).toContain("rejectedSessionRoute('/api/sessions/prompt'");
    expect(routeSource).toContain('validateLegacyReadOnlySessionPayload');
    expect(routeSource).toContain('sanitizeReadOnlyRouteResponse(await operation(service, context.payload))');
    expect(routeSource).not.toContain('OPENCLAW');
    expect(routeSource).not.toContain('openclaw');
    expect(hostApiSource).toContain("capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID");
    expect(hostApiSource).toContain("operationId: 'sessions.list'");
    expect(hostApiSource).toContain("capabilityId: SESSION_PROMPT_CAPABILITY_ID");
    expect(hostApiSource).toContain("operationId: payload.media?.length ? 'sessions.sendWithMedia' : 'sessions.prompt'");
    expect(hostApiSource).not.toContain('/api/sessions/');
    expect(hostApiSource).toContain('buildCapabilityScopeKey(scope)');
    expect(hostApiSource).toContain('capabilityScopeInflight');
    expect(hostApiSource).toContain('available scopes:');
    expect(commandWorkflowSource).toContain('readSessionListRequest(payload)');
    expect(commandWorkflowSource).toContain('RuntimeEndpointRef is required');
    expect(commandWorkflowSource).toContain('SessionIdentity is required');
    expect(catalogWorkflowSource).toContain('buildSessionIdentityKey(session.sessionIdentity)');
    expect(catalogWorkflowSource).toContain('resolveEndpointForRef(sessionIdentity.endpoint, sessionIdentity.agentId)');
  });

  it('renderer 外部调用点不直接使用 hostCapabilityExecute', async () => {
    const srcFiles = await listSourceFiles(path.join(process.cwd(), 'src'));
    const offenders: string[] = [];
    for (const file of srcFiles) {
      if (path.relative(process.cwd(), file).replace(/\\/g, '/') === 'src/lib/host-api.ts') {
        continue;
      }
      const source = await readFile(file, 'utf8');
      if (source.includes('hostCapabilityExecute')) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('gateway bridge 按 runtime endpoint scope 更新 endpoint 状态，不回退到 OpenClaw 单例寻址', async () => {
    const bridgeSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge.ts'), 'utf8');
    const moduleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/gateway-bridge-module.ts'), 'utf8');
    const registrySource = await readFile(path.join(process.cwd(), 'runtime-host/application/agent-runtime/contracts/agent-runtime-registry.ts'), 'utf8');

    expect(bridgeSource).toContain('updateRuntimeEndpointControlState');
    expect(bridgeSource).toContain('endpoint: deps.runtimeHostEndpoint');
    expect(bridgeSource).not.toContain('updateOpenClawControlState');
    expect(moduleSource).toContain('resolveRuntimeHostEndpoint');
    expect(moduleSource).toContain('capability.id === RUNTIME_HOST_CAPABILITY_ID');
    expect(moduleSource).toContain("from '../../application/adapters/openclaw/gateway/openclaw-gateway-event-bridge'");
    expect(moduleSource).toContain("scope.kind !== 'runtime-instance'");
    expect(moduleSource).not.toContain('resolveOpenClawRuntimeHostCapabilityAddress');
    expect(moduleSource).not.toContain('OPENCLAW_RUNTIME_ENDPOINT_ID');
    expect(moduleSource).not.toContain('Expected exactly one OpenClaw runtime.host capability');
    expect(registrySource).toContain('resolveEndpointForRef(endpointRef: RuntimeEndpointRef');
    expect(registrySource).toContain('const endpoint = this.endpoints.getByRef(endpointRef)');
    expect(registrySource).toContain('updateRuntimeEndpointControlState(input: {');
  });

  it('ACP connector 由独立 connector module 注册，不藏在 OpenClaw infrastructure 里', async () => {
    const openClawSource = await readFile(path.join(process.cwd(), RUNTIME_HOST_OPENCLAW_INFRASTRUCTURE_MODULE_FILE), 'utf8');
    const acpSource = await readFile(path.join(process.cwd(), RUNTIME_HOST_ACP_CONNECTOR_MODULE_FILE), 'utf8');
    const connectorSource = await readFile(path.join(process.cwd(), 'runtime-host/application/agent-runtime/protocol-connectors/acp/acp-client-connector.ts'), 'utf8');
    const registrySource = await readFile(path.join(process.cwd(), RUNTIME_HOST_SYSTEM_MODULE_REGISTRY_FILE), 'utf8');

    expect(openClawSource).not.toContain('AcpClientConnector');
    expect(openClawSource).not.toContain("runtime.connectorRegistrationFactories'");
    expect(openClawSource).toContain("container.contribute('runtime.adapterRegistrationFactories'");
    expect(acpSource).toContain('createAcpClientConnector');
    expect(acpSource).toContain('new AcpProtocolAdapter()');
    expect(acpSource).toContain('acpEndpointTemplates');
    expect(acpSource).toContain('new AcpStdioTransport(endpoint)');
    expect(acpSource).toContain("container.contribute('runtime.connectorRegistrationFactories'");
    expect(connectorSource).toContain('readonly createTransport: (endpoint: RuntimeEndpointProfile) => RuntimeSessionTransport');
    expect(connectorSource).not.toContain('AcpStdioTransport');
    expect(connectorSource).not.toContain('acpEndpointTemplates');
    expect(connectorSource).not.toContain('new AcpProtocolAdapter');
    expect(registrySource).toContain("name: 'acp-connector'");
    expect(registrySource).toContain("exports: ['runtime.connectorRegistrationFactories']");
  });

  it('agent runtime endpoint keying 不保留 legacy prefix 默认路由语义', async () => {
    const contractSource = await readFile(path.join(process.cwd(), RUNTIME_HOST_AGENT_RUNTIME_CONTRACT_FILE), 'utf8');
    const openClawProfileSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/runtime/openclaw-profile.ts'), 'utf8');

    expect(contractSource).not.toContain('legacyPrefix');
    expect(openClawProfileSource).not.toContain('legacyPrefix');
  });

  it('ClawHub skill 安装卸载编排留在 workflow 层，不回流到 ClawHub service', async () => {
    const clawHubServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/skills/clawhub.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/skill-install/clawhub-skill-install-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class ClawHubSkillInstallWorkflow');
    expect(workflowSource).toContain('runWithRegistryFallback');
    expect(workflowSource).toContain('removeLockEntry');
    expect(clawHubServiceSource).toContain('skillInstallWorkflow');
    expect(clawHubServiceSource).not.toContain('runWithRegistryFallback');
    expect(clawHubServiceSource).not.toContain('removeLockEntry');
    expect(clawHubServiceSource).not.toContain('new ClawHubSkillInstallWorkflow');
    expect(openClawModuleSource).toContain("container.register('clawhub.skillInstallWorkflow'");
    expect(openClawModuleSource).toContain("skillInstallWorkflow: scope.resolve<ClawHubSkillInstallWorkflow>('clawhub.skillInstallWorkflow')");
  });

  it('skill 本地导入文件编排留在 workflow 层，不回流到 skills service', async () => {
    const skillsServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/skills/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/skill-install/local-skill-import-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class LocalSkillImportWorkflow');
    expect(workflowSource).toContain('prepareImportSource');
    expect(workflowSource).toContain('extractZipArchive');
    expect(workflowSource).toContain('createMarkdownSkillDirectory');
    expect(skillsServiceSource).toContain('operationsWorkflow');
    expect(skillsServiceSource).not.toContain('prepareImportSource');
    expect(skillsServiceSource).not.toContain('extractZipArchive');
    expect(skillsServiceSource).not.toContain('createMarkdownSkillDirectory');
    expect(skillsServiceSource).not.toContain('RuntimeCommandExecutorPort');
    expect(skillsServiceSource).not.toContain('RuntimeSystemEnvironmentPort');
    expect(openClawModuleSource).toContain("container.register('skills.localImportWorkflow'");
    expect(openClawModuleSource).toContain("container.register('skills.operationsWorkflow'");
    expect(openClawModuleSource).toContain("localSkillImportWorkflow: scope.resolve<LocalSkillImportWorkflow>('skills.localImportWorkflow')");
    expect(openClawModuleSource).toContain("operationsWorkflow: scope.resolve<SkillsOperationsWorkflow>('skills.operationsWorkflow')");
  });

  it('skill 状态 mutation、job submit 与 readme payload 编排留在 operations workflow 层，不回流到 skills service', async () => {
    const skillsServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/skills/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/skill-runtime/skills-operations-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SkillsOperationsWorkflow');
    expect(workflowSource).toContain('submitImportLocal');
    expect(workflowSource).toContain('submitGatewayUpdate');
    expect(workflowSource).toContain('setManyEnabled');
    expect(workflowSource).toContain('readRequiredSourcePath');
    expect(workflowSource).toContain('readmePreviews.read');
    expect(workflowSource).toContain('Failed to refresh skills after batch state update');
    expect(skillsServiceSource).toContain('operationsWorkflow');
    expect(skillsServiceSource).not.toContain('submitImportLocal');
    expect(skillsServiceSource).not.toContain('submitGatewayUpdate');
    expect(skillsServiceSource).not.toContain('setManyEnabled');
    expect(skillsServiceSource).not.toContain('readRequiredSourcePath');
    expect(skillsServiceSource).not.toContain('readmePreviews.read');
    expect(skillsServiceSource).not.toContain('Failed to refresh skills after batch state update');
    expect(openClawModuleSource).toContain("container.register('skills.operationsWorkflow'");
    expect(openClawModuleSource).toContain("operationsWorkflow: scope.resolve<SkillsOperationsWorkflow>('skills.operationsWorkflow')");
  });

  it('skill runtime gateway 状态编排留在 workflow 层，不回流到 skills service', async () => {
    const skillsServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/skills/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/skill-runtime/skill-runtime-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SkillRuntimeWorkflow');
    expect(workflowSource).toContain('isGatewayReadyForSnapshot');
    expect(workflowSource).toContain("gatewayRpc('skills.status')");
    expect(workflowSource).toContain("gatewayRpc('skills.update'");
    expect(workflowSource).toContain('listInstalledSkillInventory');
    expect(workflowSource).toContain('readVisibleBuiltinSkillKeys');
    expect(workflowSource).toContain('buildInstalledStatusSnapshot');
    expect(skillsServiceSource).toContain('skillRuntimeWorkflow');
    expect(skillsServiceSource).not.toContain('isGatewayReadyForSnapshot');
    expect(skillsServiceSource).not.toContain("gatewayRpc('skills.status')");
    expect(skillsServiceSource).not.toContain("gatewayRpc('skills.update'");
    expect(skillsServiceSource).not.toContain('statusSnapshotReady');
    expect(skillsServiceSource).not.toContain('listInstalledSkillInventory');
    expect(skillsServiceSource).not.toContain('readVisibleBuiltinSkillKeys');
    expect(skillsServiceSource).not.toContain('buildInstalledStatusSnapshot');
    expect(skillsServiceSource).not.toContain('new SkillRuntimeWorkflow');
    expect(openClawModuleSource).toContain("container.register('skills.runtimeWorkflow'");
    expect(openClawModuleSource).toContain("skillRuntimeWorkflow: scope.resolve<SkillRuntimeWorkflow>('skills.runtimeWorkflow')");
  });

  it('gateway prelaunch 跨能力编排留在 runtime-bootstrap workflow 层，不回流到 bootstrap service', async () => {
    const bootstrapServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/runtime-host/bootstrap.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/runtime-bootstrap/gateway-prelaunch-workflow.ts'), 'utf8');
    const runtimeModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/runtime-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class GatewayPrelaunchWorkflow');
    expect(workflowSource).toContain('syncRuntimeConfigForLaunch');
    expect(workflowSource).toContain('syncProviderStackToRuntime');
    expect(workflowSource).toContain('applySavedPolicyToPluginConfig');
    expect(bootstrapServiceSource).toContain('gatewayPrelaunchWorkflow');
    expect(bootstrapServiceSource).not.toContain('normalizeBrowserMode');
    expect(bootstrapServiceSource).not.toContain('syncProviderStackToRuntime');
    expect(bootstrapServiceSource).not.toContain('ensureConfiguredManagedPluginsForGatewayLaunch');
    expect(bootstrapServiceSource).not.toContain('new GatewayPrelaunchWorkflow');
    expect(runtimeModuleSource).toContain("container.register('runtimeHost.gatewayPrelaunchWorkflow'");
    expect(runtimeModuleSource).toContain("gatewayPrelaunchWorkflow: scope.resolve<GatewayPrelaunchWorkflow>('runtimeHost.gatewayPrelaunchWorkflow')");
  });

  it('prelaunch maintenance cache 读写、签名与跳过判定留在 workflow 层，不回流到 repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/runtime-host/prelaunch-maintenance-cache.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/runtime-bootstrap/prelaunch-maintenance-cache-workflow.ts'), 'utf8');
    const runtimeModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/runtime-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class PrelaunchMaintenanceCacheWorkflow');
    expect(workflowSource).toContain('readCache');
    expect(workflowSource).toContain('writeCache');
    expect(workflowSource).toContain('directoryChildrenSignature');
    expect(workflowSource).toContain('pathSignature');
    expect(workflowSource).toContain('stableJson');
    expect(workflowSource).toContain('cache-hit');
    expect(repositorySource).toContain('cacheWorkflow');
    expect(repositorySource).not.toContain('readCache');
    expect(repositorySource).not.toContain('writeCache');
    expect(repositorySource).not.toContain('function stableJson');
    expect(repositorySource).not.toContain('function pathSignature');
    expect(repositorySource).not.toContain('cache-hit');
    expect(repositorySource).not.toContain('new PrelaunchMaintenanceCacheWorkflow');
    expect(runtimeModuleSource).toContain("container.register('runtimeHost.prelaunchMaintenanceCacheWorkflow'");
    expect(runtimeModuleSource).toContain("scope.resolve<PrelaunchMaintenanceCacheWorkflow>('runtimeHost.prelaunchMaintenanceCacheWorkflow')");
  });

  it('runtime-host 启动、诊断和 job 查询编排留在 workflow 层，不回流到 runtime-host service', async () => {
    const runtimeHostServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/runtime-host/service.ts'), 'utf8');
    const operationsWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/runtime-host/runtime-host-operations-workflow.ts'), 'utf8');
    const diagnosticsWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/diagnostics/diagnostics-collection-workflow.ts'), 'utf8');
    const runtimeModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/runtime-application-module.ts'), 'utf8');

    expect(operationsWorkflowSource).toContain('export class RuntimeHostOperationsWorkflow');
    expect(operationsWorkflowSource).toContain('submitGatewayPrelaunch');
    expect(operationsWorkflowSource).toContain('buildProviderEnvMap');
    expect(operationsWorkflowSource).toContain('buildGatewayLaunchPlan');
    expect(operationsWorkflowSource).toContain('submitProviderAuthBootstrap');
    expect(operationsWorkflowSource).toContain('diagnosticsCollectionWorkflow.execute');
    expect(operationsWorkflowSource).toContain('jobs.list');
    expect(operationsWorkflowSource).toContain('jobs.get');
    expect(diagnosticsWorkflowSource).toContain('export class DiagnosticsCollectionWorkflow');
    expect(diagnosticsWorkflowSource).toContain('host_diagnostics_snapshot');
    expect(diagnosticsWorkflowSource).toContain('licenseGateSnapshot');
    expect(diagnosticsWorkflowSource).toContain('submitCollect');
    expect(runtimeHostServiceSource).toContain('operationsWorkflow');
    expect(runtimeHostServiceSource).not.toContain('submitGatewayPrelaunch');
    expect(runtimeHostServiceSource).not.toContain('buildProviderEnvMap');
    expect(runtimeHostServiceSource).not.toContain('buildGatewayLaunchPlan');
    expect(runtimeHostServiceSource).not.toContain('submitProviderAuthBootstrap');
    expect(runtimeHostServiceSource).not.toContain('diagnosticsCollectionWorkflow');
    expect(runtimeHostServiceSource).not.toContain('jobs.list');
    expect(runtimeHostServiceSource).not.toContain('jobs.get');
    expect(runtimeHostServiceSource).not.toContain('host_diagnostics_snapshot');
    expect(runtimeHostServiceSource).not.toContain('licenseGateSnapshot');
    expect(runtimeHostServiceSource).not.toContain('submitCollect');
    expect(runtimeHostServiceSource).not.toContain('new RuntimeHostOperationsWorkflow');
    expect(runtimeHostServiceSource).not.toContain('new DiagnosticsCollectionWorkflow');
    expect(runtimeModuleSource).toContain("container.register('runtimeHost.operationsWorkflow'");
    expect(runtimeModuleSource).toContain("container.register('diagnostics.collectionWorkflow'");
    expect(runtimeModuleSource).toContain("operationsWorkflow: scope.resolve<RuntimeHostOperationsWorkflow>('runtimeHost.operationsWorkflow')");
  });

  it('session runtime store JSON 持久化与默认恢复留在 workflow 层，不回流到 repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-runtime-store-repository.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-runtime-store/session-runtime-store-persistence-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionRuntimeStorePersistenceWorkflow');
    expect(workflowSource).toContain('matchaclaw-session-runtime-store.json');
    expect(workflowSource).toContain('createDefaultSessionRuntimeStore');
    expect(workflowSource).toContain('normalizeActiveSessionKey');
    expect(workflowSource).toContain('JSON.parse');
    expect(workflowSource).toContain('JSON.stringify(payload, null, 2)');
    expect(repositorySource).toContain('persistenceWorkflow');
    expect(repositorySource).not.toContain('matchaclaw-session-runtime-store.json');
    expect(repositorySource).not.toContain('JSON.parse');
    expect(repositorySource).not.toContain('JSON.stringify');
    expect(repositorySource).not.toContain('normalizeActiveSessionKey');
    expect(repositorySource).not.toContain('createDefaultSessionRuntimeStore');
    expect(repositorySource).not.toContain('new SessionRuntimeStorePersistenceWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionRuntimeStorePersistenceWorkflow'");
    expect(sessionModuleSource).toContain("persistenceWorkflow: scope.resolve<SessionRuntimeStorePersistenceWorkflow>('sessionRuntimeStorePersistenceWorkflow')");
  });

  it('session storage 索引写入和 artefact 清理编排留在 mutation workflow 层，不回流到 repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-storage-repository.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-storage/session-storage-mutation-workflow.ts'), 'utf8');
    const repositoryWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-storage/session-storage-repository-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionStorageMutationWorkflow');
    expect(workflowSource).toContain('updateStorageIndexSessionIdentity');
    expect(workflowSource).toContain('updateStorageIndexStatus');
    expect(workflowSource).toContain('updateStorageIndexLabel');
    expect(workflowSource).toContain('removeSessionFromStorageIndex');
    expect(workflowSource).toContain('removeSessionArtefacts');
    expect(workflowSource).toContain('removeExternalTrajectory');
    expect(repositoryWorkflowSource).toContain('findWritableDescriptor');
    expect(repositoryWorkflowSource).toContain('invalidateAgentDescriptorsCache');
    expect(repositorySource).toContain('repositoryWorkflow');
    expect(repositorySource).not.toContain('updateStorageIndexSessionIdentity');
    expect(repositorySource).not.toContain('updateStorageIndexStatus');
    expect(repositorySource).not.toContain('updateStorageIndexLabel');
    expect(repositorySource).not.toContain('removeSessionFromStorageIndex');
    expect(repositorySource).not.toContain('removeSessionArtefacts');
    expect(repositorySource).not.toContain('removeExternalTrajectory');
    expect(repositorySource).not.toContain('JSON.stringify(updateStorageIndex');
    expect(repositorySource).not.toContain('fileSystem.removeFile');
    expect(repositorySource).not.toContain('descriptor?.sessionsJson');
    expect(repositorySource).not.toContain('invalidateAgentDescriptorsCache');
    expect(repositorySource).not.toContain('new SessionStorageMutationWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionStorageRepositoryWorkflow'");
    expect(sessionModuleSource).toContain("container.register('sessionStorageMutationWorkflow'");
    expect(sessionModuleSource).toContain("repositoryWorkflow: scope.resolve<SessionStorageRepositoryWorkflow>('sessionStorageRepositoryWorkflow')");
    expect(sessionModuleSource).toContain("mutationWorkflow: scope.resolve<SessionStorageMutationWorkflow>('sessionStorageMutationWorkflow')");
  });

  it('session lifecycle 状态写入编排留在 workflow 层，不回流到 command service', async () => {
    const commandServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-command-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-lifecycle/session-lifecycle-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionLifecycleWorkflow');
    expect(workflowSource).toContain('activateSession');
    expect(workflowSource).toContain('upsertSessionIdentity');
    expect(workflowSource).toContain('deleteSession');
    expect(workflowSource).toContain('updateSessionStatus');
    expect(workflowSource).toContain('refreshCatalogQuietly');
    expect(commandServiceSource).toContain('operationsWorkflow');
    expect(commandServiceSource).not.toContain('sessionLifecycleWorkflow');
    expect(commandServiceSource).not.toContain('activateSession');
    expect(commandServiceSource).not.toContain('upsertSessionIdentity');
    expect(commandServiceSource).not.toContain('await this.deps.sessionStorage.deleteSession');
    expect(commandServiceSource).not.toContain('await this.deps.sessionStorage.updateSessionStatus');
    expect(commandServiceSource).not.toContain('refreshCache().catch');
    expect(commandServiceSource).not.toContain('new SessionLifecycleWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionLifecycleWorkflow'");
    expect(sessionModuleSource).toContain("container.register('sessionCommandOperationsWorkflow'");
    expect(sessionModuleSource).toContain("sessionLifecycleWorkflow: scope.resolve('sessionLifecycleWorkflow')");
    expect(sessionModuleSource).toContain("operationsWorkflow: scope.resolve('sessionCommandOperationsWorkflow')");
  });

  it('session run 慢路径和 runtime send 编排留在 workflow 层，不回流到 prompt service', async () => {
    const promptServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-prompt-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-run/session-run-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionRunWorkflow');
    expect(workflowSource).toContain('rememberSessionIdentity');
    expect(workflowSource).toContain('commitSubmittedPrompt');
    expect(workflowSource).toContain('startRuntimeSendInBackground');
    expect(workflowSource).toContain('buildRuntimePromptPayload');
    expect(workflowSource).toContain('failSubmittedPrompt');
    expect(promptServiceSource).toContain('sessionRunWorkflow.execute');
    expect(promptServiceSource).not.toContain('appendCanonicalEvents');
    expect(promptServiceSource).not.toContain('resolveTransport');
    expect(promptServiceSource).not.toContain('buildSendWithMediaGatewayParams');
    expect(promptServiceSource).not.toContain('flushPersistedStore');
    expect(promptServiceSource).not.toContain('new SessionRunWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionRunWorkflow'");
    expect(sessionModuleSource).toContain("sessionRunWorkflow: scope.resolve('sessionRunWorkflow')");
  });

  it('session command 请求解析、hydration、approval 与 model selection 编排留在 operations workflow 层，不回流到 command service', async () => {
    const commandServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-command-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-command/session-command-operations-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionCommandOperationsWorkflow');
    expect(workflowSource).toContain('readCreateSessionRequest');
    expect(workflowSource).toContain('readSessionWindowRequest');
    expect(workflowSource).toContain('readResolveApprovalRequest');
    expect(workflowSource).toContain('listApprovals(sessionIdentity)');
    expect(workflowSource).toContain('sessionHydrationWorkflow.load');
    expect(workflowSource).toContain('sessionApprovalWorkflow.resolve');
    expect(workflowSource).toContain('sessionModelSelectionWorkflow.patch');
    expect(commandServiceSource).toContain('operationsWorkflow');
    expect(commandServiceSource).not.toContain('readCreateSessionRequest');
    expect(commandServiceSource).not.toContain('readSessionWindowRequest');
    expect(commandServiceSource).not.toContain('readResolveApprovalRequest');
    expect(commandServiceSource).not.toContain('listApprovals(sessionIdentity)');
    expect(commandServiceSource).not.toContain('sessionHydrationWorkflow.load');
    expect(commandServiceSource).not.toContain('sessionApprovalWorkflow.resolve');
    expect(commandServiceSource).not.toContain('sessionModelSelectionWorkflow.patch');
    expect(sessionModuleSource).toContain("container.register('sessionCommandOperationsWorkflow'");
    expect(sessionModuleSource).toContain("operationsWorkflow: scope.resolve('sessionCommandOperationsWorkflow')");
  });

  it('session snapshot 窗口、usage、artifact 与 metadata 投影留在 workflow 层，不回流到 snapshot service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-snapshot-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-snapshot/session-snapshot-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionSnapshotWorkflow');
    expect(workflowSource).toContain('buildWindowRange');
    expect(workflowSource).toContain('buildUsageSnapshotItems');
    expect(workflowSource).toContain('buildArtifactSnapshotItems');
    expect(workflowSource).toContain('resolveSessionModel');
    expect(workflowSource).toContain('readSessionStoreLabel');
    expect(serviceSource).toContain('snapshotWorkflow');
    expect(serviceSource).not.toContain('buildWindowRange');
    expect(serviceSource).not.toContain('buildUsageSnapshotItems');
    expect(serviceSource).not.toContain('buildArtifactSnapshotItems');
    expect(serviceSource).not.toContain('resolveSessionModel');
    expect(serviceSource).not.toContain('readSessionStoreLabel');
    expect(serviceSource).not.toContain('new SessionSnapshotWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionSnapshotWorkflow'");
    expect(sessionModuleSource).toContain("snapshotWorkflow: scope.resolve<SessionSnapshotWorkflow>('sessionSnapshotWorkflow')");
  });

  it('session metadata 模型解析优先级留在 workflow 层，不回流到 metadata repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-metadata-repository.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-metadata/session-model-resolution-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionModelResolutionWorkflow');
    expect(workflowSource).toContain('readSessionStoreResolvedModel');
    expect(workflowSource).toContain('qualifySessionModel');
    expect(workflowSource).toContain('resolveAgentConfigDefaultModel');
    expect(workflowSource).toContain('readAgentModelValue');
    expect(repositorySource).toContain('modelResolutionWorkflow');
    expect(repositorySource).not.toContain('readSessionStoreResolvedModel');
    expect(repositorySource).not.toContain('qualifySessionModel');
    expect(repositorySource).not.toContain('resolveAgentConfigDefaultModel(');
    expect(repositorySource).not.toContain('readAgentModelValue(');
    expect(repositorySource).not.toContain('new SessionModelResolutionWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionModelResolutionWorkflow'");
    expect(sessionModuleSource).toContain("modelResolutionWorkflow: scope.resolve<SessionModelResolutionWorkflow>('sessionModelResolutionWorkflow')");
  });

  it('session catalog 扫描、缓存、overlay 与 transcript 解析留在 workflow 层，不回流到 catalog service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-catalog.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-catalog/session-catalog-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionCatalogWorkflow');
    expect(workflowSource).toContain('SESSION_CATALOG_SCAN_CONCURRENCY');
    expect(workflowSource).toContain('resolveTranscriptCatalogDetails');
    expect(workflowSource).toContain('buildSessionCatalogItem');
    expect(workflowSource).toContain('forEachWithConcurrency');
    expect(workflowSource).toContain('cachedSessions');
    expect(workflowSource).toContain('buildOverlayCatalogItem');
    expect(serviceSource).toContain('catalogWorkflow');
    expect(serviceSource).not.toContain('SESSION_CATALOG_SCAN_CONCURRENCY');
    expect(serviceSource).not.toContain('resolveTranscriptCatalogDetails');
    expect(serviceSource).not.toContain('buildSessionCatalogItem');
    expect(serviceSource).not.toContain('forEachWithConcurrency');
    expect(serviceSource).not.toContain('cachedSessions');
    expect(serviceSource).not.toContain('buildOverlayCatalogItem');
    expect(serviceSource).not.toContain('new SessionCatalogWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionCatalogWorkflow'");
    expect(sessionModuleSource).toContain("catalogWorkflow: scope.resolve<SessionCatalogWorkflow>('sessionCatalogWorkflow')");
  });

  it('session transcript stat/read/line streaming 留在 transcript workflow 层，不回流到 storage repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-storage-repository.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-storage/session-storage-transcript-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionStorageTranscriptWorkflow');
    expect(workflowSource).toContain('getTranscriptFingerprint');
    expect(workflowSource).toContain('readTranscriptDescriptorContent');
    expect(workflowSource).toContain('readTranscriptDescriptorLines');
    expect(workflowSource).toContain('fileSystem.stat(pathname)');
    expect(workflowSource).toContain('readTextFile(descriptor.transcriptPath)');
    expect(workflowSource).toContain('readTextFileLines(descriptor.transcriptPath)');
    expect(repositorySource).toContain('repositoryWorkflow');
    expect(repositorySource).not.toContain('fileSystem.stat(pathname)');
    expect(repositorySource).not.toContain('readTextFile(descriptor.transcriptPath)');
    expect(repositorySource).not.toContain('readTextFileLines(descriptor.transcriptPath)');
    expect(repositorySource).not.toContain('new SessionStorageTranscriptWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionStorageTranscriptWorkflow'");
    expect(sessionModuleSource).toContain("transcriptWorkflow: scope.resolve<SessionStorageTranscriptWorkflow>('sessionStorageTranscriptWorkflow')");
  });

  it('session storage 目录扫描、索引解析与 descriptor 缓存留在 index workflow 层，不回流到 repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-storage-repository.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-storage/session-storage-index-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionStorageIndexWorkflow');
    expect(workflowSource).toContain('agentDescriptorsCache');
    expect(workflowSource).toContain('readJsonRecordFromFileSystem');
    expect(workflowSource).toContain('listAgentStorageDescriptors');
    expect(workflowSource).toContain('listTranscriptStorageDescriptors');
    expect(workflowSource).toContain('resolveIndexedTranscriptPath');
    expect(workflowSource).toContain('fingerprintEqual');
    expect(repositorySource).toContain('repositoryWorkflow');
    expect(repositorySource).not.toContain('agentDescriptorsCache');
    expect(repositorySource).not.toContain('readJsonRecordFromFileSystem');
    expect(repositorySource).not.toContain('listAgentStorageDescriptors');
    expect(repositorySource).not.toContain('listTranscriptStorageDescriptors');
    expect(repositorySource).not.toContain('resolveIndexedTranscriptPath');
    expect(repositorySource).not.toContain('fingerprintEqual');
    expect(repositorySource).not.toContain('new SessionStorageIndexWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionStorageIndexWorkflow'");
    expect(sessionModuleSource).toContain("indexWorkflow: scope.resolve<SessionStorageIndexWorkflow>('sessionStorageIndexWorkflow')");
  });

  it('session operation 结果解析与最新结果记忆留在 workflow 层，不回流到 coordinator', async () => {
    const coordinatorSource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-operation-coordinator.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-operation/session-operation-result-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionOperationResultWorkflow');
    expect(workflowSource).toContain('latestResults');
    expect(workflowSource).toContain('rememberResult');
    expect(workflowSource).toContain('readSnapshot');
    expect(workflowSource).toContain('isSessionStateSnapshot');
    expect(coordinatorSource).toContain('queues');
    expect(coordinatorSource).toContain('resultWorkflow');
    expect(coordinatorSource).not.toContain('latestResults');
    expect(coordinatorSource).not.toContain('readSnapshot');
    expect(coordinatorSource).not.toContain('isSessionStateSnapshot');
    expect(coordinatorSource).not.toContain('new SessionOperationResultWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionOperationResultWorkflow'");
    expect(sessionModuleSource).toContain("scope.resolve<SessionOperationResultWorkflow>('sessionOperationResultWorkflow')");
  });

  it('session gateway ingress 事件编排留在 workflow 层，不回流到 ingress service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/sessions/session-gateway-ingress-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/session-gateway-ingress/session-gateway-ingress-workflow.ts'), 'utf8');
    const sessionModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/session-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SessionGatewayIngressWorkflow');
    expect(workflowSource).toContain('appendCanonicalEvents');
    expect(workflowSource).toContain('buildSnapshot');
    expect(workflowSource).toContain('resolveEndpointForRef(endpointRef)');
    expect(workflowSource).toContain('rememberSessionIdentity(identity)');
    expect(workflowSource).toContain('translate(payload, context)');
    expect(serviceSource).toContain('ingressWorkflow');
    expect(serviceSource).not.toContain('appendCanonicalEvents');
    expect(serviceSource).not.toContain('buildSnapshot');
    expect(serviceSource).not.toContain('resolveEndpointForRef(endpointRef)');
    expect(serviceSource).not.toContain('translate(payload, context)');
    expect(serviceSource).not.toContain('new SessionGatewayIngressWorkflow');
    expect(sessionModuleSource).toContain("container.register('sessionGatewayIngressWorkflow'");
    expect(sessionModuleSource).toContain("ingressWorkflow: scope.resolve<SessionGatewayIngressWorkflow>('sessionGatewayIngressWorkflow')");
  });

  it('plugin runtime catalog 装饰与启用提交留在 workflow 层，不回流到 plugin runtime service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/plugins/plugin-runtime-service.ts'), 'utf8');
    const catalogRepositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/plugins/catalog.ts'), 'utf8');
    const operationsWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/plugin-runtime/plugin-runtime-operations-workflow.ts'), 'utf8');
    const catalogWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/plugin-runtime/plugin-catalog-discovery-workflow.ts'), 'utf8');
    const runtimeModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/runtime-application-module.ts'), 'utf8');

    expect(operationsWorkflowSource).toContain('export class PluginRuntimeOperationsWorkflow');
    expect(operationsWorkflowSource).toContain('enqueueRefresh');
    expect(operationsWorkflowSource).toContain('getEnabledPluginIds');
    expect(operationsWorkflowSource).toContain('decoratePluginCatalogEntry');
    expect(operationsWorkflowSource).toContain('submitSetEnabledPlugins');
    expect(operationsWorkflowSource).toContain('pluginIds 必须是 string[]');
    expect(catalogWorkflowSource).toContain('export class PluginCatalogDiscoveryWorkflow');
    expect(catalogWorkflowSource).toContain('createPluginDiscovery');
    expect(catalogWorkflowSource).toContain('createPluginManifestLoader');
    expect(catalogWorkflowSource).toContain('readJsonRecord');
    expect(catalogWorkflowSource).toContain('getSlugsForPlugin');
    expect(serviceSource).toContain('operationsWorkflow');
    expect(serviceSource).not.toContain('enqueueRefresh');
    expect(serviceSource).not.toContain('getEnabledPluginIds');
    expect(serviceSource).not.toContain('decoratePluginCatalogEntry');
    expect(serviceSource).not.toContain('submitSetEnabledPlugins');
    expect(serviceSource).not.toContain('pluginIds 必须是 string[]');
    expect(serviceSource).not.toContain('new PluginRuntimeOperationsWorkflow');
    expect(catalogRepositorySource).toContain('discoveryWorkflow');
    expect(catalogRepositorySource).not.toContain('createPluginDiscovery');
    expect(catalogRepositorySource).not.toContain('createPluginManifestLoader');
    expect(catalogRepositorySource).not.toContain('readJsonRecord');
    expect(catalogRepositorySource).not.toContain('getSlugsForPlugin');
    expect(catalogRepositorySource).not.toContain('pickCatalogGroup');
    expect(runtimeModuleSource).toContain("container.register('plugins.runtimeOperationsWorkflow'");
    expect(runtimeModuleSource).toContain("operationsWorkflow: scope.resolve<PluginRuntimeOperationsWorkflow>('plugins.runtimeOperationsWorkflow')");
  });

  it('cron usage、刷新提交与 job 请求校验留在 workflow 层，不回流到 cron service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/cron/service.ts'), 'utf8');
    const usageRepositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/usage/token-usage-history.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/cron/cron-operations-workflow.ts'), 'utf8');
    const usageWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/usage/token-usage-history-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class CronOperationsWorkflow');
    expect(workflowSource).toContain('isGatewayReadyForSnapshot');
    expect(workflowSource).toContain('submitRefreshJobs');
    expect(workflowSource).toContain('asCronCreateInput');
    expect(workflowSource).toContain('getCronDeliveryValidationError');
    expect(workflowSource).toContain('buildUpdatePatch');
    expect(workflowSource).toContain('requestUsageHistoryRefresh?.()');
    expect(usageWorkflowSource).toContain('export class TokenUsageHistoryWorkflow');
    expect(usageWorkflowSource).toContain('fileCache');
    expect(usageWorkflowSource).toContain('listSessionTranscriptFiles');
    expect(usageWorkflowSource).toContain('parseUsageEntriesFromJsonl');
    expect(usageWorkflowSource).toContain('readTextFile(file.filePath)');
    expect(serviceSource).toContain('operationsWorkflow');
    expect(serviceSource).not.toContain('isGatewayReadyForSnapshot');
    expect(serviceSource).not.toContain('submitRefreshJobs');
    expect(serviceSource).not.toContain('asCronCreateInput');
    expect(serviceSource).not.toContain('getCronDeliveryValidationError');
    expect(serviceSource).not.toContain('buildUpdatePatch');
    expect(serviceSource).not.toContain('requestUsageHistoryRefresh?.()');
    expect(serviceSource).not.toContain('new CronOperationsWorkflow');
    expect(usageRepositorySource).toContain('historyWorkflow');
    expect(usageRepositorySource).not.toContain('fileCache');
    expect(usageRepositorySource).not.toContain('transcriptLayout.listSessionTranscriptFiles');
    expect(usageRepositorySource).not.toContain('parseUsageEntriesFromJsonl');
    expect(usageRepositorySource).not.toContain('readTextFile(file.filePath)');
    expect(operationsModuleSource).toContain("container.register('cron.operationsWorkflow'");
    expect(operationsModuleSource).toContain("operationsWorkflow: scope.resolve<CronOperationsWorkflow>('cron.operationsWorkflow')");
    expect(operationsModuleSource).toContain("container.register('usage.tokenHistoryWorkflow'");
    expect(operationsModuleSource).toContain("scope.resolve<TokenUsageHistoryWorkflow>('usage.tokenHistoryWorkflow')");
  });

  it('gateway readiness 解析与响应投影留在 workflow 层，不回流到 gateway service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/gateway/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/gateway-readiness/gateway-readiness-workflow.ts'), 'utf8');
    const runtimeModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/runtime-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class GatewayReadinessWorkflow');
    expect(workflowSource).toContain('normalizeGatewayMethods');
    expect(workflowSource).toContain('DEFAULT_GATEWAY_BASE_METHODS');
    expect(workflowSource).toContain('inspectGatewayControlReadiness');
    expect(workflowSource).toContain('readGatewayConnectionState');
    expect(serviceSource).toContain('readinessWorkflow');
    expect(serviceSource).not.toContain('normalizeGatewayMethods');
    expect(serviceSource).not.toContain('DEFAULT_GATEWAY_BASE_METHODS');
    expect(serviceSource).not.toContain('inspectGatewayControlReadiness');
    expect(serviceSource).not.toContain('readGatewayConnectionState');
    expect(serviceSource).not.toContain('new GatewayReadinessWorkflow');
    expect(runtimeModuleSource).toContain("container.register('gateway.readinessWorkflow'");
    expect(runtimeModuleSource).toContain("readinessWorkflow: scope.resolve<GatewayReadinessWorkflow>('gateway.readinessWorkflow')");
  });

  it('team runtime 主路径由 host service 承载，不保留旧 teamSkill gateway/service/task projection 接线', async () => {
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(operationsModuleSource).not.toContain("container.register('teamSkill.gatewayWorkflow'");
    expect(operationsModuleSource).not.toContain("container.register('teamSkill.service'");
    expect(operationsModuleSource).not.toContain("container.register('teamSkill.taskProjectionWorkflow'");
    expect(operationsModuleSource).not.toContain("scope.resolve<TeamSkillGatewayWorkflow>('teamSkill.gatewayWorkflow')");
    expect(operationsModuleSource).toContain('createTeamRuntimeCapabilityOperationRoutes');
    expect(operationsModuleSource).toContain("teamRuntimeService: scope.resolve<TeamRuntimePort>('teamRuntime.service')");
    expect(operationsModuleSource).toContain('new WorkerBackedTeamRuntimeService');
    expect(operationsModuleSource).not.toContain('startTeamRuntimeOutboxRecovery');
    expect(operationsModuleSource).not.toContain("teamRuntime.outboxStore");
  });

  it('task runtime RPC 与 snapshot 编排留在 workflow 层，不回流到 task service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/tasks/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/task-runtime/task-runtime-workflow.ts'), 'utf8');
    const operationsWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/task-runtime/task-operations-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class TaskRuntimeWorkflow');
    expect(workflowSource).toContain('requirePluginMethod');
    expect(workflowSource).toContain('gatewayRpc');
    expect(workflowSource).toContain('buildScopedParams');
    expect(workflowSource).toContain('emitAuthoritativeSnapshot');
    expect(operationsWorkflowSource).toContain('export class TaskOperationsWorkflow');
    expect(operationsWorkflowSource).toContain('TASK_TOOL_METHODS');
    expect(operationsWorkflowSource).toContain('validateTaskToolParams');
    expect(operationsWorkflowSource).toContain('backgroundTasks?.output');
    expect(operationsWorkflowSource).toContain('backgroundTasks?.stop');
    expect(serviceSource).toContain('operationsWorkflow');
    expect(serviceSource).not.toContain('runtimeWorkflow');
    expect(serviceSource).not.toContain('TASK_TOOL_METHODS');
    expect(serviceSource).not.toContain('validateTaskToolParams');
    expect(serviceSource).not.toContain('backgroundTasks');
    expect(serviceSource).not.toContain('badRequest');
    expect(serviceSource).not.toContain('readRecord');
    expect(serviceSource).not.toContain('requirePluginMethod');
    expect(serviceSource).not.toContain('gatewayRpc');
    expect(serviceSource).not.toContain('buildScopedParams');
    expect(serviceSource).not.toContain('emitAuthoritativeSnapshot');
    expect(serviceSource).not.toContain('new TaskRuntimeWorkflow');
    expect(serviceSource).not.toContain('new TaskOperationsWorkflow');
    expect(operationsModuleSource).toContain("container.register('task.runtimeWorkflow'");
    expect(operationsModuleSource).toContain("container.register('task.operationsWorkflow'");
    expect(operationsModuleSource).toContain("runtimeWorkflow: scope.resolve<TaskRuntimeWorkflow>('task.runtimeWorkflow')");
    expect(operationsModuleSource).toContain("scope.resolve<TaskOperationsWorkflow>('task.operationsWorkflow')");
  });

  it('OpenClaw service 的 CLI command 编排留在 workflow 层，不回流到 adapter service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/openclaw-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-cli-command-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawCliCommandWorkflow');
    expect(workflowSource).toContain('getOpenClawStatus');
    expect(workflowSource).toContain('openclaw.cmd');
    expect(workflowSource).toContain('OpenClaw package not found');
    expect(serviceSource).toContain('cliCommandWorkflow');
    expect(serviceSource).not.toContain('openclaw.cmd');
    expect(serviceSource).not.toContain('OpenClaw package not found');
    expect(serviceSource).not.toContain('dirname(status.dir)');
    expect(openClawModuleSource).toContain("container.register('openclaw.cliCommandWorkflow'");
    expect(openClawModuleSource).toContain("scope.resolve<OpenClawCliCommandWorkflow>('openclaw.cliCommandWorkflow')");
  });

  it('OpenClaw environment config JSON 读写留在 workflow 层，不回流到 environment repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/infrastructure/openclaw-environment-repository.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-config-file-workflow.ts'), 'utf8');
    const infrastructureModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawEnvironmentConfigFileWorkflow');
    expect(workflowSource).toContain('readOpenClawConfigJson');
    const statusWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-status-workflow.ts'), 'utf8');

    expect(workflowSource).toContain('writeOpenClawConfigJson');
    expect(workflowSource).toContain('parseRequiredJsonRecord');
    expect(workflowSource).toContain('JSON.stringify');
    expect(statusWorkflowSource).toContain('export class OpenClawEnvironmentStatusWorkflow');
    expect(statusWorkflowSource).toContain('getOpenClawStatus');
    expect(statusWorkflowSource).toContain('readPackageVersion');
    expect(statusWorkflowSource).toContain('JSON.parse');
    expect(repositorySource).toContain('configFiles');
    expect(repositorySource).not.toContain('parseRequiredJsonRecord');
    expect(repositorySource).not.toContain('JSON.stringify(config, null, 2)');
    expect(repositorySource).not.toContain('await this.fileSystem.readTextFile(path)');
    expect(repositorySource).not.toContain('parseJsonRecord');
    expect(repositorySource).not.toContain('readTextFile(packagePath)');
    expect(infrastructureModuleSource).toContain('new OpenClawEnvironmentConfigFileWorkflow');
    expect(infrastructureModuleSource).toContain('new OpenClawEnvironmentStatusWorkflow');
  });

  it('openclaw workspace identity、template migration 与 context merge 维护留在 workflow 层，不回流到 workspace service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-service.ts'), 'utf8');
    const subagentTemplateServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/infrastructure/openclaw-subagent-template-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-maintenance-workflow.ts'), 'utf8');
    const queryWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-query-workflow.ts'), 'utf8');
    const subagentTemplateWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-subagent-template-workflow.ts'), 'utf8');
    const infrastructureModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawWorkspaceMaintenanceWorkflow');
    expect(workflowSource).toContain('DEFAULT_IDENTITY_FILE_NAME');
    expect(workflowSource).toContain('LEGACY_BOOTSTRAP_FILE_NAME');
    expect(workflowSource).toContain('readDefaultIdentityContent');
    expect(workflowSource).toContain('readUpstreamIdentityTemplate');
    expect(workflowSource).toContain('migrateMainAgentTemplatesIfNeeded');
    expect(workflowSource).toContain('mergeWorkspaceContext');
    expect(workflowSource).toContain('workspaceQuery');
    expect(queryWorkflowSource).toContain('export class OpenClawWorkspaceQueryWorkflow');
    expect(queryWorkflowSource).toContain('resolveMainWorkspaceDir');
    expect(queryWorkflowSource).toContain('resolveTaskWorkspaceDirs');
    expect(queryWorkflowSource).toContain('resolveWorkspaceDirForSession');
    expect(queryWorkflowSource).toContain('getPreviewRoots');
    expect(subagentTemplateWorkflowSource).toContain('export class OpenClawSubagentTemplateWorkflow');
    expect(subagentTemplateWorkflowSource).toContain('getSubagentTemplateSourceCandidates');
    expect(subagentTemplateWorkflowSource).toContain('catalog.json');
    expect(subagentTemplateWorkflowSource).toContain('listDirectory(sourceDir)');
    expect(subagentTemplateWorkflowSource).toContain('readTemplateDetailFromSource');
    expect(serviceSource).toContain('maintenanceWorkflow');
    expect(serviceSource).toContain('queryWorkflow');
    expect(serviceSource).not.toContain('resolveMainWorkspaceDir');
    expect(serviceSource).not.toContain('resolveTaskWorkspaceDirs');
    expect(serviceSource).not.toContain('resolveWorkspaceDirForSession');
    expect(serviceSource).not.toContain('await this.config.read()');
    expect(serviceSource).not.toContain('DEFAULT_IDENTITY_FILE_NAME');
    expect(serviceSource).not.toContain('LEGACY_BOOTSTRAP_FILE_NAME');
    expect(serviceSource).not.toContain('readDefaultIdentityContent');
    expect(serviceSource).not.toContain('readUpstreamIdentityTemplate');
    expect(serviceSource).not.toContain('mergeWorkspaceContext');
    expect(serviceSource).not.toContain('normalizeTemplateText');
    expect(serviceSource).not.toContain('new OpenClawWorkspaceMaintenanceWorkflow');
    expect(subagentTemplateServiceSource).toContain('templateWorkflow');
    expect(subagentTemplateServiceSource).not.toContain('getSubagentTemplateSourceCandidates');
    expect(subagentTemplateServiceSource).not.toContain('catalog.json');
    expect(subagentTemplateServiceSource).not.toContain('listDirectory');
    expect(subagentTemplateServiceSource).not.toContain('readTextFile');
    expect(subagentTemplateServiceSource).not.toContain('JSON.parse');
    expect(infrastructureModuleSource).toContain("container.register('openclaw.workspaceQueryWorkflow'");
    expect(infrastructureModuleSource).toContain("scope.resolve<OpenClawWorkspaceQueryWorkflow>('openclaw.workspaceQueryWorkflow')");
    expect(infrastructureModuleSource).toContain("container.register('openclaw.workspaceMaintenanceWorkflow'");
    expect(infrastructureModuleSource).toContain("scope.resolve<OpenClawWorkspaceMaintenanceWorkflow>('openclaw.workspaceMaintenanceWorkflow')");
    expect(infrastructureModuleSource).toContain("container.register('openclaw.subagentTemplateWorkflow'");
    expect(infrastructureModuleSource).toContain("scope.resolve<OpenClawSubagentTemplateWorkflow>('openclaw.subagentTemplateWorkflow')");
  });

  it('subagent runtime RPC 与 snapshot 编排留在 workflow 层，不回流到 subagent service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/subagents/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/subagent-runtime/subagent-runtime-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SubagentRuntimeWorkflow');
    expect(workflowSource).toContain('requirePluginMethod');
    expect(workflowSource).toContain('gatewayRpc');
    expect(workflowSource).toContain('snapshotByMethod');
    expect(workflowSource).toContain('initializeAgentWorkspace');
    expect(serviceSource).toContain('runtimeWorkflow');
    expect(serviceSource).not.toContain('requirePluginMethod');
    expect(serviceSource).not.toContain('gatewayRpc');
    expect(serviceSource).not.toContain('snapshotByMethod');
    expect(serviceSource).not.toContain('initializeAgentWorkspace');
    expect(serviceSource).not.toContain('new SubagentRuntimeWorkflow');
    expect(openClawModuleSource).toContain("container.register('subagents.runtimeWorkflow'");
    expect(openClawModuleSource).toContain("runtimeWorkflow: scope.resolve<SubagentRuntimeWorkflow>('subagents.runtimeWorkflow')");
  });

  it('channel runtime/config 编排留在 workflow 层，不回流到 channel service', async () => {
    const channelServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/channels/service.ts'), 'utf8');
    const channelConfigRepositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/channels/channel-runtime.ts'), 'utf8');
    const activationWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/channel-runtime/channel-activation-workflow.ts'), 'utf8');
    const configWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/channel-runtime/channel-config-mutation-workflow.ts'), 'utf8');
    const channelConfigWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/channel-runtime/channel-config-workflow.ts'), 'utf8');
    const runtimeWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/channel-runtime/channel-runtime-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');
    const openClawInfrastructureModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(activationWorkflowSource).toContain('export class ChannelActivationWorkflow');
    expect(activationWorkflowSource).toContain('channelUsesLoginSession');
    expect(activationWorkflowSource).toContain('submitActivateDirectChannel');
    expect(activationWorkflowSource).toContain('prepareChannelPlugin');
    expect(activationWorkflowSource).toContain('loginSessions.start');
    expect(activationWorkflowSource).toContain('loginSessions.cancel');
    expect(configWorkflowSource).toContain('export class ChannelConfigMutationWorkflow');
    expect(configWorkflowSource).toContain('gateway_restart');
    expect(configWorkflowSource).toContain('saveChannelConfig');
    expect(configWorkflowSource).toContain('deleteChannelConfig');
    expect(channelConfigWorkflowSource).toContain('export class ChannelConfigWorkflow');
    expect(channelConfigWorkflowSource).toContain('ensureChannelPluginInstalled');
    expect(channelConfigWorkflowSource).toContain('reconcileChannelDerivedPluginState');
    expect(channelConfigWorkflowSource).toContain('updateDirty');
    expect(channelConfigWorkflowSource).toContain('replaceConfigContents');
    expect(runtimeWorkflowSource).toContain('export class ChannelRuntimeWorkflow');
    expect(runtimeWorkflowSource).toContain('isGatewayReadyForSnapshot');
    expect(runtimeWorkflowSource).toContain('projectChannelsSnapshot');
    expect(runtimeWorkflowSource).toContain('channelsStatus');
    expect(channelServiceSource).toContain('activationWorkflow');
    expect(channelServiceSource).toContain('configMutationWorkflow');
    expect(channelServiceSource).toContain('runtimeWorkflow');
    expect(channelServiceSource).not.toContain('channelUsesLoginSession');
    expect(channelServiceSource).not.toContain('submitActivateDirectChannel(payload)');
    expect(channelServiceSource).not.toContain('prepareChannelPlugin');
    expect(channelServiceSource).not.toContain('loginSessions.start');
    expect(channelServiceSource).not.toContain('loginSessions.cancel');
    expect(channelServiceSource).not.toContain('gateway_restart');
    expect(channelServiceSource).not.toContain('await this.deps.channelConfig.saveChannelConfig');
    expect(channelServiceSource).not.toContain('await this.deps.channelConfig.deleteChannelConfig');
    expect(channelServiceSource).not.toContain('channelsStatus');
    expect(channelServiceSource).not.toContain('isGatewayReadyForSnapshot');
    expect(channelServiceSource).not.toContain('projectChannelsSnapshot');
    expect(channelServiceSource).not.toContain('new ChannelActivationWorkflow');
    expect(channelServiceSource).not.toContain('new ChannelConfigMutationWorkflow');
    expect(channelServiceSource).not.toContain('new ChannelRuntimeWorkflow');
    expect(channelConfigRepositorySource).toContain('configWorkflow');
    expect(channelConfigRepositorySource).not.toContain('ensureChannelPluginInstalled');
    expect(channelConfigRepositorySource).not.toContain('reconcileChannelDerivedPluginState');
    expect(channelConfigRepositorySource).not.toContain('updateDirty');
    expect(channelConfigRepositorySource).not.toContain('replaceConfigContents');
    expect(openClawModuleSource).toContain("container.register('channels.activationWorkflow'");
    expect(openClawModuleSource).toContain("container.register('channels.configMutationWorkflow'");
    expect(openClawModuleSource).toContain("container.register('channels.runtimeWorkflow'");
    expect(openClawModuleSource).toContain("activationWorkflow: scope.resolve<ChannelActivationWorkflow>('channels.activationWorkflow')");
    expect(openClawModuleSource).toContain("configMutationWorkflow: scope.resolve<ChannelConfigMutationWorkflow>('channels.configMutationWorkflow')");
    expect(openClawModuleSource).toContain("runtimeWorkflow: scope.resolve<ChannelRuntimeWorkflow>('channels.runtimeWorkflow')");
    expect(openClawInfrastructureModuleSource).toContain("container.register('channels.configWorkflow'");
    expect(openClawInfrastructureModuleSource).toContain("scope.resolve<ChannelConfigWorkflow>('channels.configWorkflow')");
  });

  it('provider account mutation 编排留在 workflow 层，不回流到 accounts service', async () => {
    const accountsServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/providers/accounts.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-account/provider-account-mutation-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class ProviderAccountMutationWorkflow');
    expect(workflowSource).toContain('normalizeProviderAccountLocal');
    expect(workflowSource).toContain('syncStoreToProjection');
    expect(workflowSource).toContain('removeCredentialRoutes');
    expect(accountsServiceSource).toContain('mutations');
    expect(accountsServiceSource).not.toContain('normalizeProviderAccountLocal');
    expect(accountsServiceSource).not.toContain('syncStoreToProjection');
    expect(accountsServiceSource).not.toContain('removeCredentialRoutes');
    expect(accountsServiceSource).not.toContain('new ProviderAccountMutationWorkflow');
    expect(openClawModuleSource).toContain("container.register('providers.accountMutationWorkflow'");
    expect(openClawModuleSource).toContain("mutations: scope.resolve<ProviderAccountMutationWorkflow>('providers.accountMutationWorkflow')");
  });

  it('provider OAuth completion 私密 token 投影与 runtime sync 留在 workflow 层，不回流到 oauth service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/providers/oauth-runtime.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-oauth/provider-oauth-completion-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class ProviderOAuthCompletionWorkflow');
    expect(workflowSource).toContain('saveOAuthToken');
    expect(workflowSource).toContain('syncStoreToProjection');
    expect(workflowSource).toContain('normalizeOAuthBaseUrl');
    expect(workflowSource).toContain('storeModified');
    expect(workflowSource).toContain('asProviderCredential');
    expect(serviceSource).toContain('completionWorkflow');
    expect(serviceSource).not.toContain('saveOAuthToken');
    expect(serviceSource).not.toContain('syncStoreToProjection');
    expect(serviceSource).not.toContain('normalizeOAuthBaseUrl');
    expect(serviceSource).not.toContain('storeModified');
    expect(serviceSource).not.toContain('asProviderCredential');
    expect(serviceSource).not.toContain('new ProviderOAuthCompletionWorkflow');
    expect(openClawModuleSource).toContain("container.register('providers.oauthCompletionWorkflow'");
    expect(openClawModuleSource).toContain("scope.resolve<ProviderOAuthCompletionWorkflow>('providers.oauthCompletionWorkflow')");
  });

  it('provider capability routing 裁剪、payload 解码与 runtime projection 留在 workflow 层，不回流到 routing service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/providers/capability-routing-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-capability-routing/provider-capability-routing-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class ProviderCapabilityRoutingWorkflow');
    expect(workflowSource).toContain('decodeRouting');
    expect(workflowSource).toContain('pruneRoutesUnavailableInCatalog');
    expect(workflowSource).toContain('syncRuntimeRoutingProjection');
    expect(workflowSource).toContain('toRuntimeRoutingProjection');
    expect(workflowSource).toContain('fromRuntimeRoutingProjection');
    expect(workflowSource).toContain('normalizeProviderStoreForProjection');
    expect(serviceSource).toContain('routingWorkflow');
    expect(serviceSource).not.toContain('decodeRouting');
    expect(serviceSource).not.toContain('pruneRoutesUnavailableInCatalog');
    expect(serviceSource).not.toContain('syncRuntimeRoutingProjection');
    expect(serviceSource).not.toContain('toRuntimeRoutingProjection');
    expect(serviceSource).not.toContain('fromRuntimeRoutingProjection');
    expect(serviceSource).not.toContain('normalizeProviderStoreForProjection');
    expect(serviceSource).not.toContain('new ProviderCapabilityRoutingWorkflow');
    expect(openClawModuleSource).toContain("container.register('providers.capabilityRoutingWorkflow'");
    expect(openClawModuleSource).toContain("routingWorkflow: scope.resolve<ProviderCapabilityRoutingWorkflow>('providers.capabilityRoutingWorkflow')");
  });

  it('OpenClaw plugin config service 的启用态同步编排留在 workflow 层，不回流到 adapter service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-plugin/openclaw-plugin-config-workflow.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawPluginConfigWorkflow');
    expect(workflowSource).toContain('readEnabledPluginIds');
    expect(workflowSource).toContain('syncEnabledPluginIds');
    expect(workflowSource).toContain('applyManuallyManagedPluginIdsToOpenClawConfig');
    expect(workflowSource).toContain('cleanupUnconfiguredExternalChannelPluginDirs');
    expect(workflowSource).toContain('replaceConfigContents');
    expect(serviceSource).toContain('configWorkflow');
    expect(serviceSource).not.toContain('cleanupUnconfiguredExternalChannelPluginDirs');
    expect(serviceSource).not.toContain('replaceConfigContents');
    expect(serviceSource).not.toContain('normalizedManualPluginIds');
    expect(serviceSource).not.toContain('finalConfig');
    expect(serviceSource).not.toContain('new OpenClawPluginConfigWorkflow');
  });

  it('OpenClaw security plugin config 投影写盘留在 workflow 层，不回流到 adapter service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/projections/openclaw-security-plugin-config-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-security-plugin-config-workflow.ts'), 'utf8');
    const openClawInfrastructureSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawSecurityPluginConfigWorkflow');
    expect(workflowSource).toContain('updateDirty');
    expect(workflowSource).toContain('replaceConfigContents');
    expect(workflowSource).toContain('applySecurityPolicyToOpenClawPluginConfig');
    expect(serviceSource).toContain('configWorkflow');
    expect(serviceSource).not.toContain('updateDirty');
    expect(serviceSource).not.toContain('replaceConfigContents');
    expect(serviceSource).not.toContain('constructor(private readonly configRepository');
    expect(openClawInfrastructureSource).toContain("container.register('security.openclawPluginConfigWorkflow'");
    expect(openClawInfrastructureSource).toContain("scope.resolve<OpenClawSecurityPluginConfigWorkflow>('security.openclawPluginConfigWorkflow')");
  });

  it('OpenClaw channel login 微信账号文件投影留在 workflow 层，不回流到 adapter service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/projections/openclaw-channel-login-session-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-channel/openclaw-weixin-account-store-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawWeixinAccountStoreWorkflow');
    expect(workflowSource).toContain('saveAccount');
    expect(workflowSource).toContain('readJsonStringArray');
    expect(workflowSource).toContain('removeAccountFiles');
    expect(workflowSource).toContain('writeTextFile');
    expect(workflowSource).toContain('removeFile');
    expect(serviceSource).toContain('weixinAccounts');
    expect(serviceSource).toContain('this.deps.weixinAccounts.saveAccount');
    expect(serviceSource).not.toContain('readJsonStringArray');
    expect(serviceSource).not.toContain('readWeixinAccountUserId');
    expect(serviceSource).not.toContain('removeWeixinAccountFiles');
    expect(serviceSource).not.toContain('writeTextFile(join(accountsDir');
    expect(openClawModuleSource).toContain("container.register('channels.openclawWeixinAccountStoreWorkflow'");
    expect(openClawModuleSource).toContain("scope.resolve<OpenClawWeixinAccountStoreWorkflow>('channels.openclawWeixinAccountStoreWorkflow')");
  });

  it('OpenClaw custom media plugin config 投影留在 workflow 层，不回流到 adapter service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/projections/openclaw-custom-media-plugin-config-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-custom-media-plugin-config-workflow.ts'), 'utf8');
    const openClawInfrastructureSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawCustomMediaPluginConfigWorkflow');
    expect(workflowSource).toContain('ensurePluginEnabled');
    expect(workflowSource).toContain('removeModelProviderNode');
    expect(workflowSource).toContain('rewriteLegacyMediaRoutes');
    expect(workflowSource).toContain('normalizeModels');
    expect(serviceSource).toContain('configWorkflow');
    expect(serviceSource).not.toContain('ensurePluginEnabled');
    expect(serviceSource).not.toContain('removeModelProviderNode');
    expect(serviceSource).not.toContain('rewriteLegacyMediaRoutes');
    expect(serviceSource).not.toContain('normalizeModels');
    expect(serviceSource).not.toContain('new OpenClawCustomMediaPluginConfigWorkflow');
    expect(openClawInfrastructureSource).toContain("container.register('openclaw.customMediaPluginConfigWorkflow'");
    expect(openClawInfrastructureSource).toContain("scope.resolve<OpenClawCustomMediaPluginConfigWorkflow>('openclaw.customMediaPluginConfigWorkflow')");
  });

  it('OpenClaw capability routing config 投影留在 workflow 层，不回流到 adapter service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/projections/openclaw-capability-routing-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-capability-routing-projection-workflow.ts'), 'utf8');
    const openClawInfrastructureSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawCapabilityRoutingProjectionWorkflow');
    expect(workflowSource).toContain('configRepository.read');
    expect(workflowSource).toContain('updateDirty');
    expect(workflowSource).toContain('ensureAgentsDefaults');
    expect(workflowSource).toContain('applyRouteToAgentsDefaults');
    expect(serviceSource).toContain('projectionWorkflow');
    expect(serviceSource).not.toContain('configRepository.read');
    expect(serviceSource).not.toContain('updateDirty');
    expect(serviceSource).not.toContain('ensureAgentsDefaults');
    expect(openClawInfrastructureSource).toContain("container.register('openclaw.capabilityRoutingProjectionWorkflow'");
    expect(openClawInfrastructureSource).toContain("scope.resolve<OpenClawCapabilityRoutingProjectionWorkflow>('openclaw.capabilityRoutingProjectionWorkflow')");
  });

  it('OpenClaw provider models config 投影留在 workflow 层，不回流到 adapter service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/projections/openclaw-provider-models-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-models-projection-workflow.ts'), 'utf8');
    const openClawInfrastructureSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawProviderModelsProjectionWorkflow');
    expect(workflowSource).toContain('decodeModelEntry');
    expect(workflowSource).toContain('applyModelsToProviderNode');
    expect(workflowSource).toContain('pruneUnknownModelRefsInAgentsConfig');
    expect(workflowSource).toContain('zeroCost');
    expect(serviceSource).toContain('projectionWorkflow');
    expect(serviceSource).not.toContain('decodeModelEntry');
    expect(serviceSource).not.toContain('applyModelsToProviderNode');
    expect(serviceSource).not.toContain('pruneUnknownModelRefsInAgentsConfig');
    expect(serviceSource).not.toContain('zeroCost');
    expect(serviceSource).not.toContain('new OpenClawProviderModelsProjectionWorkflow');
    expect(openClawInfrastructureSource).toContain("container.register('openclaw.providerModelsProjectionWorkflow'");
    expect(openClawInfrastructureSource).toContain("scope.resolve<OpenClawProviderModelsProjectionWorkflow>('openclaw.providerModelsProjectionWorkflow')");
  });

  it('provider models runtime projection 与 application 编排留在 workflow 层，不回流到 models service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/providers/provider-models-service.ts'), 'utf8');
    const operationsWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-model/provider-models-operations-workflow.ts'), 'utf8');
    const projectionWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/provider-model/provider-models-projection-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(projectionWorkflowSource).toContain('export class ProviderModelsProjectionWorkflow');
    expect(projectionWorkflowSource).toContain('syncRuntimeModelProjection');
    expect(projectionWorkflowSource).toContain('importRuntimeProjectionModels');
    expect(projectionWorkflowSource).toContain('replaceAll(providerMap, validModelRefs)');
    expect(projectionWorkflowSource).toContain('replaceAll(customMediaProviderMap)');
    expect(projectionWorkflowSource).toContain('upsertProviderInAgentModels');
    expect(projectionWorkflowSource).toContain('pruneUnavailableModelRoutes');
    expect(operationsWorkflowSource).toContain('export class ProviderModelsOperationsWorkflow');
    expect(operationsWorkflowSource).toContain('decodeModelList');
    expect(operationsWorkflowSource).toContain('readNormalizedAccounts');
    expect(operationsWorkflowSource).toContain('normalizeProviderStoreForProjection');
    expect(operationsWorkflowSource).toContain('toMatchaClawMediaModelRef');
    expect(operationsWorkflowSource).toContain('replaceCredentialModels');
    expect(serviceSource).toContain('operationsWorkflow');
    expect(serviceSource).not.toContain('decodeModelList');
    expect(serviceSource).not.toContain('normalizeProviderStoreForProjection');
    expect(serviceSource).not.toContain('toMatchaClawMediaModelRef');
    expect(serviceSource).not.toContain('readHydratedStore()');
    expect(serviceSource).not.toContain('replaceCredentialModels');
    expect(serviceSource).not.toContain('private async syncRuntimeModelProjection');
    expect(serviceSource).not.toContain('private async importRuntimeProjectionModels');
    expect(serviceSource).not.toContain('private validateModelsForCredential');
    expect(serviceSource).not.toContain('await this.agentModels.upsertProviderInAgentModels');
    expect(serviceSource).not.toContain('await this.capabilityRouting.pruneUnavailableModelRoutes');
    expect(serviceSource).not.toContain('replaceAll(providerMap, validModelRefs)');
    expect(openClawModuleSource).toContain("container.register('providers.modelsProjectionWorkflow'");
    expect(openClawModuleSource).toContain("container.register('providers.modelsOperationsWorkflow'");
    expect(openClawModuleSource).toContain("projectionWorkflow: scope.resolve<ProviderModelsProjectionWorkflow>('providers.modelsProjectionWorkflow')");
    expect(openClawModuleSource).toContain("operationsWorkflow: scope.resolve<ProviderModelsOperationsWorkflow>('providers.modelsOperationsWorkflow')");
  });

  it('platform runtime route payload、job submit 与 response 编排留在 operations workflow 层，不回流到 service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/platform-runtime/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/platform-runtime/platform-runtime-operations-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class PlatformRuntimeOperationsWorkflow');
    expect(workflowSource).toContain('readQueryPayload');
    expect(workflowSource).toContain('submitInstallNativeTool');
    expect(workflowSource).toContain('submitReconcileTools');
    expect(workflowSource).toContain('executeStartRun');
    expect(workflowSource).toContain('listEffectiveTools');
    expect(workflowSource).toContain('toolId is required');
    expect(serviceSource).toContain('operationsWorkflow');
    expect(serviceSource).not.toContain('readQueryPayload');
    expect(serviceSource).not.toContain('submitInstallNativeTool');
    expect(serviceSource).not.toContain('submitReconcileTools');
    expect(serviceSource).not.toContain('executeStartRun');
    expect(serviceSource).not.toContain('listEffectiveTools');
    expect(serviceSource).not.toContain('toolId is required');
    expect(operationsModuleSource).toContain("container.register('platform.operationsWorkflow'");
    expect(operationsModuleSource).toContain("operationsWorkflow: scope.resolve<PlatformRuntimeOperationsWorkflow>('platform.operationsWorkflow')");
  });

  it('platform runtime tool ledger 与 native enable 编排留在 workflow 层，不回流到 facade', async () => {
    const platformModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/platform-runtime-module.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/platform-runtime/platform-tool-state-workflow.ts'), 'utf8');

    expect(workflowSource).toContain('export class PlatformToolStateWorkflow');
    expect(workflowSource).toContain('refreshGatewayLedgerFromRuntime');
    expect(workflowSource).toContain('enableTool(toolId)');
    expect(workflowSource).toContain('disableTool(toolId)');
    expect(workflowSource).toContain('gatewayLedger.setAll(upstream)');
    expect(workflowSource).toContain('toolRegistry.upsertNative(upstream)');
    expect(workflowSource).toContain("type: 'runtime.set_tool_enabled'");
    expect(platformModuleSource).toContain("container.register('platform.toolStateWorkflow'");
    expect(platformModuleSource).toContain('toolStateWorkflow: scope.resolve');
    expect(platformModuleSource).toContain('deps.toolStateWorkflow.installNativeTool(source)');
    expect(platformModuleSource).toContain('deps.toolStateWorkflow.reconcileNativeTools()');
    expect(platformModuleSource).toContain('deps.toolStateWorkflow.upsertPlatformTools(tools)');
    expect(platformModuleSource).toContain('deps.toolStateWorkflow.setToolEnabled(toolId, enabled)');
    expect(platformModuleSource).not.toContain('const installed = await deps.runtimeDriver.listInstalledTools()');
    expect(platformModuleSource).not.toContain('deps.gatewayLedger.setAll(installed)');
    expect(platformModuleSource).not.toContain('deps.gatewayLedger.setAll(await deps.runtimeDriver.listInstalledTools())');
    expect(platformModuleSource).not.toContain('deps.localLedger.setAll(deps.toolRegistry.snapshotPlatform())');
    expect(platformModuleSource).not.toContain('deps.runtimeDriver.enableTool(toolId)');
    expect(platformModuleSource).not.toContain('deps.runtimeDriver.disableTool(toolId)');
    expect(platformModuleSource).not.toContain("type: 'runtime.set_tool_enabled'");
  });

  it('platform native tool 安装、同步与审计编排留在 workflow 层，不回流到 runtime manager service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/platform-runtime/runtime-manager-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/platform-runtime/platform-native-tool-workflow.ts'), 'utf8');
    const toolStateWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/platform-runtime/platform-tool-state-workflow.ts'), 'utf8');
    const platformModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/platform-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class PlatformNativeToolWorkflow');
    expect(workflowSource).toContain('runtimeDriver.installTool(source)');
    expect(workflowSource).toContain('runtimeDriver.listInstalledTools()');
    expect(workflowSource).toContain('toolRegistry.upsertNative(installed)');
    expect(workflowSource).toContain("type: 'runtime.install_native_tool'");
    expect(workflowSource).toContain('reconciler.reconcileTools()');
    expect(workflowSource).toContain("type: 'runtime.reconcile_native_tools'");
    expect(serviceSource).toContain('nativeToolWorkflow');
    expect(serviceSource).not.toContain('runtimeDriver.installTool(source)');
    expect(serviceSource).not.toContain('toolRegistry.upsertNative');
    expect(serviceSource).not.toContain('auditSink.append');
    expect(serviceSource).not.toContain('reconciler.reconcileTools()');
    expect(toolStateWorkflowSource).toContain('nativeToolWorkflow');
    expect(toolStateWorkflowSource).not.toContain('runtimeManager');
    expect(platformModuleSource).toContain("container.register('platform.nativeToolWorkflow'");
    expect(platformModuleSource).toContain("nativeToolWorkflow: scope.resolve<PlatformNativeToolWorkflow>('platform.nativeToolWorkflow')");
    expect(platformModuleSource).toContain("scope.resolve<PlatformNativeToolWorkflow>('platform.nativeToolWorkflow')");
  });

  it('workspace file 读写、staging 与 thumbnail 编排留在 workflow 层，不回流到 file service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/files/file-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/workspace-file/workspace-file-runtime-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class WorkspaceFileRuntimeWorkflow');
    expect(workflowSource).toContain('FILE_PREVIEW_MAX_TEXT_BYTES');
    expect(workflowSource).toContain('looksLikeBinary');
    expect(workflowSource).toContain('getOutboundDir');
    expect(workflowSource).toContain('generateImagePreview');
    expect(workflowSource).toContain('resolveOutgoingMediaUrl');
    expect(workflowSource).toContain('writeTextFile(targetPath, content)');
    expect(workflowSource).toContain('writeBinaryFile(stagedPath, buffer)');
    expect(workflowSource).toContain('copyFile(filePath, stagedPath)');
    expect(serviceSource).toContain('runtimeWorkflow');
    expect(serviceSource).not.toContain('FILE_PREVIEW_MAX_TEXT_BYTES');
    expect(serviceSource).not.toContain('looksLikeBinary');
    expect(serviceSource).not.toContain('getOutboundDir');
    expect(serviceSource).not.toContain('generateImagePreview');
    expect(serviceSource).not.toContain('resolveOutgoingMediaUrl');
    expect(serviceSource).not.toContain('writeTextFile(targetPath, content)');
    expect(serviceSource).not.toContain('writeBinaryFile(stagedPath, buffer)');
    expect(serviceSource).not.toContain('copyFile(filePath, stagedPath)');
    expect(serviceSource).not.toContain('new WorkspaceFileRuntimeWorkflow');
    expect(operationsModuleSource).toContain("container.register('file.runtimeWorkflow'");
    expect(operationsModuleSource).toContain("runtimeWorkflow: scope.resolve<WorkspaceFileRuntimeWorkflow>('file.runtimeWorkflow')");
  });

  it('toolchain uv 安装命令编排留在 workflow 层，不回流到 uv service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/toolchain/uv-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/toolchain-install/uv-python-install-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class UvPythonInstallWorkflow');
    expect(workflowSource).toContain('resolveUvExecutableForInstall');
    expect(workflowSource).toContain('findUvInPath');
    expect(workflowSource).toContain("['python', 'install', '3.12']");
    expect(serviceSource).toContain('installWorkflow');
    expect(serviceSource).not.toContain('execFile');
    expect(serviceSource).not.toContain("['python', 'install', '3.12']");
    expect(serviceSource).not.toContain('new UvPythonInstallWorkflow');
    expect(operationsModuleSource).toContain("container.register('toolchainUv.installWorkflow'");
    expect(operationsModuleSource).toContain("scope.resolve<UvPythonInstallWorkflow>('toolchainUv.installWorkflow')");
  });

  it('platform run 与 tool install/reconcile 编排留在 workflow 层，不回流到 platform service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/platform-runtime/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/platform-runtime/platform-tool-runtime-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class PlatformToolRuntimeWorkflow');
    expect(workflowSource).toContain('startRun');
    expect(workflowSource).toContain('abortRun');
    expect(workflowSource).toContain('installNativeTool');
    expect(workflowSource).toContain('reconcileNativeTools');
    expect(serviceSource).toContain('operationsWorkflow');
    expect(serviceSource).not.toContain('toolRuntimeWorkflow');
    expect(serviceSource).not.toContain('await this.deps.platformRuntime.startRun');
    expect(serviceSource).not.toContain('await this.deps.platformRuntime.abortRun');
    expect(serviceSource).not.toContain('await this.deps.platformRuntime.installNativeTool');
    expect(serviceSource).not.toContain('await this.deps.platformRuntime.reconcileNativeTools');
    expect(serviceSource).not.toContain('new PlatformToolRuntimeWorkflow');
    expect(operationsModuleSource).toContain("container.register('platform.toolRuntimeWorkflow'");
    expect(operationsModuleSource).toContain("toolRuntimeWorkflow: scope.resolve<PlatformToolRuntimeWorkflow>('platform.toolRuntimeWorkflow')");
  });

  it('plugin lifecycle 配置变更与 side effect 编排留在 workflow 层，不回流到 plugin repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/plugins/runtime-plugin-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/plugin-lifecycle/runtime-plugin-lifecycle-workflow.ts'), 'utf8');
    const pluginModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/plugin-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class RuntimePluginLifecycleWorkflow');
    expect(workflowSource).toContain('normalizeManualPluginIds');
    expect(workflowSource).toContain('computeTransitionLifecycleState');
    expect(workflowSource).toContain('applyManuallyManagedPluginIds');
    expect(workflowSource).toContain('applyTransitionConfig');
    expect(workflowSource).toContain('runTransitionSideEffects');
    expect(workflowSource).toContain('applyStartupConfig');
    expect(workflowSource).toContain('runStartupSideEffects');
    expect(workflowSource).toContain('discoverRegistryPlugin');
    expect(workflowSource).toContain('getSourceSignatures');
    expect(workflowSource).toContain('listConfiguredManagedPluginIdsFromConfig');
    expect(repositorySource).toContain('lifecycleWorkflow');
    expect(repositorySource).not.toContain('discoverRegistryPlugin');
    expect(repositorySource).not.toContain('getSourceSignatures');
    expect(repositorySource).not.toContain('listConfiguredManagedPluginIdsFromConfig');
    expect(repositorySource).not.toContain('normalizeManualPluginIds');
    expect(repositorySource).not.toContain('computeTransitionLifecycleState');
    expect(repositorySource).not.toContain('applyTransitionConfig');
    expect(repositorySource).not.toContain('runTransitionSideEffects');
    expect(repositorySource).not.toContain('applyStartupConfig');
    expect(repositorySource).not.toContain('runStartupSideEffects');
    expect(repositorySource).not.toContain('new RuntimePluginLifecycleWorkflow');
    expect(pluginModuleSource).toContain("container.register('plugins.lifecycleWorkflow'");
    expect(pluginModuleSource).toContain("scope.resolve<RuntimePluginLifecycleWorkflow>('plugins.lifecycleWorkflow')");
  });

  it('plugin companion skill 目录探测、复制安装与配置状态编排留在 workflow 层，不回流到 companion service', async () => {
    const serviceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/plugins/plugin-companion-skill-service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/plugin-lifecycle/plugin-companion-skill-workflow.ts'), 'utf8');
    const pluginModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/plugin-runtime-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class PluginCompanionSkillWorkflow');
    expect(workflowSource).toContain('getCompanionSkillRootCandidates');
    expect(workflowSource).toContain('getSkillsRootDir');
    expect(workflowSource).toContain('ensureDirectory(skillsRoot)');
    expect(workflowSource).toContain('copyDirectory(sourceDir, targetDir)');
    expect(workflowSource).toContain('reconcileConfigStates');
    expect(serviceSource).toContain('companionSkillWorkflow');
    expect(serviceSource).not.toContain('getCompanionSkillRootCandidates');
    expect(serviceSource).not.toContain('getSkillsRootDir');
    expect(serviceSource).not.toContain('ensureDirectory');
    expect(serviceSource).not.toContain('copyDirectory');
    expect(serviceSource).not.toContain('resolveSourceDir');
    expect(serviceSource).not.toContain('ManagedPluginCatalogPort');
    expect(serviceSource).not.toContain('new PluginCompanionSkillWorkflow');
    expect(pluginModuleSource).toContain("container.register('plugins.companionSkillWorkflow'");
    expect(pluginModuleSource).toContain("scope.resolve<PluginCompanionSkillWorkflow>('plugins.companionSkillWorkflow')");
  });

  it('settings runtime config 同步编排留在 workflow 层，不回流到 settings service', async () => {
    const settingsServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/settings/service.ts'), 'utf8');
    const settingsRepositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/settings/store.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/settings-runtime-config/settings-runtime-config-sync-workflow.ts'), 'utf8');
    const storeWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/settings-store/settings-store-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');
    const openClawInfrastructureModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SettingsRuntimeConfigSyncWorkflow');
    expect(workflowSource).toContain('normalizeBrowserMode');
    expect(workflowSource).toContain('ensureManagedPluginInstalled');
    expect(workflowSource).toContain('restartGateway');
    expect(workflowSource).toContain('hasExplicitProxyPatch');
    expect(workflowSource).toContain('submitRuntimeConfigSync');
    expect(storeWorkflowSource).toContain('export class SettingsStoreWorkflow');
    expect(storeWorkflowSource).toContain('normalizeSettingsValueForKey');
    expect(storeWorkflowSource).toContain('getRuntimeHostSettingsFilePath');
    expect(storeWorkflowSource).toContain('writeTextFile');
    expect(storeWorkflowSource).toContain('resolveSupportedLanguage');
    expect(settingsServiceSource).toContain('runtimeConfigSyncWorkflow');
    expect(settingsServiceSource).not.toContain('normalizeBrowserMode');
    expect(settingsServiceSource).not.toContain('browser-relay');
    expect(settingsServiceSource).not.toContain('restartGateway');
    expect(settingsServiceSource).not.toContain('hasExplicitProxyPatch');
    expect(settingsServiceSource).not.toContain('submitRuntimeConfigSync');
    expect(settingsServiceSource).not.toContain('new SettingsRuntimeConfigSyncWorkflow');
    expect(settingsRepositorySource).toContain('settingsWorkflow');
    expect(settingsRepositorySource).not.toContain('normalizeSettingsValueForKey');
    expect(settingsRepositorySource).not.toContain('getRuntimeHostSettingsFilePath');
    expect(settingsRepositorySource).not.toContain('writeTextFile');
    expect(settingsRepositorySource).not.toContain('resolveSupportedLanguage');
    expect(openClawModuleSource).toContain("container.register('settings.runtimeConfigSyncWorkflow'");
    expect(openClawModuleSource).toContain("runtimeConfigSyncWorkflow: scope.resolve<SettingsRuntimeConfigSyncWorkflow>('settings.runtimeConfigSyncWorkflow')");
    expect(openClawInfrastructureModuleSource).toContain("container.register('settings.storeWorkflow'");
    expect(openClawInfrastructureModuleSource).toContain("scope.resolve<SettingsStoreWorkflow>('settings.storeWorkflow')");
  });

  it('security gateway、policy、job submit 与 payload 编排留在 workflow 层，不回流到 security service', async () => {
    const securityServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/security/service.ts'), 'utf8');
    const emergencyWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/security-emergency/security-emergency-response-workflow.ts'), 'utf8');
    const gatewayWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/security-operations/security-gateway-operations-workflow.ts'), 'utf8');
    const operationsWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/security-operations/security-operations-workflow.ts'), 'utf8');
    const policyRepositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/security/security-policy-store.ts'), 'utf8');
    const policyStoreWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/security-policy/security-policy-store-workflow.ts'), 'utf8');
    const policySyncWorkflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/security-policy/security-policy-sync-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(emergencyWorkflowSource).toContain('export class SecurityEmergencyResponseWorkflow');
    expect(emergencyWorkflowSource).toContain('createSecurityEmergencyLockdownPayload');
    expect(emergencyWorkflowSource).toContain('securityPolicySync');
    expect(emergencyWorkflowSource).toContain('securityEmergencyRun');
    expect(gatewayWorkflowSource).toContain('export class SecurityGatewayOperationsWorkflow');
    expect(gatewayWorkflowSource).toContain('securityQuickAuditRun');
    expect(gatewayWorkflowSource).toContain('securityIntegrityCheck');
    expect(gatewayWorkflowSource).toContain('securityRemediationApply');
    expect(operationsWorkflowSource).toContain('export class SecurityOperationsWorkflow');
    expect(operationsWorkflowSource).toContain('policyRepository.write(payload)');
    expect(operationsWorkflowSource).toContain('jobs.submitPolicySync()');
    expect(operationsWorkflowSource).toContain('jobs.submitSkillsScan(scanPath)');
    expect(operationsWorkflowSource).toContain('jobs.submitRemediationApply(actions)');
    expect(operationsWorkflowSource).toContain('routeUrl.searchParams.get');
    expect(policyStoreWorkflowSource).toContain('export class SecurityPolicyStoreWorkflow');
    expect(policyStoreWorkflowSource).toContain('normalizeSecurityPolicyPayload');
    expect(policyStoreWorkflowSource).toContain('writeTextFile');
    expect(policyStoreWorkflowSource).toContain('readPolicyFile');
    expect(policySyncWorkflowSource).toContain('export class SecurityPolicySyncWorkflow');
    expect(policySyncWorkflowSource).toContain('POLICY_SYNC_MAX_ATTEMPTS');
    expect(policySyncWorkflowSource).toContain('securityPolicySync');
    expect(policySyncWorkflowSource).toContain('timer.sleep');
    expect(securityServiceSource).toContain('operationsWorkflow');
    expect(securityServiceSource).not.toContain('emergencyResponseWorkflow');
    expect(securityServiceSource).not.toContain('policySyncWorkflow');
    expect(securityServiceSource).not.toContain('gatewayOperationsWorkflow');
    expect(securityServiceSource).not.toContain('policyRepository.write(payload)');
    expect(securityServiceSource).not.toContain('jobs.submitPolicySync()');
    expect(securityServiceSource).not.toContain('jobs.submitSkillsScan(scanPath)');
    expect(securityServiceSource).not.toContain('jobs.submitRemediationApply(actions)');
    expect(securityServiceSource).not.toContain('routeUrl.searchParams.get');
    expect(securityServiceSource).not.toContain('createSecurityEmergencyLockdownPayload');
    expect(securityServiceSource).not.toContain('securityEmergencyRun');
    expect(securityServiceSource).not.toContain('POLICY_SYNC_MAX_ATTEMPTS');
    expect(securityServiceSource).not.toContain('timer.sleep');
    expect(securityServiceSource).not.toContain('this.deps.gateway.');
    expect(securityServiceSource).not.toContain('new SecurityEmergencyResponseWorkflow');
    expect(securityServiceSource).not.toContain('new SecurityPolicySyncWorkflow');
    expect(securityServiceSource).not.toContain('new SecurityGatewayOperationsWorkflow');
    expect(policyRepositorySource).toContain('storeWorkflow');
    expect(policyRepositorySource).not.toContain('normalizeSecurityPolicyPayload');
    expect(policyRepositorySource).not.toContain('writeTextFile');
    expect(policyRepositorySource).not.toContain('readPolicyFile');
    expect(operationsModuleSource).toContain("container.register('security.policyStoreWorkflow'");
    expect(operationsModuleSource).toContain("scope.resolve<SecurityPolicyStoreWorkflow>('security.policyStoreWorkflow')");
    expect(operationsModuleSource).toContain("container.register('security.emergencyResponseWorkflow'");
    expect(operationsModuleSource).toContain("container.register('security.policySyncWorkflow'");
    expect(operationsModuleSource).toContain("container.register('security.gatewayOperationsWorkflow'");
    expect(operationsModuleSource).toContain("container.register('security.operationsWorkflow'");
    expect(operationsModuleSource).toContain("operationsWorkflow: scope.resolve<SecurityOperationsWorkflow>('security.operationsWorkflow')");
  });

  it('OpenClaw auth profile I/O 留在 workflow 层，不回流到 auth repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-store.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-store-workflow.ts'), 'utf8');
    const infrastructureModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawAuthStoreWorkflow');
    expect(workflowSource).toContain('AUTH_PROFILE_FILENAME');
    expect(workflowSource).toContain('readJsonFile');
    expect(workflowSource).toContain('writeJsonFile');
    expect(workflowSource).toContain('discoverAgentIds');
    expect(workflowSource).toContain('listDirectory');
    expect(repositorySource).toContain('storeWorkflow');
    expect(repositorySource).not.toContain('listDirectory');
    expect(repositorySource).not.toContain('readTextFile');
    expect(repositorySource).not.toContain('writeTextFile');
    expect(repositorySource).not.toContain('JSON.parse');
    expect(infrastructureModuleSource).toContain("container.register('openclaw.authStoreWorkflow'");
    expect(infrastructureModuleSource).toContain("scope.resolve<OpenClawAuthStoreWorkflow>('openclaw.authStoreWorkflow')");
  });

  it('OpenClaw agent models.json 批量读写与 provider 归一化留在 workflow 层，不回流到 repository', async () => {
    const repositorySource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/infrastructure/openclaw-agent-model-repository.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-agent-model-store-workflow.ts'), 'utf8');
    const infrastructureModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-infrastructure-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class OpenClawAgentModelStoreWorkflow');
    expect(workflowSource).toContain('models.json');
    expect(workflowSource).toContain('normalizeModelEntry');
    expect(workflowSource).toContain('delete existing.apiKey');
    expect(workflowSource).toContain('readModelsJson');
    expect(workflowSource).toContain('writeModelsJson');
    expect(repositorySource).toContain('storeWorkflow');
    expect(repositorySource).not.toContain('models.json');
    expect(repositorySource).not.toContain('normalizeModelEntry');
    expect(repositorySource).not.toContain('delete existing.apiKey');
    expect(repositorySource).not.toContain('readTextFile');
    expect(repositorySource).not.toContain('writeTextFile');
    expect(repositorySource).not.toContain('JSON.parse');
    expect(infrastructureModuleSource).toContain("container.register('openclaw.agentModelStoreWorkflow'");
    expect(infrastructureModuleSource).toContain("scope.resolve<OpenClawAgentModelStoreWorkflow>('openclaw.agentModelStoreWorkflow')");
  });

  it('preinstalled skills 安装编排留在 workflow 层，不回流到 skills service', async () => {
    const skillsServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/skills/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/skill-install/preinstalled-skills-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class PreinstalledSkillsWorkflow');
    expect(workflowSource).toContain('readPreinstalledManifest');
    expect(workflowSource).toContain('readPreinstalledLockVersions');
    expect(workflowSource).toContain('tryReadPreinstalledMarker');
    expect(workflowSource).toContain('copyDirectory');
    expect(workflowSource).toContain('submitGatewayUpdate');
    expect(skillsServiceSource).toContain('preinstalledSkillsWorkflow');
    expect(skillsServiceSource).toContain('operationsWorkflow');
    expect(skillsServiceSource).not.toContain('readPreinstalledManifest');
    expect(skillsServiceSource).not.toContain('readPreinstalledLockVersions');
    expect(skillsServiceSource).not.toContain('tryReadPreinstalledMarker');
    expect(skillsServiceSource).not.toContain('copyDirectory');
    expect(skillsServiceSource).not.toContain('matchaclaw-preinstalled');
    expect(skillsServiceSource).not.toContain('new PreinstalledSkillsWorkflow');
    expect(openClawModuleSource).toContain("container.register('skills.preinstalledWorkflow'");
    expect(openClawModuleSource).toContain("container.register('skills.operationsWorkflow'");
    expect(openClawModuleSource).toContain("preinstalledSkillsWorkflow: scope.resolve<PreinstalledSkillsWorkflow>('skills.preinstalledWorkflow')");
  });

  it('skill bundle 导入导出编排留在 workflow 层，不回流到 skills service', async () => {
    const skillsServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/skills/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/skill-install/skill-bundle-transfer-workflow.ts'), 'utf8');
    const openClawModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/openclaw-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class SkillBundleTransferWorkflow');
    expect(workflowSource).toContain('collectTextFiles');
    expect(workflowSource).toContain('normalizeBundleFilePath');
    expect(workflowSource).toContain('validateSkillManifest');
    expect(workflowSource).toContain('writeTextFile');
    expect(workflowSource).toContain('submitGatewayUpdate');
    expect(workflowSource).toContain('submitRefreshStatus');
    expect(skillsServiceSource).toContain('skillBundleTransferWorkflow');
    expect(skillsServiceSource).toContain('operationsWorkflow');
    expect(skillsServiceSource).not.toContain('collectTextFiles');
    expect(skillsServiceSource).not.toContain('normalizeBundleFilePath');
    expect(skillsServiceSource).not.toContain('validateSkillManifest');
    expect(skillsServiceSource).not.toContain('writeTextFile(targetPath, file.content)');
    expect(skillsServiceSource).not.toContain('submitGatewayUpdate({ skillKey: bundle.skillKey');
    expect(skillsServiceSource).not.toContain('new SkillBundleTransferWorkflow');
    expect(openClawModuleSource).toContain("container.register('skills.bundleTransferWorkflow'");
    expect(openClawModuleSource).toContain("skillBundleTransferWorkflow: scope.resolve<SkillBundleTransferWorkflow>('skills.bundleTransferWorkflow')");
  });

  it('scheduled-agent 触发编排留在 workflow 层，不回流到 cron service', async () => {
    const cronServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/cron/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/scheduled-agent/scheduled-agent-trigger-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    await expect(stat(path.join(process.cwd(), 'runtime-host/application/cron/manual-trigger.ts'))).rejects.toThrow();
    expect(workflowSource).toContain('export class ScheduledAgentTriggerWorkflow');
    expect(workflowSource).toContain('buildManualRunPatches');
    expect(workflowSource).toContain('shouldUseManualRunProfileSwitch');
    expect(cronServiceSource).toContain('operationsWorkflow');
    expect(cronServiceSource).not.toContain('jobMutationWorkflow');
    expect(cronServiceSource).not.toContain('buildManualRunPatches');
    expect(cronServiceSource).not.toContain('shouldUseManualRunProfileSwitch');
    expect(cronServiceSource).not.toContain('new ScheduledAgentTriggerWorkflow');
    expect(operationsModuleSource).toContain("container.register('scheduledAgent.triggerWorkflow'");
    expect(operationsModuleSource).toContain("scheduledAgentTriggerWorkflow: scope.resolve<ScheduledAgentTriggerWorkflow>('scheduledAgent.triggerWorkflow')");
  });

  it('cron job mutation 与 snapshot 编排留在 workflow 层，不回流到 cron service', async () => {
    const cronServiceSource = await readFile(path.join(process.cwd(), 'runtime-host/application/cron/service.ts'), 'utf8');
    const workflowSource = await readFile(path.join(process.cwd(), 'runtime-host/application/workflows/cron/cron-job-mutation-workflow.ts'), 'utf8');
    const operationsModuleSource = await readFile(path.join(process.cwd(), 'runtime-host/composition/modules/operations-application-module.ts'), 'utf8');

    expect(workflowSource).toContain('export class CronJobMutationWorkflow');
    expect(workflowSource).toContain('refreshJobsSnapshot');
    expect(workflowSource).toContain('executeDeliveryRepair');
    expect(workflowSource).toContain('buildUpdatePatch');
    expect(workflowSource).toContain('addCronJob');
    expect(cronServiceSource).toContain('operationsWorkflow');
    expect(cronServiceSource).not.toContain('jobMutationWorkflow');
    expect(cronServiceSource).not.toContain('parseGatewayCronJobs');
    expect(cronServiceSource).not.toContain('addCronJob');
    expect(cronServiceSource).not.toContain('updateCronJob');
    expect(cronServiceSource).not.toContain('removeCronJob');
    expect(cronServiceSource).not.toContain('new CronJobMutationWorkflow');
    expect(operationsModuleSource).toContain("container.register('cron.jobMutationWorkflow'");
    expect(operationsModuleSource).toContain("jobMutationWorkflow: scope.resolve<CronJobMutationWorkflow>('cron.jobMutationWorkflow')");
  });

  it('session runtime 不通过 operations task snapshot bridge 反查任务状态', async () => {
    const checkedFiles = [
      'runtime-host/composition/runtime-host-module-registry.ts',
      'runtime-host/composition/runtime-host-runtime-module-registry.ts',
      'runtime-host/composition/modules/session-runtime-module.ts',
      'runtime-host/composition/modules/operations-application-module.ts',
      'runtime-host/application/sessions/session-command-service.ts',
      'runtime-host/application/workflows/session-hydration/session-hydration-workflow.ts',
    ];
    const violations: string[] = [];

    for (const file of checkedFiles) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8');
      if (source.includes('task.snapshotBridge') || source.includes('TaskSnapshotBridgePort') || source.includes('readTaskSnapshot')) {
        violations.push(file);
      }
    }

    await expect(stat(path.join(process.cwd(), 'runtime-host/application/sessions/task-snapshot-bridge.ts'))).rejects.toThrow();
    expect(violations).toEqual([]);
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
