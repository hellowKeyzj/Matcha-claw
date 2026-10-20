import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertCircle, Cable, Loader2, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react';
import { AgentViewToggle } from '@/components/common/AgentViewToggle';
import { LoadingState } from '@/components/common/LoadingSpinner';
import { AgentPage, AgentPageSection, AgentPageToolbar, AgentResourceCard, AgentResourceFooter, AgentResourceGrid, AgentResourceIcon, AgentResourcePill } from '@/components/common/AgentPage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useExternalConnectorsStore, type ExternalConnectorConnectionStatus, type ExternalConnectorKind, type ExternalConnectorSecretRef, type ExternalConnectorSpec, type ExternalConnectorSummary, type ExternalConnectorPatch, type ExternalMcpServerProgramDescriptor, type OpenClawMcpServerSummary } from '@/stores/external-connectors';
import { cn } from '@/lib/utils';
import { selectManagementEndpoint, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { buildCapabilityScopeKey, runtimeInstanceScope, runtimeEndpointsEqual, type RuntimeInstanceScope } from '@/types/desktop/runtime-address';

const EMPTY_CONNECTORS: ExternalConnectorSummary[] = [];
const EMPTY_STATUSES: Record<string, ExternalConnectorConnectionStatus> = {};
const EMPTY_SERVERS: OpenClawMcpServerSummary[] = [];
const EMPTY_PROGRAMS: ExternalMcpServerProgramDescriptor[] = [];

const CONNECTOR_KINDS: ExternalConnectorKind[] = ['mcp-stdio', 'mcp-http', 'cli', 'sdk', 'http'];
const PROCESS_KINDS = new Set<ExternalConnectorKind>(['mcp-stdio', 'cli']);
const HTTP_KINDS = new Set<ExternalConnectorKind>(['mcp-http', 'http']);

type PrivateField = 'command' | 'args' | 'cwd' | 'env' | 'headers' | 'config';

type ConnectorFormState = {
  id: string;
  kind: ExternalConnectorKind;
  enabled: boolean;
  displayName: string;
  description: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  secretEnv: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  baseUrl: string;
  headers: string;
  secretHeaders: string;
  connectionTimeoutMs: string;
  provider: string;
  packageName: string;
  config: string;
  secretConfigRefs: string;
  mcpServerProgramId: string;
  replaceFields: PrivateField[];
};

const EMPTY_FORM: ConnectorFormState = {
  id: '',
  kind: 'mcp-stdio',
  enabled: true,
  displayName: '',
  description: '',
  command: '',
  args: '',
  cwd: '',
  env: '',
  secretEnv: '',
  url: '',
  transport: 'streamable-http',
  baseUrl: '',
  headers: '',
  secretHeaders: '',
  connectionTimeoutMs: '',
  provider: '',
  packageName: '',
  config: '',
  secretConfigRefs: '',
  mcpServerProgramId: '',
  replaceFields: [],
};

function parseStringMap(value: string, fieldName: string): Record<string, string> | undefined {
  const entries = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`${fieldName} 每行必须是 KEY=value`);
    }
    const key = entry.slice(0, separatorIndex).trim();
    const itemValue = entry.slice(separatorIndex + 1).trim();
    if (!key) {
      throw new Error(`${fieldName} key 不能为空`);
    }
    result[key] = itemValue;
  }
  return result;
}

function parseSecretRefMap(value: string, fieldName: string): Record<string, ExternalConnectorSecretRef> | undefined {
  const entries = parseStringMap(value, fieldName);
  if (!entries) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(entries).map(([key, ref]) => [key, { kind: 'secret-ref', ref }]));
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SDK config 必须是 JSON object');
  }
  return parsed as Record<string, unknown>;
}

function splitArgs(value: string): string[] | undefined {
  const args = value.split('\n').map((line) => line.trim()).filter(Boolean);
  return args.length > 0 ? args : undefined;
}

function serializeSecretRefMap(value?: Record<string, ExternalConnectorSecretRef>): string {
  return value ? Object.entries(value).map(([key, itemValue]) => `${key}=${itemValue.ref}`).join('\n') : '';
}

function formFromConnector(connector: ExternalConnectorSummary): ConnectorFormState {
  const base = {
    ...EMPTY_FORM,
    id: connector.id,
    kind: connector.kind,
    enabled: connector.enabled !== false,
    displayName: connector.displayName ?? '',
    description: connector.description ?? '',
    mcpServerProgramId: connector.mcpServerProgram?.programId ?? '',
  };
  if (connector.kind === 'mcp-stdio' || connector.kind === 'cli') {
    return {
      ...base,
      secretEnv: serializeSecretRefMap(connector.secretEnv),
    };
  }
  if (connector.kind === 'mcp-http') {
    return {
      ...base,
      url: connector.url,
      transport: connector.transport ?? 'streamable-http',
      secretHeaders: serializeSecretRefMap(connector.secretHeaders),
      connectionTimeoutMs: connector.connectionTimeoutMs ? String(connector.connectionTimeoutMs) : '',
    };
  }
  if (connector.kind === 'http') {
    return {
      ...base,
      baseUrl: connector.baseUrl,
      secretHeaders: serializeSecretRefMap(connector.secretHeaders),
    };
  }
  if (connector.kind === 'sdk') {
    return {
      ...base,
      provider: connector.provider,
      packageName: connector.packageName ?? '',
      secretConfigRefs: serializeSecretRefMap(connector.secretConfigRefs),
    };
  }
  return base;
}

function buildConnector(form: ConnectorFormState, mcpServerPrograms: readonly ExternalMcpServerProgramDescriptor[]): ExternalConnectorSpec {
  const selectedProgram = form.kind === 'mcp-stdio' || form.kind === 'mcp-http'
    ? mcpServerPrograms.find((program) => program.id === form.mcpServerProgramId && program.connectorKinds.includes(form.kind as 'mcp-stdio' | 'mcp-http'))
    : undefined;
  const base = {
    id: form.id.trim(),
    kind: form.kind,
    enabled: form.enabled,
    displayName: form.displayName.trim() || undefined,
    description: form.description.trim() || undefined,
    mcpServerProgram: selectedProgram ? { source: selectedProgram.source, programId: selectedProgram.id } : undefined,
  };

  if (form.kind === 'mcp-stdio' || form.kind === 'cli') {
    return withoutUndefined({
      ...base,
      command: form.command.trim(),
      args: splitArgs(form.args),
      cwd: form.cwd.trim() || undefined,
      env: parseStringMap(form.env, 'env'),
      secretEnv: parseSecretRefMap(form.secretEnv, 'secretEnv'),
    }) as ExternalConnectorSpec;
  }

  if (form.kind === 'mcp-http') {
    const timeoutText = form.connectionTimeoutMs.trim();
    return withoutUndefined({
      ...base,
      url: form.url.trim(),
      transport: form.transport,
      headers: parseStringMap(form.headers, 'headers'),
      secretHeaders: parseSecretRefMap(form.secretHeaders, 'secretHeaders'),
      connectionTimeoutMs: timeoutText ? Number(timeoutText) : undefined,
    }) as ExternalConnectorSpec;
  }

  if (form.kind === 'http') {
    return withoutUndefined({
      ...base,
      baseUrl: form.baseUrl.trim(),
      headers: parseStringMap(form.headers, 'headers'),
      secretHeaders: parseSecretRefMap(form.secretHeaders, 'secretHeaders'),
    }) as ExternalConnectorSpec;
  }

  return withoutUndefined({
    ...base,
    provider: form.provider.trim(),
    packageName: form.packageName.trim() || undefined,
    config: parseJsonObject(form.config),
    secretConfigRefs: parseSecretRefMap(form.secretConfigRefs, 'secretConfigRefs'),
  }) as ExternalConnectorSpec;
}

function buildPatch(form: ConnectorFormState, connector: ExternalConnectorSummary): ExternalConnectorPatch {
  const original = formFromConnector(connector);
  const changed = (field: keyof ConnectorFormState) => form[field] !== original[field];
  const common = {
    ...(changed('displayName') ? { displayName: form.displayName.trim() || null } : {}),
    ...(changed('description') ? { description: form.description.trim() || null } : {}),
    ...(changed('enabled') ? { enabled: form.enabled } : {}),
  };
  const replace = (field: PrivateField) => form.replaceFields.includes(field);
  if (form.kind === 'mcp-stdio' || form.kind === 'cli') {
    return {
      ...common,
      ...(replace('command') ? { command: form.command.trim() } : {}),
      ...(replace('args') ? { args: splitArgs(form.args) ?? null } : {}),
      ...(replace('cwd') ? { cwd: form.cwd.trim() || null } : {}),
      ...(replace('env') ? { env: parseStringMap(form.env, 'env') ?? null } : {}),
      ...(changed('secretEnv') ? { secretEnv: parseSecretRefMap(form.secretEnv, 'secretEnv') ?? null } : {}),
    };
  }
  if (form.kind === 'mcp-http') {
    return {
      ...common,
      ...(changed('url') ? { url: form.url.trim() } : {}),
      ...(changed('transport') ? { transport: form.transport } : {}),
      ...(changed('connectionTimeoutMs') ? { connectionTimeoutMs: form.connectionTimeoutMs.trim() ? Number(form.connectionTimeoutMs) : null } : {}),
      ...(replace('headers') ? { headers: parseStringMap(form.headers, 'headers') ?? null } : {}),
      ...(changed('secretHeaders') ? { secretHeaders: parseSecretRefMap(form.secretHeaders, 'secretHeaders') ?? null } : {}),
    };
  }
  if (form.kind === 'http') {
    return {
      ...common,
      ...(changed('baseUrl') ? { baseUrl: form.baseUrl.trim() } : {}),
      ...(replace('headers') ? { headers: parseStringMap(form.headers, 'headers') ?? null } : {}),
      ...(changed('secretHeaders') ? { secretHeaders: parseSecretRefMap(form.secretHeaders, 'secretHeaders') ?? null } : {}),
    };
  }
  return {
    ...common,
    ...(changed('provider') ? { provider: form.provider.trim() } : {}),
    ...(changed('packageName') ? { packageName: form.packageName.trim() || null } : {}),
    ...(replace('config') ? { config: parseJsonObject(form.config) ?? null } : {}),
    ...(changed('secretConfigRefs') ? { secretConfigRefs: parseSecretRefMap(form.secretConfigRefs, 'secretConfigRefs') ?? null } : {}),
  };
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

type ConnectorListEntry = {
  key: string;
  id: string;
  displayName: string;
  description?: string;
  kind: ExternalConnectorKind | 'unknown';
  source: OpenClawMcpServerSummary['source'];
  enabled: boolean;
  editable: boolean;
  removable: boolean;
  connector?: ExternalConnectorSummary;
};

function ConnectorKindBadge({ kind }: { kind: ExternalConnectorKind | OpenClawMcpServerSummary['kind'] }) {
  return <AgentResourcePill>{kind}</AgentResourcePill>;
}

function ConnectorProbeBadge({ status }: { status?: ExternalConnectorConnectionStatus }) {
  if (!status) {
    return <AgentResourcePill>未检测</AgentResourcePill>;
  }
  if (status.resultType === 'connected') {
    return <AgentResourcePill className="bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300">探测可达</AgentResourcePill>;
  }
  if (status.resultType === 'disconnected') {
    return <AgentResourcePill className="bg-destructive/10 text-destructive ring-destructive/25">探测失败</AgentResourcePill>;
  }
  if (status.resultType === 'disabled') {
    return <AgentResourcePill>未启用</AgentResourcePill>;
  }
  if (status.resultType === 'unsupported') {
    return <AgentResourcePill>待会话验证</AgentResourcePill>;
  }
  return <AgentResourcePill>未检测</AgentResourcePill>;
}

function mcpServerSourceLabel(source: OpenClawMcpServerSummary['source'], scope: RuntimeInstanceScope): string {
  if (source === 'preset') return '预置';
  if (source === 'openclaw') return scope.endpoint.kind === 'native-runtime' && scope.endpoint.runtimeAdapterId === 'matcha-agent' ? 'Matcha 原生' : 'OpenClaw';
  return '我的';
}

function ConnectorFields({ form, editing, mcpServerPrograms, setForm }: {
  form: ConnectorFormState;
  editing: boolean;
  mcpServerPrograms: readonly ExternalMcpServerProgramDescriptor[];
  setForm: (updater: (current: ConnectorFormState) => ConnectorFormState) => void;
}) {
  const update = <K extends keyof ConnectorFormState>(key: K, value: ConnectorFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const privateFields: PrivateField[] = PROCESS_KINDS.has(form.kind) ? ['command', 'args', 'cwd', 'env']
    : HTTP_KINDS.has(form.kind) ? ['headers'] : ['config'];
  const matchingMcpPrograms = mcpServerPrograms.filter((program) => program.source !== 'system-runtime' && program.connectorKinds.includes(form.kind as 'mcp-stdio' | 'mcp-http'));
  const selectMcpServerProgram = (programId: string) => {
    const program = matchingMcpPrograms.find((item) => item.id === programId);
    setForm((current) => ({
      ...current,
      mcpServerProgramId: programId,
      transport: program?.transport ?? current.transport,
    }));
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="connector-id">连接器 ID</Label>
          <Input id="connector-id" disabled={editing} value={form.id} onChange={(event) => update('id', event.target.value)} placeholder="github-mcp" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="connector-kind">协议类型</Label>
          <Select id="connector-kind" disabled={editing} value={form.kind} onChange={(event) => update('kind', event.target.value as ExternalConnectorKind)}>
            {CONNECTOR_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </Select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="connector-name">显示名</Label>
          <Input id="connector-name" value={form.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder="GitHub MCP" />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
          <div>
            <Label>启用</Label>
            <p className="text-xs text-muted-foreground">禁用后 Matcha 不会向运行时暴露这个外部能力。</p>
          </div>
          <Switch checked={form.enabled} onCheckedChange={(checked) => update('enabled', checked)} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="connector-description">描述</Label>
        <Input id="connector-description" value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="这个连接器提供什么外部能力" />
      </div>

      {(form.kind === 'mcp-stdio' || form.kind === 'mcp-http') && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Label htmlFor="connector-mcp-program">MCP server 程序</Label>
          <Select id="connector-mcp-program" disabled={editing} value={form.mcpServerProgramId} onChange={(event) => selectMcpServerProgram(event.target.value)}>
            <option value="">外部自行管理</option>
            {matchingMcpPrograms.map((program) => (
              <option key={program.id} value={program.id}>{program.displayName} · {program.source}</option>
            ))}
          </Select>
        </div>
      )}

      {editing && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">私有执行配置不回读，默认保留；仅开启的字段会替换。可选字段留空表示清除，Command 不可清空。</p>
          <div className="flex flex-wrap gap-4">
            {privateFields.map((field) => (
              <label key={field} className="flex items-center gap-2 text-sm">
                <Switch checked={form.replaceFields.includes(field)} onCheckedChange={(checked) => update('replaceFields', checked ? [...form.replaceFields, field] : form.replaceFields.filter((item) => item !== field))} />
                替换 {field}
              </label>
            ))}
          </div>
        </div>
      )}

      {PROCESS_KINDS.has(form.kind) && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="connector-command">Command</Label>
              <Input id="connector-command" disabled={editing && !form.replaceFields.includes('command')} value={form.command} onChange={(event) => update('command', event.target.value)} placeholder="npx" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connector-cwd">cwd</Label>
              <Input id="connector-cwd" disabled={editing && !form.replaceFields.includes('cwd')} value={form.cwd} onChange={(event) => update('cwd', event.target.value)} placeholder="可选" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="connector-args">Args</Label>
            <Textarea id="connector-args" disabled={editing && !form.replaceFields.includes('args')} value={form.args} onChange={(event) => update('args', event.target.value)} placeholder={'每行一个参数\n-y\n@modelcontextprotocol/server-filesystem'} />
          </div>
          <MapFields form={form} editing={editing} update={update} publicKey="env" secretKey="secretEnv" publicLabel="env" secretLabel="Secret env refs" />
        </>
      )}

      {form.kind === 'mcp-http' && (
        <>
          <div className="grid gap-4 md:grid-cols-[1fr_220px]">
            <div className="space-y-2">
              <Label htmlFor="connector-url">MCP URL</Label>
              <Input id="connector-url" value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="https://mcp.example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connector-transport">Transport</Label>
              <Select id="connector-transport" value={form.transport} onChange={(event) => update('transport', event.target.value as 'streamable-http' | 'sse')}>
                <option value="streamable-http">streamable-http</option>
                <option value="sse">sse</option>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="connector-timeout">连接超时 ms</Label>
            <Input id="connector-timeout" value={form.connectionTimeoutMs} onChange={(event) => update('connectionTimeoutMs', event.target.value)} placeholder="可选，例如 10000" />
          </div>
          <MapFields form={form} editing={editing} update={update} publicKey="headers" secretKey="secretHeaders" publicLabel="headers" secretLabel="Secret header refs" />
        </>
      )}

      {form.kind === 'http' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="connector-base-url">Base URL</Label>
            <Input id="connector-base-url" value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://api.example.com" />
          </div>
          <MapFields form={form} editing={editing} update={update} publicKey="headers" secretKey="secretHeaders" publicLabel="headers" secretLabel="Secret header refs" />
        </>
      )}

      {form.kind === 'sdk' && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="connector-provider">Provider</Label>
              <Input id="connector-provider" value={form.provider} onChange={(event) => update('provider', event.target.value)} placeholder="stripe" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connector-package">Package</Label>
              <Input id="connector-package" value={form.packageName} onChange={(event) => update('packageName', event.target.value)} placeholder="stripe" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="connector-config">config JSON</Label>
            <Textarea id="connector-config" disabled={editing && !form.replaceFields.includes('config')} value={form.config} onChange={(event) => update('config', event.target.value)} placeholder={'{\n  "apiVersion": "2025-01-01"\n}'} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="connector-secret-config">Secret config refs</Label>
            <Textarea id="connector-secret-config" value={form.secretConfigRefs} onChange={(event) => update('secretConfigRefs', event.target.value)} placeholder="apiKey=secret:stripe-api-key" />
          </div>
        </>
      )}

      {HTTP_KINDS.has(form.kind) && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700">
          不要在headers 里填写 Authorization、token、apiKey 等密钥；请放到 Secret refs。
        </p>
      )}
    </div>
  );
}

function MapFields({ form, editing, update, publicKey, secretKey, publicLabel, secretLabel }: {
  form: ConnectorFormState;
  editing: boolean;
  update: <K extends keyof ConnectorFormState>(key: K, value: ConnectorFormState[K]) => void;
  publicKey: 'env' | 'headers';
  secretKey: 'secretEnv' | 'secretHeaders';
  publicLabel: string;
  secretLabel: string;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`connector-${publicKey}`}>{publicLabel}</Label>
        <Textarea id={`connector-${publicKey}`} disabled={editing && !form.replaceFields.includes(publicKey)} value={form[publicKey]} onChange={(event) => update(publicKey, event.target.value)} placeholder="KEY=value" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`connector-${secretKey}`}>{secretLabel}</Label>
        <Textarea id={`connector-${secretKey}`} value={form[secretKey]} onChange={(event) => update(secretKey, event.target.value)} placeholder="AUTH_TOKEN=secret:token-name" />
      </div>
    </div>
  );
}

function ConnectorFormDialog({
  editingId,
  form,
  formError,
  saving,
  mutating,
  mcpServerPrograms,
  setForm,
  onClose,
  onSubmit,
}: {
  editingId: string | null;
  form: ConnectorFormState;
  formError: string | null;
  saving: boolean;
  mutating: boolean;
  mcpServerPrograms: readonly ExternalMcpServerProgramDescriptor[];
  setForm: (updater: (current: ConnectorFormState) => ConnectorFormState) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={editingId ? '编辑连接器' : '新增连接器'}
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-xl border bg-background p-6 shadow-xl"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{editingId ? '编辑连接器' : '新增连接器'}</h2>
            <p className="mt-1 text-sm text-muted-foreground">公共配置不要填写密钥；密钥只填 secret-ref。</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="关闭连接器配置" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="mt-5 space-y-4">
          {formError ? (
            <p className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {formError}
            </p>
          ) : null}

          <ConnectorFields form={form} editing={editingId !== null} mcpServerPrograms={mcpServerPrograms} setForm={setForm} />

          <div className="border-t border-border" />

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={onSubmit} disabled={saving || mutating}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {editingId ? '保存修改' : '创建连接器'}
            </Button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function ExternalConnectorsPage() {
  const endpoint = useRuntimeEndpointsStore(selectManagementEndpoint);
  const scope = useMemo(() => endpoint?.kind === 'native-runtime' && ['openclaw', 'matcha-agent'].includes(endpoint.runtimeAdapterId) ? runtimeInstanceScope(endpoint) : null, [endpoint]);
  useEffect(() => { useExternalConnectorsStore.getState().selectScope(scope); }, [scope]);
  if (!scope) return <AgentPage><p className="text-sm text-muted-foreground">请选择运行时。</p></AgentPage>;
  return <ExternalConnectorsForRuntime key={buildCapabilityScopeKey(scope)} scope={scope} />;
}

function ExternalConnectorsForRuntime({ scope }: { scope: RuntimeInstanceScope }) {
  const active = useRef(true);
  const sequence = useRef(0);
  const current = useCallback((request: number) => {
    const endpoint = selectManagementEndpoint(useRuntimeEndpointsStore.getState());
    return active.current && request === sequence.current && endpoint !== null && runtimeEndpointsEqual(endpoint, scope.endpoint);
  }, [scope]);
  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current += 1; }; }, []);
  const storeScope = useExternalConnectorsStore((state) => state.scope);
  const scopeMatches = storeScope && buildCapabilityScopeKey(storeScope) === buildCapabilityScopeKey(scope);
  const connectors = useExternalConnectorsStore((state) => scopeMatches ? state.connectors : EMPTY_CONNECTORS);
  const connectorStatuses = useExternalConnectorsStore((state) => scopeMatches ? state.connectorStatuses : EMPTY_STATUSES);
  const mcpServers = useExternalConnectorsStore((state) => scopeMatches ? state.mcpServers : EMPTY_SERVERS);
  const mcpServerPrograms = useExternalConnectorsStore((state) => scopeMatches ? state.mcpServerPrograms : EMPTY_PROGRAMS);
  const ready = useExternalConnectorsStore((state) => Boolean(scopeMatches && state.ready));
  const loading = useExternalConnectorsStore((state) => Boolean(scopeMatches && state.loading));
  const mutatingId = useExternalConnectorsStore((state) => state.mutatingId);
  const error = useExternalConnectorsStore((state) => scopeMatches ? state.error : null);
  const refresh = useExternalConnectorsStore((state) => state.refresh);
  const probe = useExternalConnectorsStore((state) => state.probe);
  const upsert = useExternalConnectorsStore((state) => state.upsert);
  const updateConnector = useExternalConnectorsStore((state) => state.update);
  const remove = useExternalConnectorsStore((state) => state.remove);
  const [form, setForm] = useState<ConnectorFormState>(EMPTY_FORM);
  const [editingConnector, setEditingConnector] = useState<ExternalConnectorSummary | null>(null);
  const editingId = editingConnector?.id ?? null;
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const kindFilter = searchParams.get('kind') ?? 'all';
  const statusFilter = searchParams.get('status') ?? 'all';
  const view = searchParams.get('view') === 'list' ? 'list' : 'grid';
  const updateFilter = (key: string, value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === '' || (key !== 'q' && value === 'all') || (key === 'view' && value === 'grid')) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  };

  useEffect(() => {
    useExternalConnectorsStore.getState().selectScope(scope);
    const request = sequence.current;
    void refresh().catch(() => {
      if (!current(request)) return;
      toast.error('加载连接器失败');
    });
  }, [refresh, scope, current]);

  const entries = useMemo(() => {
    const connectorById = new Map(connectors.map((connector) => [connector.id, connector]));
    const nativeConnectorIds = new Set(mcpServers.flatMap((server) => server.connectorId ? [server.connectorId] : []));
    const native: ConnectorListEntry[] = mcpServers.map((server) => {
      const connector = server.connectorId ? connectorById.get(server.connectorId) : undefined;
      return {
        key: `native:${server.serverId}`,
        id: server.serverId,
        displayName: connector?.displayName ?? server.displayName,
        description: connector?.description ?? server.description,
        kind: server.kind,
        source: server.source,
        enabled: connector ? connector.enabled !== false : server.enabled,
        editable: server.source === 'external' && server.editable,
        removable: server.source === 'external' && server.removable,
        connector,
      };
    });
    return [...native, ...connectors.filter((connector) => !nativeConnectorIds.has(connector.id)).map((connector): ConnectorListEntry => ({
      key: `connector:${connector.id}`,
      id: connector.id,
      displayName: connector.displayName ?? connector.id,
      description: connector.description,
      kind: connector.kind,
      source: 'external',
      enabled: connector.enabled !== false,
      editable: true,
      removable: true,
      connector,
    }))];
  }, [connectors, mcpServers]);
  const visibleEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return entries.filter((entry) => (
      (kindFilter === 'all' || entry.kind === kindFilter)
      && (statusFilter === 'all' || entry.enabled === (statusFilter === 'enabled'))
      && (!query || [entry.displayName, entry.id, entry.connector?.id, entry.description, entry.kind]
        .some((value) => value?.toLocaleLowerCase().includes(query)))
    )).sort((a, b) => a.id.localeCompare(b.id));
  }, [entries, kindFilter, search, statusFilter]);

  const closeFormDialog = useCallback(() => {
    setFormDialogOpen(false);
    setForm(EMPTY_FORM);
    setEditingConnector(null);
    setFormError(null);
  }, []);

  const openCreateDialog = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditingConnector(null);
    setFormError(null);
    setFormDialogOpen(true);
  }, []);

  const submit = useCallback(async () => {
    const request = ++sequence.current;
    try {
      setFormError(null);
      const result = editingConnector
        ? await updateConnector(editingConnector.id, buildPatch(form, editingConnector))
        : await upsert(buildConnector(form, mcpServerPrograms));
      if (!current(request)) return;
      if (result.applied.status !== 'written') toast.warning('配置已保存，原生投影未确认；不会视为已连接。');
      else toast.success('配置已保存；新原生会话启动时使用，不代表已连接。');
      closeFormDialog();
    } catch (submitError) {
      if (!current(request)) return;
      const message = submitError instanceof Error ? submitError.message : '保存连接器失败';
      setFormError(message);
      toast.error(message);
    }
  }, [closeFormDialog, editingConnector, form, mcpServerPrograms, updateConnector, upsert, current]);

  const editConnector = useCallback((connector: ExternalConnectorSummary) => {
    setForm(formFromConnector(connector));
    setEditingConnector(connector);
    setFormError(null);
    setFormDialogOpen(true);
  }, []);

  const toggleEnabled = useCallback(async (connector: ExternalConnectorSummary, enabled: boolean) => {
    const request = ++sequence.current;
    try {
      const result = await updateConnector(connector.id, { enabled });
      if (current(request) && result.applied.status !== 'written') toast.warning('配置已保存，原生投影未确认；不会视为已连接。');
    } catch (toggleError) {
      if (!current(request)) return;
      toast.error(toggleError instanceof Error ? toggleError.message : '切换连接器失败');
    }
  }, [updateConnector, current]);

  const removeConnector = useCallback(async (connectorId: string) => {
    const request = ++sequence.current;
    try {
      const result = await remove(connectorId);
      if (!current(request)) return;
      if (editingId === connectorId) {
        closeFormDialog();
      }
      if (result.applied.status !== 'written') toast.warning('连接器已删除，原生投影未确认；不代表原生会话已断开。');
      else toast.success('连接器已删除');
    } catch (deleteError) {
      if (!current(request)) return;
      toast.error(deleteError instanceof Error ? deleteError.message : '删除连接器失败');
    }
  }, [closeFormDialog, editingId, remove, current]);

  const probeConnector = useCallback(async (connectorId: string) => {
    const request = ++sequence.current;
    try {
      await probe(connectorId);
    } catch (probeError) {
      if (!current(request)) return;
      toast.error(probeError instanceof Error ? probeError.message : '检测连接器失败');
    }
  }, [probe, current]);

  const saving = mutatingId === form.id;
  const showInitialLoading = !scopeMatches || (!ready && (loading || !error));

  return (
    <AgentPage>
      <AgentPageSection actions={(
        <>
          <Button variant="outline" size="icon" className="size-9 rounded-full" aria-label="刷新连接器" onClick={() => void refresh().catch(() => undefined)} disabled={loading}>
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
          <Button size="sm" className="h-9 rounded-full" onClick={openCreateDialog}>
            <Plus className="mr-2 size-4" />新增连接器
          </Button>
        </>
      )}>
        <h2 className="flex min-h-12 items-center gap-2 border-b-2 border-foreground pb-3 text-sm font-medium">
          我的连接器
          {ready && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{entries.length}</Badge>}
        </h2>
      </AgentPageSection>

      <AgentPageToolbar>
        <div className="relative w-full sm:w-[300px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input className="h-10 pl-9 text-sm" aria-label="搜索连接器" placeholder="搜索连接器…" value={search} onChange={(event) => updateFilter('q', event.target.value)} />
        </div>
        <Select className="h-10 w-auto min-w-28 text-sm" aria-label="协议类型" value={kindFilter} onChange={(event) => updateFilter('kind', event.target.value)}>
          <option value="all">全部协议</option>
          {CONNECTOR_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </Select>
        <Select className="h-10 w-auto min-w-28 text-sm" aria-label="启用状态" value={statusFilter} onChange={(event) => updateFilter('status', event.target.value)}>
          <option value="all">全部状态</option>
          <option value="enabled">已启用</option>
          <option value="disabled">未启用</option>
        </Select>
        <div className="ml-auto flex items-center gap-3">
          {ready && <span className="text-xs text-muted-foreground">{visibleEntries.length} 个连接器</span>}
          <AgentViewToggle value={view} onChange={(value) => updateFilter('view', value)} gridLabel="网格视图" listLabel="列表视图" />
        </div>
      </AgentPageToolbar>

      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </p>
      )}

      {showInitialLoading ? (
        <LoadingState label="正在加载连接器…" />
      ) : !ready ? null : visibleEntries.length === 0 ? (
        <div className="flex min-h-[430px] flex-col items-center justify-center gap-5 rounded-[1.75rem] border border-border/70 bg-card p-8 text-center shadow-none">
          <AgentResourceIcon className="size-16 rounded-[1.25rem]"><Cable className="size-7" /></AgentResourceIcon>
          <p className="max-w-md text-sm text-muted-foreground">{entries.length === 0 ? '添加连接器，让 Agent 访问外部服务、数据与工具。' : '没有符合筛选条件的连接器。'}</p>
          {entries.length === 0 && (
            <>
              <Button size="sm" className="h-9 rounded-full" onClick={openCreateDialog}><Plus className="mr-2 size-4" />新增连接器</Button>
              <div className="flex flex-wrap justify-center gap-2">
                {['MCP', 'HTTP', 'CLI', 'SDK'].map((protocol) => <AgentResourcePill key={protocol}>{protocol}</AgentResourcePill>)}
              </div>
            </>
          )}
        </div>
      ) : (
        <AgentResourceGrid className={cn(view === 'list' && 'md:grid-cols-1 lg:grid-cols-1 xl:grid-cols-1 2xl:grid-cols-1')}>
          {visibleEntries.map((entry) => {
            const connector = entry.connector;
            const connectorId = connector?.id;
            const canEdit = entry.editable && connector;
            const canRemove = entry.removable && connector;
            const canProbe = entry.source === 'external' && connectorId;
            const canToggle = entry.editable && connector;
            const name = entry.displayName || entry.id;
            return (
              <AgentResourceCard key={entry.key} className={cn('gap-3 p-4', view === 'grid' ? 'min-h-56' : 'md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-center')}>
                <div className="flex min-w-0 items-center gap-3">
                  <AgentResourceIcon><Cable className="size-5" /></AgentResourceIcon>
                  {canEdit ? (
                    <button type="button" className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => editConnector(connector)} aria-label={`编辑 ${name}`}>
                      <h3 className="truncate text-sm font-semibold" title={name}>{name}</h3>
                      <p className="mt-1 truncate text-xs text-muted-foreground" title={entry.id}>{entry.id}</p>
                    </button>
                  ) : (
                    <div className="min-w-0 text-left">
                      <h3 className="truncate text-sm font-semibold" title={name}>{name}</h3>
                      <p className="mt-1 truncate text-xs text-muted-foreground" title={entry.id}>{entry.id}</p>
                    </div>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  {entry.description && <p className="line-clamp-2 text-sm text-muted-foreground" title={entry.description}>{entry.description}</p>}
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    <ConnectorKindBadge kind={entry.kind} />
                    <AgentResourcePill>{mcpServerSourceLabel(entry.source, scope)}</AgentResourcePill>
                    {connectorId && <ConnectorProbeBadge status={connectorStatuses[connectorId]} />}
                  </div>
                </div>
                <AgentResourceFooter className={cn(view === 'list' && 'md:mt-0 md:shrink-0')}>
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    <span className={cn('size-1.5 rounded-full', entry.enabled ? 'bg-emerald-500' : 'bg-muted-foreground')} />
                    {entry.enabled ? '已启用' : '未启用'}
                  </span>
                  <div className="flex items-center gap-1">
                    {connectorId && mutatingId === connectorId && <Loader2 className="size-3.5 animate-spin" />}
                    <Button variant="ghost" size="icon" className="size-7" disabled={!canEdit} aria-label={`编辑 ${name}`} onClick={() => canEdit && editConnector(connector)}><Pencil className="size-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="size-7" disabled={mutatingId !== null || !canProbe} aria-label={`检测 ${name}`} onClick={() => connectorId && void probeConnector(connectorId)}><RefreshCw className="size-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="size-7" disabled={mutatingId !== null || !canRemove} aria-label={`删除 ${name}`} onClick={() => connectorId && void removeConnector(connectorId)}><Trash2 className="size-3.5" /></Button>
                    <Switch className="ml-1" aria-label={`启用 ${name}`} checked={entry.enabled} disabled={mutatingId !== null || !canToggle} onCheckedChange={(checked) => connector && void toggleEnabled(connector, checked)} />
                  </div>
                </AgentResourceFooter>
              </AgentResourceCard>
            );
          })}
        </AgentResourceGrid>
      )}

      {formDialogOpen ? (
        <ConnectorFormDialog
          editingId={editingId}
          form={form}
          formError={formError}
          saving={saving}
          mutating={mutatingId !== null}
          mcpServerPrograms={mcpServerPrograms}
          setForm={setForm}
          onClose={closeFormDialog}
          onSubmit={() => void submit()}
        />
      ) : null}
    </AgentPage>
  );
}

export default ExternalConnectorsPage;
