import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { AlertCircle, Cable, Loader2, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useExternalConnectorsStore, type ExternalConnectorConnectionStatus, type ExternalConnectorKind, type ExternalConnectorSecretRef, type ExternalConnectorSpec, type ExternalMcpServerProgramDescriptor } from '@/stores/external-connectors';
import { cn } from '@/lib/utils';

const CONNECTOR_KINDS: ExternalConnectorKind[] = ['mcp-stdio', 'mcp-http', 'cli', 'sdk', 'http'];
const PROCESS_KINDS = new Set<ExternalConnectorKind>(['mcp-stdio', 'cli']);
const HTTP_KINDS = new Set<ExternalConnectorKind>(['mcp-http', 'http']);

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

function serializeStringMap(value?: Record<string, string>): string {
  return value ? Object.entries(value).map(([key, itemValue]) => `${key}=${itemValue}`).join('\n') : '';
}

function serializeSecretRefMap(value?: Record<string, ExternalConnectorSecretRef>): string {
  return value ? Object.entries(value).map(([key, itemValue]) => `${key}=${itemValue.ref}`).join('\n') : '';
}

function formFromConnector(connector: ExternalConnectorSpec): ConnectorFormState {
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
      command: connector.command,
      args: connector.args?.join('\n') ?? '',
      cwd: connector.cwd ?? '',
      env: serializeStringMap(connector.env),
      secretEnv: serializeSecretRefMap(connector.secretEnv),
    };
  }
  if (connector.kind === 'mcp-http') {
    return {
      ...base,
      url: connector.url,
      transport: connector.transport ?? 'streamable-http',
      headers: serializeStringMap(connector.headers),
      secretHeaders: serializeSecretRefMap(connector.secretHeaders),
      connectionTimeoutMs: connector.connectionTimeoutMs ? String(connector.connectionTimeoutMs) : '',
    };
  }
  if (connector.kind === 'http') {
    return {
      ...base,
      baseUrl: connector.baseUrl,
      headers: serializeStringMap(connector.headers),
      secretHeaders: serializeSecretRefMap(connector.secretHeaders),
    };
  }
  if (connector.kind === 'sdk') {
    return {
      ...base,
      provider: connector.provider,
      packageName: connector.packageName ?? '',
      config: connector.config ? JSON.stringify(connector.config, null, 2) : '',
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

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function ConnectorKindBadge({ kind }: { kind: ExternalConnectorKind }) {
  const variant = kind.startsWith('mcp') ? 'default' : kind === 'sdk' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{kind}</Badge>;
}

function ConnectorProbeBadge({ status }: { status?: ExternalConnectorConnectionStatus }) {
  if (!status) {
    return <Badge variant="outline">未检测</Badge>;
  }
  if (status.resultType === 'connected') {
    return <Badge className="border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/10">探测可达</Badge>;
  }
  if (status.resultType === 'disconnected') {
    return <Badge variant="destructive">探测失败</Badge>;
  }
  if (status.resultType === 'disabled') {
    return <Badge variant="outline">未启用</Badge>;
  }
  if (status.resultType === 'unsupported') {
    return <Badge variant="outline">待会话验证</Badge>;
  }
  return <Badge variant="outline">未检测</Badge>;
}

function isManagedSystemRuntimeConnector(connector: ExternalConnectorSpec): boolean {
  return connector.mcpServerProgram?.source === 'system-runtime';
}

function ConnectorFields({ form, mcpServerPrograms, setForm }: {
  form: ConnectorFormState;
  mcpServerPrograms: readonly ExternalMcpServerProgramDescriptor[];
  setForm: (updater: (current: ConnectorFormState) => ConnectorFormState) => void;
}) {
  const update = <K extends keyof ConnectorFormState>(key: K, value: ConnectorFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const matchingMcpPrograms = mcpServerPrograms.filter((program) => program.connectorKinds.includes(form.kind as 'mcp-stdio' | 'mcp-http'));
  const selectMcpServerProgram = (programId: string) => {
    const program = matchingMcpPrograms.find((item) => item.id === programId);
    setForm((current) => ({
      ...current,
      mcpServerProgramId: programId,
      command: program?.command ?? current.command,
      args: program?.args?.join('\n') ?? current.args,
      url: program?.url ?? current.url,
      transport: program?.transport ?? current.transport,
    }));
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="connector-id">连接器 ID</Label>
          <Input id="connector-id" value={form.id} onChange={(event) => update('id', event.target.value)} placeholder="github-mcp" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="connector-kind">协议类型</Label>
          <Select id="connector-kind" value={form.kind} onChange={(event) => update('kind', event.target.value as ExternalConnectorKind)}>
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
          <Select id="connector-mcp-program" value={form.mcpServerProgramId} onChange={(event) => selectMcpServerProgram(event.target.value)}>
            <option value="">外部自行管理</option>
            {matchingMcpPrograms.map((program) => (
              <option key={program.id} value={program.id}>{program.displayName} · {program.source}</option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            参考 WorkBuddy 的分层：内置程序/插件有自己的目录和 manifest；connector 只绑定到其中一个 server 程序，或保留为外部命令/URL。
          </p>
        </div>
      )}

      {PROCESS_KINDS.has(form.kind) && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="connector-command">Command</Label>
              <Input id="connector-command" value={form.command} onChange={(event) => update('command', event.target.value)} placeholder="npx" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connector-cwd">cwd</Label>
              <Input id="connector-cwd" value={form.cwd} onChange={(event) => update('cwd', event.target.value)} placeholder="可选" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="connector-args">Args</Label>
            <Textarea id="connector-args" value={form.args} onChange={(event) => update('args', event.target.value)} placeholder={'每行一个参数\n-y\n@modelcontextprotocol/server-filesystem'} />
          </div>
          <MapFields form={form} update={update} publicKey="env" secretKey="secretEnv" publicLabel="公开 env" secretLabel="Secret env refs" />
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
          <MapFields form={form} update={update} publicKey="headers" secretKey="secretHeaders" publicLabel="公开 headers" secretLabel="Secret header refs" />
        </>
      )}

      {form.kind === 'http' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="connector-base-url">Base URL</Label>
            <Input id="connector-base-url" value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://api.example.com" />
          </div>
          <MapFields form={form} update={update} publicKey="headers" secretKey="secretHeaders" publicLabel="公开 headers" secretLabel="Secret header refs" />
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
            <Label htmlFor="connector-config">公开 config JSON</Label>
            <Textarea id="connector-config" value={form.config} onChange={(event) => update('config', event.target.value)} placeholder={'{\n  "apiVersion": "2025-01-01"\n}'} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="connector-secret-config">Secret config refs</Label>
            <Textarea id="connector-secret-config" value={form.secretConfigRefs} onChange={(event) => update('secretConfigRefs', event.target.value)} placeholder="apiKey=secret:stripe-api-key" />
          </div>
        </>
      )}

      {HTTP_KINDS.has(form.kind) && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700">
          不要在公开 headers 里填写 Authorization、token、apiKey 等密钥；请放到 Secret refs。
        </p>
      )}
    </div>
  );
}

function MapFields({ form, update, publicKey, secretKey, publicLabel, secretLabel }: {
  form: ConnectorFormState;
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
        <Textarea id={`connector-${publicKey}`} value={form[publicKey]} onChange={(event) => update(publicKey, event.target.value)} placeholder="KEY=value" />
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

          <ConnectorFields form={form} mcpServerPrograms={mcpServerPrograms} setForm={setForm} />

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
  const connectors = useExternalConnectorsStore((state) => state.connectors);
  const connectorStatuses = useExternalConnectorsStore((state) => state.connectorStatuses);
  const mcpServerPrograms = useExternalConnectorsStore((state) => state.mcpServerPrograms);
  const ready = useExternalConnectorsStore((state) => state.ready);
  const loading = useExternalConnectorsStore((state) => state.loading);
  const mutatingId = useExternalConnectorsStore((state) => state.mutatingId);
  const error = useExternalConnectorsStore((state) => state.error);
  const refresh = useExternalConnectorsStore((state) => state.refresh);
  const probe = useExternalConnectorsStore((state) => state.probe);
  const upsert = useExternalConnectorsStore((state) => state.upsert);
  const remove = useExternalConnectorsStore((state) => state.remove);
  const [form, setForm] = useState<ConnectorFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    void refresh().catch(() => {
      toast.error('加载连接器失败');
    });
  }, [refresh]);

  const sortedConnectors = useMemo(
    () => [...connectors].sort((a, b) => a.id.localeCompare(b.id)),
    [connectors],
  );

  const closeFormDialog = useCallback(() => {
    setFormDialogOpen(false);
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
  }, []);

  const openCreateDialog = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
    setFormDialogOpen(true);
  }, []);

  const submit = useCallback(async () => {
    try {
      setFormError(null);
      await upsert(buildConnector(form, mcpServerPrograms));
      toast.success(editingId ? '连接器已更新' : '连接器已创建');
      closeFormDialog();
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : '保存连接器失败';
      setFormError(message);
      toast.error(message);
    }
  }, [closeFormDialog, editingId, form, mcpServerPrograms, upsert]);

  const editConnector = useCallback((connector: ExternalConnectorSpec) => {
    setForm(formFromConnector(connector));
    setEditingId(connector.id);
    setFormError(null);
    setFormDialogOpen(true);
  }, []);

  const toggleEnabled = useCallback(async (connector: ExternalConnectorSpec, enabled: boolean) => {
    try {
      await upsert({ ...connector, enabled });
    } catch (toggleError) {
      toast.error(toggleError instanceof Error ? toggleError.message : '切换连接器失败');
    }
  }, [upsert]);

  const removeConnector = useCallback(async (connectorId: string) => {
    try {
      await remove(connectorId);
      if (editingId === connectorId) {
        closeFormDialog();
      }
      toast.success('连接器已删除');
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : '删除连接器失败');
    }
  }, [closeFormDialog, editingId, remove]);

  const probeConnector = useCallback(async (connectorId: string) => {
    try {
      await probe(connectorId);
    } catch (probeError) {
      toast.error(probeError instanceof Error ? probeError.message : '检测连接器失败');
    }
  }, [probe]);

  const saving = mutatingId === form.id;
  const showInitialLoading = !ready && loading;

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">连接器</h1>
          <p className="text-sm text-muted-foreground">管理 Matcha 外部能力连接。</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
          刷新
        </Button>
      </header>

      {error && (
        <p className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </p>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>连接器列表</CardTitle>
            <CardDescription>当前登记的多协议外部能力。</CardDescription>
          </div>
          <Button size="icon" aria-label="新增连接器" onClick={openCreateDialog}>
            <Plus className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {showInitialLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-20 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : sortedConnectors.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              <Cable className="mx-auto mb-3 h-8 w-8" />
              暂无连接器。点击右上角加号新增一个 MCP、CLI、SDK 或 HTTP connector。
            </div>
          ) : (
            <div className="space-y-2">
              {sortedConnectors.map((connector) => (
                <div key={connector.id} className="rounded-md border border-border/70 bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => editConnector(connector)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{connector.displayName || connector.id}</span>
                        <ConnectorKindBadge kind={connector.kind} />
                        {isManagedSystemRuntimeConnector(connector) && <Badge variant="outline">system-runtime</Badge>}
                        <Badge variant={connector.enabled === false ? 'outline' : 'secondary'}>{connector.enabled === false ? '禁用' : '启用'}</Badge>
                        <ConnectorProbeBadge status={connectorStatuses[connector.id]} />
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">{connector.id}</div>
                      {connector.description && <div className="mt-1 truncate text-xs text-muted-foreground">{connector.description}</div>}
                    </button>
                    <div className="flex items-center gap-2">
                      {mutatingId === connector.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      <Button variant="ghost" size="icon" disabled={mutatingId !== null} aria-label="检测连接器" onClick={() => void probeConnector(connector.id)}>
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <Switch checked={connector.enabled !== false} disabled={mutatingId !== null || isManagedSystemRuntimeConnector(connector)} onCheckedChange={(checked) => void toggleEnabled(connector, checked)} />
                      <Button variant="ghost" size="icon" disabled={mutatingId !== null || isManagedSystemRuntimeConnector(connector)} onClick={() => void removeConnector(connector.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
    </section>
  );
}

export default ExternalConnectorsPage;
