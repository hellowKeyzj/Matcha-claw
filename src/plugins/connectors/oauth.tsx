import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { invokeIpc } from '@/lib/api-client';
import { requestConnectorOAuth } from '@/lib/connectors-call';
import { selectManagementEndpoint, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { runtimeEndpointsEqual, type RuntimeInstanceScope } from '@/types/desktop/runtime-address';
import type { McpOAuthAction, McpOAuthReceipt, McpOAuthState } from '@/types/connectors-oauth';
import type { ExternalConnectorSummary } from './store';

const STATUS_LABELS: Record<McpOAuthState, string> = {
  'authorization-required': '需要授权，请点击登录。',
  authorizing: '正在授权，请在浏览器中完成登录后刷新状态。',
  authorized: '已授权，不代表已连接。',
  unauthenticated: '未登录。',
  connected: '原生已连接。',
  failed: '原生授权失败，请检查连接器后重试。',
  unavailable: '原生 OAuth 不可用，请确认所选运行时及 Agent 可用后刷新状态。',
  unknown: '授权状态未确认，请刷新状态；不要自动重试登录。',
};

export function ConnectorOAuthControl({ connector, scope, disabled }: {
  connector: ExternalConnectorSummary;
  scope: RuntimeInstanceScope;
  disabled: boolean;
}) {
  if (connector.kind !== 'mcp-http' || connector.auth !== 'oauth' || connector.enabled === false) return null;
  return <ConnectorOAuthButton key={connector.id} connector={connector} scope={scope} disabled={disabled} />;
}

function ConnectorOAuthButton({ connector, scope, disabled }: {
  connector: Extract<ExternalConnectorSummary, { kind: 'mcp-http' }>;
  scope: RuntimeInstanceScope;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="icon" className="size-7" disabled={disabled} aria-label={`OAuth 登录与退出 ${connector.displayName || connector.id}`} title="OAuth 登录与退出" onClick={() => setOpen(true)}><KeyRound className="size-3.5" /></Button>
    {open && <ConnectorOAuthDialog key={connector.url} connector={connector} scope={scope} onClose={() => setOpen(false)} />}
  </>;
}

function ConnectorOAuthDialog({ connector, scope, onClose }: {
  connector: ExternalConnectorSummary;
  scope: RuntimeInstanceScope;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const agents = endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, scope.endpoint))?.agents ?? [];
  const needsAgent = scope.endpoint.kind === 'native-runtime' && scope.endpoint.runtimeAdapterId === 'matcha-agent';
  const [agentId, setAgentId] = useState('');
  const selectedAgentId = needsAgent ? agents.find((agent) => agent.agentId === agentId)?.agentId : undefined;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog ref={dialog} aria-labelledby={titleId} className="m-auto w-[calc(100%_-_2rem)] max-w-md border-0 bg-transparent p-0 text-foreground backdrop:bg-[hsl(var(--shell-scrim))]" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <Card className="max-h-[90vh] overflow-y-auto">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle id={titleId}>OAuth · {connector.displayName || connector.id}</CardTitle>
            <CardDescription className="mt-2">授权由当前运行时管理；关闭窗口不会退出登录。</CardDescription>
          </div>
          <Button variant="ghost" size="icon" aria-label="关闭 OAuth" onClick={onClose}><X className="size-4" /></Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {needsAgent && <div className="space-y-2">
            <Label htmlFor={`${titleId}-agent`}>Agent</Label>
            <Select id={`${titleId}-agent`} value={selectedAgentId ?? ''} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">请选择已有 Agent</option>
              {agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.displayName || agent.agentId}</option>)}
            </Select>
            {agents.length === 0 && <p className="text-xs text-muted-foreground">当前运行时没有可用的 Agent。</p>}
          </div>}
          <ConnectorOAuthActions key={selectedAgentId ?? ''} connectorId={connector.id} scope={scope} agentId={selectedAgentId} ready={!needsAgent || selectedAgentId !== undefined} />
        </CardContent>
      </Card>
    </dialog>,
    document.body,
  );
}

function ConnectorOAuthActions({ connectorId, scope, agentId, ready }: {
  connectorId: string;
  scope: RuntimeInstanceScope;
  agentId?: string;
  ready: boolean;
}) {
  const active = useRef(true);
  const sequence = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<McpOAuthAction | 'browser' | null>(null);
  const [receipt, setReceipt] = useState<McpOAuthReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useCallback((request: number) => {
    const state = useRuntimeEndpointsStore.getState();
    const endpoint = selectManagementEndpoint(state);
    return active.current && sequence.current === request && endpoint !== null && runtimeEndpointsEqual(endpoint, scope.endpoint)
      && (agentId === undefined || state.endpoints.some((entry) => runtimeEndpointsEqual(entry.endpointRef, scope.endpoint)
        && entry.agents.some((agent) => agent.agentId === agentId)));
  }, [scope, agentId]);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; sequence.current += 1; pending.current?.abort(); };
  }, []);

  const run = async (action: McpOAuthAction) => {
    if (!ready || busy !== null || pending.current || !current(sequence.current)) return;
    const request = ++sequence.current;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(action);
    setError(null);
    const flowId = action === 'start' ? undefined : receipt?.flowId;
    if (action !== 'status') setReceipt(null);
    try {
      let result = await requestConnectorOAuth(scope, { connectorId, action, ...(agentId ? { agentId } : {}), ...(flowId ? { flowId } : {}) }, controller.signal);
      if (!current(request)) return;
      if (action === 'logout') {
        const logoutFlowId = result.flowId;
        result = await requestConnectorOAuth(scope, { connectorId, action: 'status', ...(agentId ? { agentId } : {}), ...(logoutFlowId ? { flowId: logoutFlowId } : {}) }, controller.signal);
        if (!current(request)) return;
        if (result.state !== 'unauthenticated' && result.state !== 'authorization-required') setError('退出登录尚未确认，请刷新原生状态；不要重复提交。');
      }
      setReceipt((previous) => ({ ...result,
        ...(result.state === 'authorizing' && !result.authorizationUrl && previous?.flowId === result.flowId && previous?.authorizationUrl ? { authorizationUrl: previous.authorizationUrl } : {}),
      }));
    } catch {
      if (current(request)) {
        setReceipt({ state: 'unknown', ...(action === 'status' && flowId ? { flowId } : {}) });
        setError(action === 'logout' ? '退出结果未确认，请刷新原生状态；不要重复提交。' : action === 'start' ? '登录结果未确认，请先刷新原生状态再重试。' : '无法读取原生授权状态，请确认运行时可用后刷新。');
      }
    } finally {
      if (current(request)) { pending.current = null; setBusy(null); }
    }
  };

  const openBrowser = async () => {
    if (!receipt?.authorizationUrl || busy !== null || pending.current || !current(sequence.current)) return;
    const request = ++sequence.current;
    setBusy('browser');
    setError(null);
    try {
      await invokeIpc('shell:openExternal', receipt.authorizationUrl);
    } catch {
      if (current(request)) setError('无法打开浏览器，请确认系统默认浏览器可用后重试。');
    } finally {
      if (current(request)) { pending.current = null; setBusy(null); }
    }
  };

  return <>
    <p role="status" className="text-sm text-muted-foreground">{receipt ? STATUS_LABELS[receipt.state] : ready ? '点击刷新状态查看原生登录状态，或点击登录开始授权。' : '请选择已有 Agent 后操作。'}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      {receipt?.authorizationUrl && <Button variant="outline" disabled={!ready || busy !== null} onClick={() => void openBrowser()}>打开浏览器</Button>}
      <Button variant="outline" disabled={!ready || busy !== null} onClick={() => void run('status')}>刷新状态</Button>
      <Button variant="outline" disabled={!ready || busy !== null} onClick={() => void run('logout')}>退出登录</Button>
      <Button disabled={!ready || busy !== null} onClick={() => void run('start')}>{busy !== null && <Loader2 className="mr-2 size-4 animate-spin" />}登录</Button>
    </div>
  </>;
}
