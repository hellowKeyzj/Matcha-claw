import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ConnectorFieldHint } from '@/types/desktop/app-plugin';
import type { ConnectorTransportFieldsProps } from './extensions';

export function ProcessFields({ form, editing, update }: ConnectorTransportFieldsProps) {
  return (
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
  );
}

export function McpStdioFields(props: ConnectorTransportFieldsProps) {
  return (
    <>
      <McpProgramField {...props} />
      <ProcessFields {...props} />
    </>
  );
}

export function McpHttpFields({ form, editing, update, mcpServerPrograms, fieldHints }: ConnectorTransportFieldsProps) {
  return (
    <>
      <McpProgramField form={form} editing={editing} update={update} mcpServerPrograms={mcpServerPrograms} />
      <div className="grid gap-4 md:grid-cols-[1fr_220px]">
        <div className="space-y-2">
          <Label htmlFor="connector-url">{fieldHints?.url?.label ?? 'MCP URL'}</Label>
          <Input id="connector-url" value={form.url} onChange={(event) => update('url', event.target.value)} placeholder={fieldHints?.url?.placeholder ?? 'https://mcp.example.com'} aria-describedby={fieldHints?.url?.description ? 'connector-url-description' : undefined} />
          {fieldHints?.url?.description && <p id="connector-url-description" className="text-xs text-muted-foreground">{fieldHints.url.description}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="connector-transport">{fieldHints?.transport?.label ?? 'Transport'}</Label>
          <Select id="connector-transport" value={form.transport} onChange={(event) => update('transport', event.target.value as 'streamable-http' | 'sse')} aria-describedby={fieldHints?.transport?.description ? 'connector-transport-description' : undefined}>
            <option value="streamable-http">streamable-http</option>
            <option value="sse">sse</option>
          </Select>
          {fieldHints?.transport?.description && <p id="connector-transport-description" className="text-xs text-muted-foreground">{fieldHints.transport.description}</p>}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="connector-auth">认证</Label>
        <Select id="connector-auth" value={form.auth} onChange={(event) => update('auth', event.target.value as '' | 'oauth')}>
          <option value="">无</option>
          <option value="oauth">OAuth 浏览器登录</option>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="connector-timeout">{fieldHints?.connectionTimeoutMs?.label ?? '连接超时 ms'}</Label>
        <Input id="connector-timeout" value={form.connectionTimeoutMs} onChange={(event) => update('connectionTimeoutMs', event.target.value)} placeholder={fieldHints?.connectionTimeoutMs?.placeholder ?? '可选，例如 10000'} aria-describedby={fieldHints?.connectionTimeoutMs?.description ? 'connector-timeout-description' : undefined} />
        {fieldHints?.connectionTimeoutMs?.description && <p id="connector-timeout-description" className="text-xs text-muted-foreground">{fieldHints.connectionTimeoutMs.description}</p>}
      </div>
      <MapFields form={form} editing={editing} update={update} publicKey="headers" secretKey="secretHeaders" publicLabel="headers" secretLabel="Secret header refs" publicHint={fieldHints?.headers} secretHint={fieldHints?.secretHeaders} />
      <HttpSecretWarning />
    </>
  );
}

export function HttpFields({ form, editing, update }: ConnectorTransportFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="connector-base-url">Base URL</Label>
        <Input id="connector-base-url" value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://api.example.com" />
      </div>
      <MapFields form={form} editing={editing} update={update} publicKey="headers" secretKey="secretHeaders" publicLabel="headers" secretLabel="Secret header refs" />
      <HttpSecretWarning />
    </>
  );
}

export function SdkFields({ form, editing, update }: ConnectorTransportFieldsProps) {
  return (
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
  );
}

function McpProgramField({ form, editing, update, mcpServerPrograms }: ConnectorTransportFieldsProps) {
  const matchingMcpPrograms = mcpServerPrograms.filter((program) => program.source !== 'system-runtime' && program.connectorKinds.includes(form.kind as 'mcp-stdio' | 'mcp-http'));
  const selectMcpServerProgram = (programId: string) => {
    const program = matchingMcpPrograms.find((item) => item.id === programId);
    update('mcpServerProgramId', programId);
    if (program?.transport) update('transport', program.transport);
  };
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <Label htmlFor="connector-mcp-program">MCP server 程序</Label>
      <Select id="connector-mcp-program" disabled={editing} value={form.mcpServerProgramId} onChange={(event) => selectMcpServerProgram(event.target.value)}>
        <option value="">外部自行管理</option>
        {matchingMcpPrograms.map((program) => (
          <option key={program.id} value={program.id}>{program.displayName} · {program.source}</option>
        ))}
      </Select>
    </div>
  );
}

function HttpSecretWarning() {
  return (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700">
      不要在headers 里填写 Authorization、token、apiKey 等密钥；请放到 Secret refs。
    </p>
  );
}

function MapFields({ form, editing, update, publicKey, secretKey, publicLabel, secretLabel, publicHint, secretHint }: Pick<ConnectorTransportFieldsProps, 'form' | 'editing' | 'update'> & {
  publicKey: 'env' | 'headers';
  secretKey: 'secretEnv' | 'secretHeaders';
  publicLabel: string;
  secretLabel: string;
  publicHint?: ConnectorFieldHint;
  secretHint?: ConnectorFieldHint;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`connector-${publicKey}`}>{publicHint?.label ?? publicLabel}</Label>
        <Textarea id={`connector-${publicKey}`} disabled={editing && !form.replaceFields.includes(publicKey)} value={form[publicKey]} onChange={(event) => update(publicKey, event.target.value)} placeholder={publicHint?.placeholder ?? 'KEY=value'} aria-describedby={publicHint?.description ? `connector-${publicKey}-description` : undefined} />
        {publicHint?.description && <p id={`connector-${publicKey}-description`} className="text-xs text-muted-foreground">{publicHint.description}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`connector-${secretKey}`}>{secretHint?.label ?? secretLabel}</Label>
        <Textarea id={`connector-${secretKey}`} value={form[secretKey]} onChange={(event) => update(secretKey, event.target.value)} placeholder={secretHint?.placeholder ?? 'AUTH_TOKEN=secret:token-name'} aria-describedby={secretHint?.description ? `connector-${secretKey}-description` : undefined} />
        {secretHint?.description && <p id={`connector-${secretKey}-description`} className="text-xs text-muted-foreground">{secretHint.description}</p>}
      </div>
    </div>
  );
}
