import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { hostNativePolicyCall } from '@/lib/host-api';
import type { AgentScope } from '@/types/desktop/runtime-address';
import { isNativePolicyRequest, NATIVE_PERMISSION_MODES, type NativePolicyRequest, type NativePolicyResult } from '@/types/native-policy';

type Section = 'permissions' | 'hooks' | 'sandbox';
const LABELS: Record<Section, string> = { permissions: '原生权限', hooks: '原生 Hooks', sandbox: '原生沙箱' };
const READS = { permissions: 'nativePermissions.get', hooks: 'nativeHooks.get', sandbox: 'nativeSandbox.status' } as const;

function describeResult(result: NativePolicyResult): string {
  if (result.outcome === 'confirmed') {
    const receipt = result.receipt;
    return `${receipt.persisted ? '配置已持久化' : '配置未确认持久化'}；仅投影到后续 CLI 实例，不代表当前生效。${receipt.restartRequired ? `需重启字段：${receipt.restartFields.join('、')}` : ''}`;
  }
  if (result.outcome === 'available') return '';
  return `${result.outcome} (${result.kind})；持久化：${result.persisted === null ? '未知' : result.persisted ? '已保存' : '未保存'}。${result.outcome === 'unknown' ? '结果未知，请读取配置确认，不要重复提交。' : ''}`;
}

export function NativePolicySection({ scope }: { scope: AgentScope }) {
  const [section, setSection] = useState<Section>('permissions');
  const [result, setResult] = useState<NativePolicyResult | null>(null);
  const [draft, setDraft] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const sequence = useRef(0);
  const envelope = { id: 'security.nativePolicy' as const, scope, target: { kind: 'native-policy' as const } };

  useEffect(() => {
    const id = ++sequence.current;
    setResult(null);
    setDraft('{}');
    setMessage('');
    setBusy(true);
    void hostNativePolicyCall({ id: 'security.nativePolicy', scope, target: { kind: 'native-policy' }, operationId: READS[section], input: {} })
      .then((view) => { if (sequence.current === id) { setResult(view); setMessage(describeResult(view)); } })
      .catch((error) => { if (sequence.current === id) setMessage(error instanceof Error ? error.message : '读取原生配置失败'); })
      .finally(() => { if (sequence.current === id) setBusy(false); });
    return () => { sequence.current += 1; };
  }, [scope, section]);

  const snapshot = result?.outcome === 'available' ? result.snapshot : null;
  const sandboxUnsupported = section === 'sandbox' && snapshot?.platform?.support !== 'nativeDependencyCheckRequired';
  const refresh = async () => {
    const id = ++sequence.current;
    setBusy(true);
    try {
      const view = await hostNativePolicyCall({ ...envelope, operationId: READS[section], input: {} });
      if (sequence.current !== id) return;
      setResult(view);
      setMessage(describeResult(view));
    } catch (error) {
      if (sequence.current === id) setMessage(error instanceof Error ? error.message : '读取原生配置失败');
    } finally {
      if (sequence.current === id) setBusy(false);
    }
  };
  const save = async () => {
    let request: NativePolicyRequest;
    try {
      const patch: unknown = JSON.parse(draft);
      const value = section === 'permissions'
        ? { ...envelope, operationId: 'nativePermissions.set', input: { permissions: patch } }
        : section === 'hooks'
          ? { ...envelope, operationId: 'nativeHooks.set', input: { hooks: patch } }
          : { ...envelope, operationId: 'nativeSandbox.set', input: { sandbox: patch } };
      if (!isNativePolicyRequest(value)) throw new Error('配置必须是该原生 section 支持的非空 JSON patch。');
      request = value;
      if (sandboxUnsupported && request.operationId === 'nativeSandbox.set' && request.input.sandbox.enabled === true) {
        throw new Error('当前平台不支持启用原生沙箱；不能将配置开关当成实际隔离。');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'JSON 配置无效');
      return;
    }
    const id = ++sequence.current;
    setBusy(true);
    setMessage('');
    try {
      const receipt = await hostNativePolicyCall(request);
      if (sequence.current !== id) return;
      setMessage(describeResult(receipt));
      if (receipt.outcome !== 'confirmed') return;
      setDraft('{}');
      const view = await hostNativePolicyCall({ ...envelope, operationId: READS[section], input: {} });
      if (sequence.current === id) setResult(view);
    } catch (error) {
      if (sequence.current === id) setMessage(error instanceof Error ? error.message : '提交结果未确认；请读取配置，不要重复提交。');
    } finally {
      if (sequence.current === id) setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <Label htmlFor="native-policy-section">原生权限、Hooks 与沙箱</Label>
      <Select id="native-policy-section" value={section} disabled={busy} onChange={(event) => setSection(event.target.value as Section)}>
        {Object.entries(LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
      <p className="text-xs text-muted-foreground">仅修改此 Agent 的原生配置，不选择运行中的会话；保存作用于后续 CLI 实例，不代表当前权限、Hook 执行或沙箱隔离已生效。原生组织策略仍有最终决定权。</p>
      {snapshot && <>
        <p className="text-xs text-muted-foreground">配置来源：{snapshot.configuredSource}；原生观测：{snapshot.nativeObservation}；{snapshot.platform ? `平台：${snapshot.platform.name} / ${snapshot.platform.support}；隔离：${snapshot.isolation ?? '未观测'}` : `执行权威：${snapshot.authority}`}</p>
        <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs" aria-label="已保存的原生配置">{JSON.stringify(snapshot.configured, null, 2)}</pre>
      </>}
      {section === 'permissions' && <>
        <Label htmlFor="native-permission-mode">写入原生模式</Label>
        <Select id="native-permission-mode" value="" disabled={busy || !snapshot} onChange={(event) => setDraft(JSON.stringify({ defaultMode: event.target.value }, null, 2))}>
          <option value="" disabled>选择要写入的原生模式</option>
          {NATIVE_PERMISSION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </Select>
      </>}
      <Label htmlFor="native-policy-patch">{LABELS[section]} JSON patch</Label>
      <p className="text-xs text-muted-foreground">{section === 'hooks' ? '上方只读事件计数，命令、Prompt 和 Headers 不回显；草稿只写入明确列出的事件，空数组清除该事件。不记录或缓存草稿。' : '只提交明确列出的字段；省略字段保持不变，数组会替换该字段。'}</p>
      <Textarea id="native-policy-patch" className="font-mono text-xs" rows={6} value={draft} disabled={busy || !snapshot} onChange={(event) => setDraft(event.target.value)} />
      {message && <p role="status" className="whitespace-pre-wrap text-sm">{message}</p>}
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>读取配置</Button>
        <Button type="button" disabled={busy || !snapshot || draft.trim() === '{}'} onClick={() => void save()}>保存此项原生配置</Button>
      </div>
    </section>
  );
}
