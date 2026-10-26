import { useState, useEffect, useCallback, useRef } from 'react';
import { X, QrCode, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useChannelsStore } from './store';
import { useRuntimeEndpointsStore, selectManagementAgentScope } from '@/stores/runtime-endpoints';
import { runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import { hostChannelsReadConfig, hostChannelsCancelSession, hostChannelsApprovePairingRequest, hostChannelsDisconnect, hostChannelsLogout, hostChannelsConfigure, hostChannelsActivate, hostChannelsLoginWait } from '@/lib/channel-runtime';
import { toast } from 'sonner';
import type { ChannelConfigurationProps } from './extensions';
import { channelScopeCurrent } from './scope';

export default function MatchaWeixinConfiguration({ scope, target, onClose, onChannelAdded: onSaved }: ChannelConfigurationProps) {
  const channel = target.kind === 'configured' ? target.channel : null;
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const selectedAgentScope = useRuntimeEndpointsStore(selectManagementAgentScope);
  const agents = endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, scope.endpoint))?.agents ?? [];
  const [accountId, setAccountId] = useState(channel?.accountId ?? '');
  const [agentId, setAgentId] = useState(selectedAgentScope && runtimeEndpointsEqual(selectedAgentScope.endpoint, scope.endpoint) ? selectedAgentScope.agentId : '');
  const [sessionId, setSessionId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(Boolean(channel));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string>();
  const [code, setCode] = useState('');
  const sequence = useRef(0);
  const active = useRef(true);
  const wait = useRef<AbortController | null>(null);
  const loginAccount = useRef<string | null>(null);
  const current = useCallback((id: number) => active.current && sequence.current === id && channelScopeCurrent(scope), [scope]);

  useEffect(() => {
    active.current = true;
    const id = ++sequence.current;
    if (channel?.accountId) {
      void hostChannelsReadConfig(scope, 'weixin', channel.accountId).then((result) => {
        if (!current(id)) return;
        setAgentId(result.agentId ?? '');
        setSessionId(result.values.sessionId ?? '');
        setEnabled(result.values.enabled === 'true');
      }).catch((reason) => {
        if (current(id)) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => { if (current(id)) setLoading(false); });
    }
    return () => {
      active.current = false;
      sequence.current += 1;
      wait.current?.abort();
      if (loginAccount.current) void hostChannelsCancelSession(scope, 'weixin', loginAccount.current).catch(() => undefined);
    };
  }, [scope, channel, current]);

  const submit = async (action: 'save' | 'login' | 'stop' | 'logout' | 'pair') => {
    const id = ++sequence.current;
    setBusy(true);
    setError(null);
    try {
      const account = accountId.trim();
      if (action === 'pair') {
        await hostChannelsApprovePairingRequest(scope, 'weixin', { accountId: account, code: code.trim() });
      } else if (action === 'stop') {
        if (!(await hostChannelsDisconnect(scope, 'weixin', account)).success) throw new Error('停止消费未确认');
      } else if (action === 'logout') {
        await hostChannelsLogout(scope, 'weixin', account);
      } else {
        const input = { channelType: 'weixin' as const, accountId: account, agentId, config: { sessionId: sessionId.trim() || null, enabled } };
        if (action === 'save') {
          const result = await hostChannelsConfigure(scope, input);
          if (!result.success) throw new Error(result.error);
        } else {
          wait.current?.abort();
          const controller = new AbortController();
          wait.current = controller;
          loginAccount.current = account;
          const result = await hostChannelsActivate(scope, input);
          if (!current(id)) {
            await hostChannelsCancelSession(scope, 'weixin', account).catch(() => undefined);
            return;
          }
          let progress = result.progress;
          if (!result.success || !progress) throw new Error(result.error || '登录结果未知，请先查看配置再重试');
          while (progress.outcome === 'progress') {
            if (progress.qrDataUrl) setQr(progress.qrDataUrl);
            progress = await hostChannelsLoginWait(scope, 'weixin', account, {
              sessionKey: progress.sessionKey, currentQrDataUrl: progress.qrDataUrl, timeoutMs: 300_000, signal: controller.signal,
            });
            if (!current(id) || controller.signal.aborted) return;
          }
          loginAccount.current = null;
          if (progress.outcome !== 'connected') throw new Error('原生登录未确认；请查看绑定状态后重试');
          setQr(undefined);
        }
      }
      if (!current(id)) return;
      toast.success(action === 'login' ? '原生账号已保存，不代表消费会话在线或连接健康。' : action === 'save' ? '绑定已保存，下次原生会话启动时生效。' : '操作已确认');
      void useChannelsStore.getState().refreshAfterConfirmedMutation(scope);
      onSaved();
    } catch (reason) {
      if (current(id)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current(id)) setBusy(false);
    }
  };
  const valid = /^[A-Za-z0-9_.-]{1,128}$/.test(accountId.trim()) && Boolean(agentId)
    && (!enabled || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId.trim()));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[hsl(var(--shell-scrim))] p-4">
      <Card className="max-h-[90vh] w-full max-w-xl overflow-y-auto">
        <CardHeader className="flex flex-row items-start justify-between">
          <div><CardTitle>微信 · Matcha 原生绑定</CardTitle><CardDescription>每个 Agent 一个账号；绑定已有 Server 会话，不会自动新建会话。</CardDescription></div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭微信绑定"><X className="h-4 w-4" /></Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">启用配置在下次原生会话启动时生效。登录成功只表示账号已保存，不代表在线；停止消费会关闭绑定会话。删除绑定保留原生账号，清除账号请先退出登录。</p>
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <>
            <div className="space-y-2"><Label htmlFor="weixin-binding">绑定 ID（不是微信原生账号 ID）</Label><Input id="weixin-binding" value={accountId} disabled={Boolean(channel) || busy} onChange={(event) => setAccountId(event.target.value)} placeholder="字母、数字、下划线、点或连字符" /></div>
            <div className="space-y-2"><Label htmlFor="weixin-agent">Agent</Label><select id="weixin-agent" className="h-10 w-full rounded-md border bg-background px-3" value={agentId} disabled={busy} onChange={(event) => setAgentId(event.target.value)}><option value="" disabled>请选择 Agent</option>{agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.displayName || agent.agentId}</option>)}</select></div>
            <div className="space-y-2"><Label htmlFor="weixin-session">Server Session UUID</Label><Input id="weixin-session" value={sessionId} disabled={busy} onChange={(event) => setSessionId(event.target.value)} placeholder="必须属于所选 Agent 的真实会话 UUID" /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />下次会话启动时启用</label>
            {qr && <div className="space-y-2"><img src={qr} alt="微信原生登录二维码" className="mx-auto h-56 w-56 bg-white p-3" /><p className="text-xs text-muted-foreground">这是原生流程首次返回的二维码，不保证其刷新状态。</p></div>}
            {channel && <div className="flex gap-2"><Input aria-label="六位微信配对码" value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} placeholder="六位数字配对码" /><Button variant="outline" disabled={busy || !/^\d{6}$/.test(code.trim())} onClick={() => void submit('pair')}>批准配对</Button></div>}
            <div className="flex flex-wrap justify-end gap-2">
              {channel && <><Button variant="outline" disabled={busy} onClick={() => void submit('stop')}>停止消费</Button><Button variant="outline" disabled={busy} onClick={() => void submit('logout')}>退出并清除账号</Button></>}
              <Button variant="outline" disabled={busy || !valid} onClick={() => void submit('save')}>保存绑定</Button>
              <Button disabled={busy || !valid || !sessionId.trim()} onClick={() => void submit('login')}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <QrCode className="mr-2 h-4 w-4" />}原生登录</Button>
            </div>
          </>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

