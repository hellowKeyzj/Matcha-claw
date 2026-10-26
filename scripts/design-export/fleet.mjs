const AT = '2026-10-22T08:30:00.000Z';
const LATER = '2026-10-22T09:30:00.000Z';
const PRIMARY = {
  connectionId: 'design-ssh', environmentId: 'design-lab', managedResourceId: 'design-debian',
  nodeId: 'design-node', agentId: 'design-agent', runtimeId: 'design-runtime', endpointId: 'design-endpoint',
};
const SOURCES = [
  'src/plugins/fleet/page.tsx',
  'src/plugins/fleet/components/RemoteFleetResourceBrowser.tsx',
  'src/plugins/fleet/components/RemoteFleetDetailPanel.tsx',
  'src/plugins/fleet/store.ts',
];
const KEYS = ['connections', 'environments', 'managedResources', 'nodes', 'agents', 'runtimes', 'endpoints', 'capabilities', 'commands', 'leases', 'sessions', 'auditEvents'];
const TYPES = [
  ['connections', '连接', '设计实验室 SSH'], ['environments', '环境', '设计实验环境'],
  ['managedResources', '资源', 'Debian 工作容器'], ['nodes', '节点', '实验室 Linux 节点'],
  ['agents', '代理', '实验室管理代理'], ['runtimes', '运行时', '研究运行时'], ['endpoints', '端点', PRIMARY.endpointId],
];
const TABS = [['overview', '概览'], ['terminal', '终端'], ['commands', '命令'], ['audit', '审计'], ['capabilities', '能力']];

function snapshotFor(scenarioId = '') {
  if (scenarioId === 'fleet-empty') return Object.fromEntries(KEYS.map((key) => [key, []]));
  const connection = (id, displayName, targetKind, status = 'online', extra = {}) => ({
    id, displayName, connectionKind: targetKind, targetKind, status, enabled: true,
    endpointUrl: targetKind === 'ssh-host' || targetKind === 'vm' ? `ssh://matcha@${id}.example.test:22` : `https://${id}.example.test`,
    labels: ['design-demo', '研发'], createdAt: AT, updatedAt: AT, lastSeenAt: AT, ...extra,
  });
  const snapshot = {
    connections: [
      connection(PRIMARY.connectionId, '设计实验室 SSH', 'ssh-host'),
      connection('design-docker', '容器工作站', 'container'),
      connection('design-k8s', '集群连接', 'k8s-pod'),
      connection('design-vm', '虚拟机连接', 'vm', 'offline', { reason: '演示节点暂时离线，等待下一次连接检查。' }),
      connection('design-custom', '外部自定义连接', 'custom'),
      connection('design-unused', '待删除的独立连接', 'ssh-host', 'unverified'),
    ],
    environments: [
      { id: PRIMARY.environmentId, connectionId: PRIMARY.connectionId, nodeId: PRIMARY.nodeId, displayName: '设计实验环境', environmentKind: 'ssh-workdir', targetKind: 'ssh-host', status: 'ready', enabled: true, managedResourceIds: [PRIMARY.managedResourceId, 'design-external-volume'], labels: ['design-demo', '研发'], createdAt: AT, updatedAt: AT },
      { id: 'design-docker-lab', connectionId: 'design-docker', nodeId: 'design-container-node', displayName: '容器部署环境', environmentKind: 'docker-container', targetKind: 'container', status: 'deploying', enabled: true, managedResourceIds: ['design-container'], reason: '正在准备 Debian 工作环境。', updatedAt: AT },
      { id: 'design-k8s-lab', connectionId: 'design-k8s', displayName: '集群异常环境', environmentKind: 'kubernetes-workload', targetKind: 'k8s-pod', status: 'failed', enabled: true, managedResourceIds: [], reason: '演示集群调度容量不足，请检查工作负载配额。', updatedAt: AT },
      { id: 'design-custom-lab', connectionId: 'design-custom', nodeId: 'design-custom-node', displayName: '外部管理环境', environmentKind: 'custom', targetKind: 'custom', status: 'registered', enabled: true, managedResourceIds: [], updatedAt: AT },
    ],
    managedResources: [
      { id: PRIMARY.managedResourceId, connectionId: PRIMARY.connectionId, environmentId: PRIMARY.environmentId, nodeId: PRIMARY.nodeId, displayName: 'Debian 工作容器', providerKind: 'docker', resourceKind: 'container', remoteResourceId: 'design-container-01', status: 'running', ownership: 'matcha-managed', cleanupPolicy: 'delete-on-environment-delete', labels: ['design-demo'], createdAt: AT, updatedAt: AT, lastObservedAt: AT },
      { id: 'design-external-volume', connectionId: PRIMARY.connectionId, environmentId: PRIMARY.environmentId, displayName: '保留的外部数据卷', providerKind: 'docker', resourceKind: 'volume', remoteResourceId: 'design-volume-01', status: 'observed', ownership: 'external', cleanupPolicy: 'retain', updatedAt: AT, lastObservedAt: AT },
      { id: 'design-container', connectionId: 'design-docker', environmentId: 'design-docker-lab', nodeId: 'design-container-node', displayName: '待就绪工作容器', providerKind: 'docker', resourceKind: 'container', remoteResourceId: 'design-container-02', status: 'provisioning', ownership: 'matcha-managed', cleanupPolicy: 'delete-on-environment-delete', updatedAt: AT },
    ],
    nodes: [
      { ...PRIMARY, id: PRIMARY.nodeId, displayName: '实验室 Linux 节点', description: '用于离线设计展示的合成远端节点。', targetKind: 'ssh-host', endpointUrl: 'ssh://matcha@lab.example.test:22', status: 'online', enabled: true, labels: ['linux', 'design-demo'], lastSeenAt: AT },
      { id: 'design-container-node', connectionId: 'design-docker', environmentId: 'design-docker-lab', managedResourceId: 'design-container', displayName: '容器执行节点', targetKind: 'container', endpointUrl: 'https://docker.example.test:2376', status: 'offline', enabled: true, labels: ['container'], reason: '演示容器尚未完成部署。', lastSeenAt: AT },
      { id: 'design-disabled-node', connectionId: 'design-vm', displayName: '已禁用节点', targetKind: 'vm', status: 'disabled', enabled: false, reason: '维护窗口期间暂停连接。', labels: ['maintenance'] },
      { id: 'design-custom-node', connectionId: 'design-custom', environmentId: 'design-custom-lab', displayName: '外部自定义节点', targetKind: 'custom', status: 'online', enabled: true, endpointUrl: 'https://external.example.test' },
    ],
    agents: [
      { ...PRIMARY, id: PRIMARY.agentId, displayName: '实验室管理代理', status: 'enrolled', capabilities: ['terminal', 'runtime.lifecycle', 'capability.sync'], model: '合成模型 · 设计演示' },
      { id: 'design-revoked-agent', nodeId: 'design-container-node', connectionId: 'design-docker', environmentId: 'design-docker-lab', displayName: '已撤销管理代理', status: 'revoked', capabilities: [] },
    ],
    runtimes: [
      { ...PRIMARY, id: PRIMARY.runtimeId, displayName: '研究运行时', status: 'running', startedAt: AT },
      { id: 'design-stopped-runtime', nodeId: PRIMARY.nodeId, connectionId: PRIMARY.connectionId, environmentId: PRIMARY.environmentId, agentId: PRIMARY.agentId, endpointId: 'design-draining-endpoint', displayName: '已停止运行时', status: 'stopped', reason: '演示运行时已按维护计划停止。' },
    ],
    endpoints: [
      { ...PRIMARY, id: PRIMARY.endpointId, url: 'https://runtime.example.test/v1', protocol: 'https', status: 'ready', lastProbeAt: AT, labels: ['design-demo', 'linux'] },
      { id: 'design-draining-endpoint', nodeId: PRIMARY.nodeId, connectionId: PRIMARY.connectionId, environmentId: PRIMARY.environmentId, runtimeId: 'design-stopped-runtime', url: 'https://draining.example.test/v1', protocol: 'https', status: 'draining', lastProbeAt: AT, labels: ['maintenance'] },
      { id: 'design-retired-endpoint', nodeId: 'design-container-node', connectionId: 'design-docker', environmentId: 'design-docker-lab', runtimeId: 'design-retired-runtime', url: 'https://retired.example.test/v1', protocol: 'https', status: 'retired', lastProbeAt: AT, labels: ['archived'] },
      { id: 'design-custom-endpoint', nodeId: 'design-custom-node', connectionId: 'design-custom', environmentId: 'design-custom-lab', runtimeId: 'design-custom-runtime', url: 'https://external.example.test/v1', protocol: 'https', status: 'ready', lastProbeAt: AT },
    ],
    capabilities: [
      { ...PRIMARY, id: 'design-capability', displayName: '终端与运行时管理', status: 'current', operationIds: ['remoteFleet.terminal.attach', 'runtime.start', 'runtime.stop'] },
      { ...PRIMARY, id: 'design-stale-capability', displayName: '待同步的文件读取能力', status: 'stale', operationIds: ['files.read'] },
      { id: 'design-custom-capability', nodeId: 'design-custom-node', connectionId: 'design-custom', environmentId: 'design-custom-lab', runtimeId: 'design-custom-runtime', endpointId: 'design-custom-endpoint', displayName: '外部任务能力', status: 'current', operationIds: ['task.run'] },
    ],
    commands: [
      { ...PRIMARY, id: 'design-command-probe', command: 'probeNode', status: 'succeeded', createdAt: AT, updatedAt: AT, message: '合成检查已完成，节点可用。' },
      { ...PRIMARY, id: 'design-command-sync', command: 'syncCapabilities', status: 'queued', createdAt: AT, updatedAt: AT, message: '能力同步已排队。' },
      { ...PRIMARY, id: 'design-command-deploy', command: 'deployEnvironment', status: 'failed', createdAt: AT, updatedAt: AT, message: '合成部署失败：工作容器镜像尚未就绪。' },
      { ...PRIMARY, id: 'design-command-running', command: 'installAgent', status: 'running', createdAt: AT, updatedAt: AT, message: '正在准备演示代理。' },
    ],
    leases: [
      { id: 'design-active-lease', endpointId: PRIMARY.endpointId, ownerKind: 'session', ownerId: 'design-research-session', status: 'active', expiresAt: LATER },
      { id: 'design-released-lease', endpointId: PRIMARY.endpointId, ownerKind: 'task', ownerId: 'design-completed-task', status: 'released', expiresAt: AT },
    ],
    sessions: [{ id: 'design-idle-session', nodeId: PRIMARY.nodeId, runtimeId: PRIMARY.runtimeId, endpointId: PRIMARY.endpointId, targetKind: 'ssh-host', status: 'closed', createdAt: AT, updatedAt: AT, expiresAt: LATER }],
    auditEvents: [
      { id: 'design-audit-probe', eventName: 'fleet.node.probe.completed', nodeId: PRIMARY.nodeId, agentId: PRIMARY.agentId, runtimeId: PRIMARY.runtimeId, endpointId: PRIMARY.endpointId, commandId: 'design-command-probe', occurredAt: AT, message: '节点检查完成，公开投影已更新。' },
      { id: 'design-audit-deploy', eventName: 'fleet.environment.deploy.failed', nodeId: PRIMARY.nodeId, agentId: PRIMARY.agentId, runtimeId: PRIMARY.runtimeId, endpointId: PRIMARY.endpointId, commandId: 'design-command-deploy', occurredAt: AT, message: '部署失败摘要；原始输出不进入 Renderer。' },
    ],
    updatedAt: AT,
  };
  if (scenarioId.includes('related-empty')) {
    snapshot.commands = [];
    snapshot.auditEvents = [];
    snapshot.capabilities = [];
  }
  if (scenarioId === 'fleet-connection-multiple-nodes-terminal') snapshot.nodes.push({
    id: 'design-second-node', connectionId: PRIMARY.connectionId, environmentId: PRIMARY.environmentId,
    displayName: '实验室第二节点', targetKind: 'ssh-host', status: 'online', enabled: true,
  });
  if (scenarioId === 'fleet-operations-commands-empty') snapshot.commands = [];
  if (scenarioId === 'fleet-operations-audit-empty') snapshot.auditEvents = [];
  if (scenarioId === 'fleet-custom-terminal-ready') snapshot.capabilities.push({
    id: 'design-custom-terminal', connectionId: 'design-custom', environmentId: 'design-custom-lab',
    nodeId: 'design-custom-node', runtimeId: 'design-custom-runtime', endpointId: 'design-custom-endpoint',
    displayName: '外部终端接入', status: 'current', operationIds: ['remoteFleet.terminal.attach'],
  });
  return snapshot;
}

function metricsFor(snapshot) {
  const counts = (items, field = 'status') => items.reduce((result, item) => {
    if (item[field]) result[item[field]] = (result[item[field]] ?? 0) + 1;
    return result;
  }, {});
  const bucket = (items) => ({ totalCount: items.length, countByStatus: counts(items) });
  return {
    nodes: { ...bucket(snapshot.nodes), countByTargetKind: counts(snapshot.nodes, 'targetKind') },
    agents: bucket(snapshot.agents),
    runtimes: { ...bucket(snapshot.runtimes), countByRuntimeKind: snapshot.runtimes.length ? { openClaw: 1, matchaAgent: 1 } : {} },
    endpoints: { ...bucket(snapshot.endpoints), drainingEndpoints: snapshot.endpoints.filter((item) => item.status === 'draining'), retiredEndpoints: snapshot.endpoints.filter((item) => item.status === 'retired') },
    capabilities: { ...bucket(snapshot.capabilities), staleCount: snapshot.capabilities.filter((item) => item.status === 'stale').length },
    commands: { ...bucket(snapshot.commands), recentFailureCount: snapshot.commands.filter((item) => item.status === 'failed').length },
    leases: { ...bucket(snapshot.leases), activeCount: snapshot.leases.filter((item) => item.status === 'active').length },
    auditEvents: { totalCount: snapshot.auditEvents.length, countByEventName: counts(snapshot.auditEvents, 'eventName') },
  };
}

function terminalResult(body, snapshot, scenarioId) {
  const endpoint = snapshot.endpoints.find((item) => item.id === body.endpointId);
  const runtime = snapshot.runtimes.find((item) => item.id === (body.runtimeId ?? endpoint?.runtimeId));
  const nodeId = body.nodeId ?? runtime?.nodeId ?? endpoint?.nodeId ?? PRIMARY.nodeId;
  const session = {
    id: body.sessionId ?? `design-terminal-${scenarioId || 'fleet'}`, nodeId,
    ...(runtime ? { runtimeId: runtime.id } : {}), ...(endpoint ? { endpointId: endpoint.id } : {}),
    targetKind: snapshot.nodes.find((item) => item.id === nodeId)?.targetKind ?? 'ssh-host',
    status: 'opening', createdAt: AT, updatedAt: AT, expiresAt: LATER,
  };
  return { session, terminalConnection: {
    sessionId: session.id, ticket: 'synthetic-design-ticket-not-a-credential',
    websocketPath: `/api/remote-fleet/terminal/design-stream/${encodeURIComponent(session.id)}`, expiresAt: LATER,
  } };
}

export function fleetFixture(path, body = {}, context = {}) {
  if (!path.startsWith('/api/remote-fleet/')) return undefined;
  const scenarioId = context.scenarioId ?? '';
  const snapshot = snapshotFor(scenarioId);
  const unavailable = (message) => ({ __designHttpStatus: 503, json: { success: false, error: message } });
  const command = (name, target = {}, status = 'succeeded') => ({
    id: `design-${name}`, command: name, ...target, status, createdAt: AT, updatedAt: AT,
    message: status === 'failed' ? '合成操作失败：请检查环境配置。' : '合成操作已完成；未访问远端服务。',
  });
  switch (path) {
    case '/api/remote-fleet/snapshot':
      return scenarioId === 'fleet-snapshot-error' ? unavailable('离线示例：资源快照暂时不可用。') : snapshot;
    case '/api/remote-fleet/metrics': return metricsFor(snapshot);
    case '/api/remote-fleet/list-commands':
      return scenarioId === 'fleet-operations-commands-error' ? unavailable('离线示例：命令摘要暂时不可用。') : { commands: snapshot.commands };
    case '/api/remote-fleet/list-audit-events':
      return scenarioId === 'fleet-operations-audit-error' ? unavailable('离线示例：审计摘要暂时不可用。') : { auditEvents: snapshot.auditEvents };
    case '/api/remote-fleet/terminal/sessions': return { sessions: snapshot.sessions };
    case '/api/remote-fleet/write-credential': return {
      operationId: body.operationId, credentialName: body.credentialName, writtenAt: AT,
      credentialRef: { kind: 'secret-ref', ref: `remote-fleet://credentials/${body.credentialId}/${body.credentialName}` },
    };
    case '/api/remote-fleet/register-connection': {
      if (scenarioId === 'fleet-registration-api-error') return unavailable('离线示例：连接登记暂时不可用。');
      const input = body.connection ?? {};
      return { success: true, connection: {
        id: input.id || 'design-new-connection', displayName: input.displayName || '新登记的设计连接',
        connectionKind: input.connectionKind, targetKind: input.targetKind ?? input.connectionKind,
        endpointUrl: input.endpointUrl, labels: input.labels ?? [], enabled: input.enabled !== false,
        status: 'unverified', createdAt: AT, updatedAt: AT,
      } };
    }
    case '/api/remote-fleet/register-environment': {
      const input = body.environment ?? {};
      return { success: true, environment: {
        id: input.id || 'design-new-environment', connectionId: input.connectionId,
        displayName: input.displayName || '新登记的设计环境', environmentKind: input.environmentKind,
        targetKind: input.targetKind, labels: input.labels ?? [], enabled: input.enabled !== false,
        managedResourceIds: [], status: 'registered', createdAt: AT, updatedAt: AT,
      } };
    }
    case '/api/remote-fleet/probe-connection': return {
      connection: { ...snapshot.connections.find((item) => item.id === body.connectionId), status: 'online', lastSeenAt: AT },
      command: command('probeConnection', { connectionId: body.connectionId }),
    };
    case '/api/remote-fleet/delete-connection': return {
      success: true, snapshot: { connections: snapshot.connections.filter((item) => item.id !== body.connectionId) },
      command: command('deleteConnection', { connectionId: body.connectionId }),
    };
    case '/api/remote-fleet/deploy-environment': return {
      environment: { connectionId: 'design-new-connection', displayName: '新登记的设计环境', ...snapshot.environments.find((item) => item.id === body.environmentId), id: body.environmentId, status: scenarioId === 'fleet-registration-deploy-error' ? 'failed' : 'ready', updatedAt: AT },
      command: command('deployEnvironment', { environmentId: body.environmentId }, scenarioId === 'fleet-registration-deploy-error' ? 'failed' : 'succeeded'),
    };
    case '/api/remote-fleet/delete-environment': return {
      success: true, snapshot: { environments: snapshot.environments.filter((item) => item.id !== body.environmentId) },
      command: command('deleteEnvironment', { environmentId: body.environmentId }),
    };
    case '/api/remote-fleet/probe': return {
      node: { ...snapshot.nodes.find((item) => item.id === body.nodeId), status: 'online', lastSeenAt: AT }, command: command('probeNode', { nodeId: body.nodeId }),
    };
    case '/api/remote-fleet/install-agent': return { command: command('installAgent', { nodeId: body.nodeId }) };
    case '/api/remote-fleet/remove-node': return { success: true, snapshot: { nodes: snapshot.nodes.filter((item) => item.id !== body.nodeId) } };
    case '/api/remote-fleet/revoke-agent': return { agent: { ...snapshot.agents.find((item) => item.id === body.agentId), status: 'revoked' } };
    case '/api/remote-fleet/start-runtime':
    case '/api/remote-fleet/stop-runtime': {
      const start = path.endsWith('/start-runtime');
      return { runtime: { ...snapshot.runtimes.find((item) => item.id === body.runtimeId), status: start ? 'running' : 'stopped' }, command: command(start ? 'startRuntime' : 'stopRuntime', { runtimeId: body.runtimeId }) };
    }
    case '/api/remote-fleet/drain-endpoint':
    case '/api/remote-fleet/retire-endpoint': return { endpoint: { ...snapshot.endpoints.find((item) => item.id === body.endpointId), status: path.endsWith('/drain-endpoint') ? 'draining' : 'retired' } };
    case '/api/remote-fleet/sync-capabilities': return { command: command('syncCapabilities', { endpointId: body.endpointId }), capability: { ...snapshot.capabilities.find((item) => item.endpointId === body.endpointId), status: 'current' } };
    case '/api/remote-fleet/terminal/open':
      return scenarioId === 'fleet-terminal-open-error' ? unavailable('离线示例：终端打开失败。') : terminalResult(body, snapshot, scenarioId);
    case '/api/remote-fleet/terminal/reconnect':
      return scenarioId === 'fleet-terminal-reconnect-error' ? unavailable('离线示例：终端重新连接失败。') : terminalResult(body, snapshot, scenarioId);
    case '/api/remote-fleet/terminal/close': return { success: true, session: { id: body.sessionId, nodeId: PRIMARY.nodeId, status: 'closed', updatedAt: AT } };
    default: return undefined;
  }
}

function installTerminalSocket(scenarioId) {
  const BaseSocket = globalThis.WebSocket;
  class FleetDesignSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
      super();
      if (!new URL(String(url), location.href).pathname.startsWith('/api/remote-fleet/terminal/design-stream/')) {
        return protocols === undefined ? new BaseSocket(url) : new BaseSocket(url, protocols);
      }
      this.url = String(url);
      this.readyState = 0;
      this.binaryType = 'arraybuffer';
      this.bufferedAmount = 0;
      this.protocol = '';
      this.extensions = '';
      this.authenticated = false;
      if (scenarioId === 'fleet-terminal-connecting') return;
      setTimeout(() => {
        if (this.readyState !== 0) return;
        if (scenarioId === 'fleet-terminal-connection-error') {
          this.readyState = 3;
          this.dispatchEvent(new Event('error'));
          this.dispatchEvent(new CloseEvent('close', { code: 1006 }));
          return;
        }
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }, 20);
    }
    send(data) {
      if (this.readyState !== 1 || this.authenticated || typeof data !== 'string') return;
      const frame = JSON.parse(data);
      if (!frame.ticket) return;
      this.authenticated = true;
      this.message(JSON.stringify({ type: 'terminal.ready' }));
      this.message(new TextEncoder().encode(
        '\u001b[1;32mMatcha Fleet · offline design demo\u001b[0m\r\n'
        + 'All data and terminal output below are synthetic.\r\n\r\n'
        + '\u001b[36mmatcha@design-lab\u001b[0m:~$ uname -sr\r\nLinux 6.8.0-design\r\n'
        + '\u001b[36mmatcha@design-lab\u001b[0m:~$ fleet status\r\n'
        + 'node        online\r\nruntime     running\r\nendpoint    ready\r\n\r\n'
        + '\u001b[36mmatcha@design-lab\u001b[0m:~$ ',
      ).buffer);
      setTimeout(() => {
        if (this.readyState !== 1) return;
        if (scenarioId === 'fleet-terminal-remote-error') this.message(JSON.stringify({ type: 'terminal.error', message: 'Synthetic remote error' }));
        if (scenarioId === 'fleet-terminal-exited') this.message(JSON.stringify({ type: 'terminal.exit', exitCode: 0, signal: 'none' }));
        if (scenarioId === 'fleet-terminal-closed') this.close(1000, 'Synthetic session closed');
      }, 40);
    }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
    }
  }
  globalThis.WebSocket = FleetDesignSocket;
}

export async function seedFleet(context = {}) {
  const scenarioId = context.scenarioId ?? new URL(location.href).searchParams.get('scene') ?? '';
  if (!scenarioId.startsWith('fleet-')) return;
  const { useRemoteFleetStore } = await import('/src/plugins/fleet/store.ts');
  if (context.phase === 'settled') return useRemoteFleetStore.getState().ready && !useRemoteFleetStore.getState().loading;
  if (context.phase === 'capture') {
    if (scenarioId === 'fleet-loading') useRemoteFleetStore.setState({ ...Object.fromEntries(KEYS.map((key) => [key, []])), ready: false, loading: true, error: null });
    if (scenarioId === 'fleet-operations-metrics-loading') useRemoteFleetStore.setState({ metrics: null, mutatingAction: 'load-metrics' });
    if (scenarioId === 'fleet-operations-metrics-unavailable') useRemoteFleetStore.setState({ metrics: null, error: '离线示例：全局指标暂时不可用。', mutatingAction: null });
    return;
  }
  useRemoteFleetStore.setState({ ...snapshotFor(scenarioId), ready: true, loading: false, metrics: null, mutatingAction: null, error: null });
  installTerminalSocket(scenarioId);
}

async function selectResource(page, type, title) {
  await page.getByRole('tab', { name: '资源', exact: true }).click();
  await page.locator('select[aria-label="资源类型"], nav[aria-label="资源类型"]').first().waitFor();
  const select = page.locator('select[aria-label="资源类型"]');
  if (await select.isVisible()) await select.selectOption(type);
  else {
    const label = TYPES.find(([key]) => key === type)[1];
    await page.locator('nav[aria-label="资源类型"]').getByRole('button').filter({ has: page.getByText(label, { exact: true }) }).click();
  }
  await page.locator('button[aria-pressed]').filter({ has: page.locator(`[title="${title}"]`) }).click();
}

async function resourceTab(page, type, title, tab = '概览') {
  await selectResource(page, type, title);
  await page.getByRole('tab', { name: tab, exact: true }).click();
}

async function operationsTab(page, tab = '概览') {
  await page.getByRole('tab', { name: '运维', exact: true }).click();
  await page.getByRole('navigation', { name: '运维', exact: true }).getByRole('tab', { name: tab, exact: true }).click();
}

async function captureState(page, scenarioId) {
  await page.evaluate(async (id) => {
    const { seedFleet } = await import('/scripts/design-export/fleet.mjs');
    await seedFleet({ scenarioId: id, phase: 'capture' });
  }, scenarioId);
}

async function registration(page, targetKind = 'ssh-host', auth) {
  await page.getByRole('button', { name: '添加远端', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#remote-node-target-kind').selectOption(targetKind);
  await dialog.locator('#remote-node-name').fill('离线设计新连接');
  if (targetKind === 'ssh-host') {
    await dialog.locator('#remote-node-ssh-host').fill('new-ssh.example.test');
    await dialog.locator('#remote-node-ssh-port').fill('22');
    await dialog.locator('#remote-node-ssh-username').fill('matcha');
    if (auth) await dialog.locator('#remote-node-ssh-auth-method').selectOption(auth);
  }
  if (targetKind === 'container') {
    await dialog.locator('#remote-node-container-endpoint').fill('https://new-docker.example.test:2376');
    await dialog.locator('#remote-node-container-name').fill('design-workspace');
    if (auth) await dialog.locator('#remote-node-container-auth').selectOption(auth);
  }
  if (targetKind === 'k8s-pod') {
    await dialog.locator('#remote-node-k8s-api-server').fill('https://new-k8s.example.test:6443');
    await dialog.locator('#remote-node-k8s-namespace').fill('design-lab');
  }
  if (targetKind === 'custom') await dialog.locator('#remote-node-custom-endpoint').fill('https://new-custom.example.test');
  if (targetKind === 'vm') {
    await dialog.locator('#remote-node-vm-host').fill('new-vm.example.test');
    await dialog.locator('#remote-node-vm-port').fill('22');
    await dialog.locator('#remote-node-vm-username').fill('matcha');
    if (auth) await dialog.locator('#remote-node-vm-auth').selectOption(auth);
  }
}

async function advanced(page) {
  await page.getByRole('dialog').locator('button[aria-expanded]').click();
}

async function openTerminal(page, type = 'nodes', title = '实验室 Linux 节点') {
  await resourceTab(page, type, title, '终端');
  await page.getByRole('button', { name: '打开终端', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Remote Fleet 终端', { exact: true }).waitFor();
}

function scene(id, title, prepare, extra = {}) {
  const sources = [...SOURCES];
  if (id.startsWith('operations-')) sources.push('src/plugins/fleet/components/RemoteFleetOperationsSection.tsx');
  if (id.startsWith('registration-')) sources.push('src/plugins/fleet/components/RemoteFleetRegistrationSheet.tsx');
  if (id.startsWith('terminal-') || id === 'custom-terminal-ready') sources.push('src/plugins/fleet/components/RemoteFleetTerminalDrawer.tsx', 'src/plugins/fleet/components/useRemoteFleetTerminal.ts');
  return { id: `fleet-${id}`, title, group: '远程资源', route: '/remote-fleet', sources, actions: [], prepare, ...extra };
}

export const fleetScenarios = [
  ...TYPES.flatMap(([type, label, title]) => TABS.map(([tab, tabLabel]) => scene(
    `${type === 'managedResources' ? 'managed-resources' : type}-${tab}`, `${label} · ${tabLabel}`,
    async (page) => resourceTab(page, type, title, tabLabel),
    tab === 'audit' && ['connections', 'environments', 'managedResources'].includes(type)
      ? { notes: '真实 store 的审计 DTO 不保留连接/环境/资源关联字段，此页忠实导出当前关联空态。' } : {},
  ))),
  scene('operations-overview', '运维 · 概览', async (page) => operationsTab(page), { waitFor: '运行中运行时' }),
  scene('operations-commands', '运维 · 命令', async (page) => operationsTab(page, '命令'), { waitFor: 'probeNode' }),
  scene('operations-audit', '运维 · 审计', async (page) => operationsTab(page, '审计'), { waitFor: 'fleet.node.probe.completed' }),
  scene('empty', '远端资源 · 首次连接空态', undefined, { waitFor: '连接第一个远端环境' }),
  scene('loading', '远端资源 · 初次加载', async (page) => {
    await page.locator('[aria-labelledby="remote-fleet-resource-index-title"] button[aria-pressed]').first().waitFor();
    await page.waitForFunction(async () => {
      const { seedFleet } = await import('/scripts/design-export/fleet.mjs');
      return seedFleet({ scenarioId: 'fleet-loading', phase: 'settled' });
    });
    await captureState(page, 'fleet-loading');
  }, { waitFor: '正在加载快照，随后展示选中对象。', notes: '挂载快照结算后仅 setState 固定加载投影；不替换真实 refresh action。' }),
  scene('snapshot-error', '远端资源 · 快照加载失败', undefined, { waitFor: '加载 Remote Fleet 失败' }),
  scene('filter-no-results', '资源筛选 · 无匹配结果', async (page) => {
    await page.getByLabel('搜索资源', { exact: true }).fill('不存在的演示资源');
  }, { waitFor: '没有匹配资源' }),
  scene('filter-status', '资源筛选 · 节点状态', async (page) => {
    await selectResource(page, 'nodes', '实验室 Linux 节点');
    await page.getByLabel('状态筛选', { exact: true }).selectOption('disabled');
  }, { waitFor: '已禁用节点' }),
  scene('filter-environment', '资源筛选 · 环境与类型', async (page) => {
    await selectResource(page, 'managedResources', 'Debian 工作容器');
    await page.getByLabel('环境筛选', { exact: true }).selectOption(PRIMARY.environmentId);
    await page.getByLabel('类型筛选', { exact: true }).selectOption('volume');
  }, { waitFor: '保留的外部数据卷' }),
  ...[['commands', '命令', '暂无关联命令。'], ['audit', '审计', '暂无关联审计事件。'], ['capabilities', '能力', '暂无关联能力。']].map(([tab, label, waitFor]) => scene(
    `related-empty-${tab}`, `资源详情 · 关联${label}空态`, async (page) => resourceTab(page, 'nodes', '实验室 Linux 节点', label), { waitFor },
  )),
  ...[
    ['node-disabled', '禁用节点 · 终端不可用', 'nodes', '已禁用节点', '终端'],
    ['node-offline', '离线节点 · 详情', 'nodes', '容器执行节点', '概览'],
    ['environment-deploying', '环境 · 部署中', 'environments', '容器部署环境', '概览'],
    ['environment-failed', '环境 · 部署失败', 'environments', '集群异常环境', '概览'],
    ['resource-external', '资源 · 外部数据保留', 'managedResources', '保留的外部数据卷', '概览'],
    ['agent-revoked', '代理 · 已撤销', 'agents', '已撤销管理代理', '概览'],
    ['runtime-stopped', '运行时 · 已停止', 'runtimes', '已停止运行时', '概览'],
    ['endpoint-draining', '端点 · 排空中', 'endpoints', 'design-draining-endpoint', '概览'],
    ['endpoint-retired', '端点 · 已退役终端限制', 'endpoints', 'design-retired-endpoint', '终端'],
    ['custom-connection', '自定义连接 · 外部管理说明', 'connections', '外部自定义连接', '概览'],
    ['custom-node-terminal', '自定义节点 · 需选择端点', 'nodes', '外部自定义节点', '终端'],
    ['custom-endpoint-terminal', '自定义端点 · 缺少终端能力', 'endpoints', 'design-custom-endpoint', '终端'],
    ['connection-multiple-nodes-terminal', '连接 · 多节点终端选择提示', 'connections', '设计实验室 SSH', '终端'],
  ].map(([id, title, type, resource, tab]) => scene(id, title, async (page) => resourceTab(page, type, resource, tab))),
  ...[['commands', '命令', '暂无命令'], ['audit', '审计', '暂无审计事件']].flatMap(([view, label, empty]) => [
    scene(`operations-${view}-empty`, `运维 · ${label}空态`, async (page) => operationsTab(page, label), { waitFor: empty }),
    scene(`operations-${view}-error`, `运维 · ${label}读取失败`, async (page) => operationsTab(page, label), { waitFor: '运维数据加载失败' }),
    scene(`operations-${view}-search-empty`, `运维 · ${label}筛选无结果`, async (page) => {
      await operationsTab(page, label);
      await page.getByText(view === 'commands' ? 'probeNode' : 'fleet.node.probe.completed', { exact: true }).filter({ visible: true }).waitFor();
      await page.getByLabel('搜索历史', { exact: true }).fill('no-such-design-record');
    }, { waitFor: empty }),
  ]),
  ...[['loading', '加载中'], ['unavailable', '不可用']].map(([state, title]) => scene(
    `operations-metrics-${state}`, `运维 · 全局指标${title}`, async (page) => {
      await operationsTab(page);
      await page.getByText('运行中运行时', { exact: true }).waitFor();
      await captureState(page, `fleet-operations-metrics-${state}`);
    }, { waitFor: state === 'loading' ? '正在加载全局指标' : '暂无指标' },
  )),
  scene('registration-empty', '添加连接 · 空表单', undefined, { actions: [{ role: 'button', name: '添加远端', exact: true }], waitFor: '添加连接', sources: [...SOURCES, 'src/plugins/fleet/components/RemoteFleetRegistrationSheet.tsx'] }),
  ...[
    ['ssh-password', 'SSH · 密码', 'ssh-host', 'password'], ['ssh-private-key', 'SSH · 私钥', 'ssh-host', 'private-key'],
    ['container', '容器 · 无认证', 'container', 'none'], ['container-token', '容器 · Bearer token', 'container', 'bearer-token'],
    ['k8s', 'Kubernetes Pod', 'k8s-pod'], ['custom', '自定义端点', 'custom'],
    ['vm-password', '虚拟机 · 密码', 'vm', 'password'], ['vm-private-key', '虚拟机 · 私钥', 'vm', 'private-key'],
  ].map(([id, title, targetKind, auth]) => scene(`registration-${id}`, `添加连接 · ${title}`, async (page) => registration(page, targetKind, auth), { sources: [...SOURCES, 'src/plugins/fleet/components/RemoteFleetRegistrationSheet.tsx'] })),
  scene('registration-advanced', '添加连接 · 高级设置', async (page) => {
    await registration(page);
    await advanced(page);
    await page.locator('#remote-node-id').fill('design-new-ssh');
    await page.locator('#remote-node-labels').fill('design-demo, linux');
    await page.locator('#remote-node-secrets').fill('sshPrivateKey=remote-fleet://credentials/design-only/sshPrivateKey');
    await page.locator('#remote-node-public-config').fill('{\n  "ssh": { "workdir": "/srv/design" }\n}');
  }),
  scene('registration-disabled', '添加连接 · 禁用配置', async (page) => {
    await registration(page);
    await advanced(page);
    await page.getByRole('dialog').getByRole('switch').click();
  }),
  ...[
    ['port-error', '#remote-node-ssh-port', '70000', '端口必须是 1 到 65535 的整数。', false],
    ['json-error', '#remote-node-public-config', '{ invalid json', '公开配置必须是合法 JSON。', true],
    ['public-secret-error', '#remote-node-public-config', '{"password":"synthetic-not-a-secret"}', '公开配置包含敏感字段，请移到密钥引用。', true],
    ['secret-ref-error', '#remote-node-secrets', 'not-a-key-value-reference', '密钥引用每行必须是 KEY=已有密钥引用。', true],
  ].map(([id, css, value, waitFor, expand]) => scene(`registration-${id}`, `添加连接 · ${waitFor.replace(/。$/, '')}`, async (page) => {
    await registration(page);
    if (expand) await advanced(page);
    await page.locator(css).fill(value);
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
  }, { waitFor })),
  scene('registration-k8s-error', '添加连接 · Kubernetes URL 校验', async (page) => {
    await registration(page, 'k8s-pod');
    await page.locator('#remote-node-k8s-api-server').fill('http://new-k8s.example.test:6443');
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
  }, { waitFor: 'Kubernetes API server URL 必须使用 https。' }),
  scene('registration-docker-error', '添加连接 · Docker 本机协议校验', async (page) => {
    await registration(page, 'container');
    await page.locator('#remote-node-container-endpoint').fill('https://localhost:2375');
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
  }, { waitFor: '本机 Docker 2375 必须使用 HTTP。请将 https:// 改为 http:// 后保存。' }),
  ...[['registered', '环境已登记'], ['deploy-error', '部署失败'], ['api-error', '登记失败']].map(([state, title]) => scene(
    `registration-${state}`, `添加连接 · ${title}`, async (page) => {
      await registration(page);
      await page.getByRole('button', { name: '保存连接', exact: true }).click();
      if (state === 'deploy-error') {
        await page.getByText('环境已登记', { exact: true }).waitFor();
        await page.getByRole('button', { name: '立即部署', exact: true }).click();
      }
    }, { waitFor: state === 'registered' ? '环境已登记' : state === 'deploy-error' ? '部署失败。请检查环境配置后重试。' : '保存连接失败' },
  )),
  scene('registration-edit', '连接 · 编辑配置', async (page) => {
    await resourceTab(page, 'connections', '设计实验室 SSH');
    await page.getByRole('button', { name: '编辑连接', exact: true }).click();
  }, { waitFor: '启用连接' }),
  ...[['connection', 'connections', '待删除的独立连接', '删除连接'], ['environment', 'environments', '设计实验环境', '删除环境']].map(([kind, type, title, action]) => scene(
    `delete-${kind}-confirm`, `${kind === 'connection' ? '连接' : '环境'} · 删除确认`, async (page) => {
      await resourceTab(page, type, title);
      await page.getByRole('button', { name: '更多操作', exact: true }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
    }, { sources: [...SOURCES, 'src/components/ui/confirm-dialog.tsx'] },
  )),
  ...TYPES.filter(([type]) => type !== 'managedResources').map(([type, label, title]) => scene(
    `${type}-actions-menu`, `${label} · 更多操作菜单`, async (page) => {
      await resourceTab(page, type, title);
      await page.getByRole('button', { name: '更多操作', exact: true }).click();
    },
  )),
  ...[['node', '节点', 'nodes', '实验室 Linux 节点'], ['runtime', '运行时', 'runtimes', '研究运行时'], ['endpoint', '端点', 'endpoints', PRIMARY.endpointId]].map(([id, label, type, title]) => scene(
    `terminal-${id}-ready`, `终端 Drawer · ${label}就绪`, async (page) => openTerminal(page, type, title), { waitFor: '会话已连接', sources: [...SOURCES, 'src/plugins/fleet/components/RemoteFleetTerminalDrawer.tsx', 'src/plugins/fleet/components/useRemoteFleetTerminal.ts'] },
  )),
  scene('custom-terminal-ready', '终端 Drawer · 自定义端点能力就绪', async (page) => openTerminal(page, 'endpoints', 'design-custom-endpoint'), { waitFor: '会话已连接' }),
  ...[
    ['connecting', '连接中', '连接中'], ['open-error', '打开失败', '终端打开失败，请确认目标可用且已启用终端访问后重试。'],
    ['connection-error', '连接失败', '连接失败，请检查网络后重新连接。'], ['remote-error', '远端错误', '远端终端出现错误，请关闭终端或重新连接。'],
    ['exited', '正常退出', '终端已退出。代码：0 · 信号：none'], ['closed', '连接关闭', '已关闭'],
  ].map(([id, title, waitFor]) => scene(`terminal-${id}`, `终端 Drawer · ${title}`, async (page) => openTerminal(page), { waitFor })),
  scene('terminal-reconnect-error', '终端 Drawer · 重连失败', async (page) => {
    await openTerminal(page);
    await page.getByRole('dialog').getByText('就绪', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重连', exact: true }).click();
  }, { waitFor: '重新连接失败，请检查网络，或关闭终端后重新打开。' }),
];
