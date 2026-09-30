import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock3, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { waitForCall } from '@/lib/call-log-await';
import { hostWikiHistoryClear, hostWikiHistoryConfig, hostWikiHistoryStats, hostWikiUpdateHistoryConfig } from '@/lib/host-api';
import type { WikiHistoryConfig, WikiHistoryStats } from '@/types/wiki-capabilities';
import { formatFileSize } from '../wiki-model';
import { WikiEmpty, WikiIconButton, WikiSurface } from './WikiChrome';

export type HistorySettingsPanelProps = Readonly<{
  projectId: string;
  busy: string | null;
}>;

export function HistorySettingsPanel(props: HistorySettingsPanelProps): JSX.Element {
  return <HistorySettingsView key={props.projectId} {...props} />;
}

function HistorySettingsView({ projectId, busy }: HistorySettingsPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [config, setConfig] = useState<WikiHistoryConfig | null>(null);
  const [draft, setDraft] = useState<WikiHistoryConfig | null>(null);
  const [stats, setStats] = useState<WikiHistoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<'save' | 'clear' | null>(null);
  const [confirmation, setConfirmation] = useState<'zero' | 'clear' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const disabled = busy !== null || loading || pending !== null;

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [nextConfig, nextStats] = await Promise.all([hostWikiHistoryConfig({ projectId }), hostWikiHistoryStats({ projectId })]);
      if (signal.aborted) return;
      setConfig(nextConfig);
      setDraft(nextConfig);
      setStats(nextStats);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t('history.settingsLoadFailed', { defaultValue: '历史设置读取失败，请刷新重试。' }));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save(): Promise<void> {
    const signal = controllerRef.current?.signal;
    if (!draft || disabled || !signal || signal.aborted) return;
    setPending('save');
    setError('');
    setNotice('');
    try {
      const saved = await hostWikiUpdateHistoryConfig({ projectId, enabled: draft.maxVersionsPerFile === 0 ? false : draft.enabled, maxVersionsPerFile: draft.maxVersionsPerFile });
      if (signal.aborted) return;
      setConfig(saved);
      setDraft(saved);
      const nextStats = await hostWikiHistoryStats({ projectId });
      if (signal.aborted) return;
      setStats(nextStats);
      setConfirmation(null);
      setNotice(t('history.saved', { defaultValue: '历史设置已保存' }));
    } catch (cause) {
      if (!signal.aborted) {
        setConfirmation(null);
        setError(cause instanceof Error ? cause.message : t('history.saveFailed', { defaultValue: '历史设置保存失败，请刷新确认后重试。' }));
      }
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!draft || disabled) return;
    if (!Number.isInteger(draft.maxVersionsPerFile) || draft.maxVersionsPerFile < 0 || draft.maxVersionsPerFile > 30) {
      setError(t('history.invalidRetention', { defaultValue: '保留版本数须为 0 到 30 的整数。' }));
      return;
    }
    if (draft.maxVersionsPerFile === 0) setConfirmation('zero');
    else void save();
  }

  async function clear(): Promise<void> {
    const signal = controllerRef.current?.signal;
    if (disabled || !signal || signal.aborted) return;
    setPending('clear');
    setError('');
    setNotice('');
    try {
      const receipt = await hostWikiHistoryClear({ projectId });
      if (signal.aborted) return;
      const call = await waitForCall(receipt, 'wiki', { signal });
      if (signal.aborted) return;
      if (call.command !== 'history.clear' || call.detail.operation !== 'history.clear' || call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('history.clearFailed', { defaultValue: '历史清理未完成，请刷新确认结果。' }));
      }
      const nextStats = await hostWikiHistoryStats({ projectId });
      if (signal.aborted) return;
      setStats(nextStats);
      setConfirmation(null);
      setNotice(t('history.cleared', { defaultValue: '历史快照已清空，当前文件未被删除。' }));
    } catch (cause) {
      if (!signal.aborted) {
        setConfirmation(null);
        setError(cause instanceof Error ? cause.message : t('history.clearFailed', { defaultValue: '历史清理未完成，请刷新确认结果。' }));
      }
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }

  return (
    <WikiSurface className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Clock3 className="h-4 w-4 text-muted-foreground" />
        <h3 className="flex-1 text-sm font-semibold">{t('history.settingsTitle', { defaultValue: '文件历史设置' })}</h3>
        <WikiIconButton type="button" disabled={disabled} title={t('common.refresh')} aria-label={t('common.refresh')} onClick={() => { const signal = controllerRef.current?.signal; if (signal && !signal.aborted) void load(signal); }}><RefreshCw className="h-4 w-4" /></WikiIconButton>
      </div>
      <p className="text-xs text-muted-foreground">{t('history.description', { defaultValue: '管理当前知识库的文件快照和保留数量。' })}</p>
      {loading ? <p role="status" className="text-sm text-muted-foreground">{t('history.settingsLoading', { defaultValue: '正在读取历史设置…' })}</p> : null}
      {draft ? (
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={disabled} className="space-y-4 disabled:opacity-70">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor={`history-enabled-${projectId}`} className="space-y-1">
                <span className="block text-sm font-medium">{t('history.enabled', { defaultValue: '启用文件历史' })}</span>
                <span className="block text-xs text-muted-foreground">{t('history.enabledHint', { defaultValue: '关闭后停止生成新快照，已有历史不会被删除。' })}</span>
              </label>
              <Switch id={`history-enabled-${projectId}`} checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled, maxVersionsPerFile: enabled && draft.maxVersionsPerFile === 0 ? 10 : draft.maxVersionsPerFile })} />
            </div>
            <label className="block space-y-2">
              <span className="block text-sm font-medium">{t('history.retention', { defaultValue: '每个文件保留的版本数' })}</span>
              <Input type="number" min={0} max={30} step={1} required value={Number.isNaN(draft.maxVersionsPerFile) ? '' : draft.maxVersionsPerFile} onChange={(event) => setDraft({ ...draft, maxVersionsPerFile: event.target.valueAsNumber })} className="max-w-40" />
              <span className="block text-xs text-muted-foreground">{t('history.retentionHint', { defaultValue: '可设置为 0 到 30。设为 0 会关闭历史并清除已有快照；重新启用时默认保留 10 个版本。' })}</span>
            </label>
            <Button type="submit" size="sm" variant="outline" className="rounded-full" disabled={!config || (config.enabled === draft.enabled && config.maxVersionsPerFile === draft.maxVersionsPerFile)}><Save className="h-4 w-4" />{pending === 'save' ? t('history.saving', { defaultValue: '保存中…' }) : t('history.save', { defaultValue: '保存设置' })}</Button>
          </fieldset>
        </form>
      ) : !loading && !error ? <WikiEmpty title={t('history.settingsLoading', { defaultValue: '正在读取历史设置…' })} icon={Clock3} /> : null}
      {stats ? <p className="text-xs text-muted-foreground">{t('history.usage', { defaultValue: '{{files}} 个文件，{{entries}} 个版本，占用 {{size}}', files: stats.files, entries: stats.entries, size: formatFileSize(stats.bytes) || '0 B' })}</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      <Button type="button" size="sm" variant="outline" className="rounded-full" disabled={disabled || !stats || stats.entries === 0} onClick={() => setConfirmation('clear')}><Trash2 className="h-4 w-4" />{pending === 'clear' ? t('history.clearing', { defaultValue: '清理中…' }) : t('history.clear', { defaultValue: '清空全部历史' })}</Button>
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation === 'zero' ? t('history.zeroConfirmTitle', { defaultValue: '关闭并清空文件历史？' }) : t('history.clearConfirmTitle', { defaultValue: '清空全部文件历史？' })}
        message={confirmation === 'zero' ? t('history.zeroConfirm', { defaultValue: '设为 0 会关闭文件历史并删除当前知识库的全部历史快照，当前文件不会被删除。此操作不可撤销。' }) : t('history.clearConfirm', { defaultValue: '将删除当前知识库的全部文件历史快照，当前文件不会被删除。此操作不可撤销。' })}
        confirmLabel={confirmation === 'zero' ? t('history.save', { defaultValue: '保存设置' }) : t('history.clear', { defaultValue: '清空全部历史' })}
        cancelLabel={t('history.cancel', { defaultValue: '取消' })}
        variant="destructive"
        onConfirm={confirmation === 'zero' ? save : clear}
        onCancel={() => setConfirmation(null)}
      />
    </WikiSurface>
  );
}
