import { useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Download, ListRestart, Loader2, Upload, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { invokeIpc } from '@/lib/api-client';
import { waitForCall } from '@/lib/call-log-await';
import { hostWikiCallResult, hostWikiExportArchive, hostWikiImportArchive, hostWikiRebuildIndex } from '@/lib/host-api';
import { pickLocalDirectory } from '@/services/local-path-picker';
import { HistorySettingsPanel } from './HistorySettingsPanel';
import { ReindexProgress } from './ReindexProgress';
import { WikiPanel, WikiPanelHeader, WikiSurface } from './WikiChrome';

export type MaintenancePanelProps = Readonly<{
  projectId: string;
  projectName?: string;
  busy: string | null;
  onChanged(): Promise<void>;
}>;

type MaintenanceOperation = 'project.export-archive' | 'project.import-archive' | 'rebuild-index';

export function MaintenancePanel(props: MaintenancePanelProps): JSX.Element {
  return <MaintenanceBody key={props.projectId} {...props} />;
}

function MaintenanceBody({ projectId, projectName, busy, onChanged }: MaintenancePanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [pending, setPending] = useState<MaintenanceOperation | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const observing = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const disabled = busy !== null || pending !== null;
  const text = (key: string, defaultValue: string) => t(`maintenance.${key}`, { defaultValue });

  useEffect(() => {
    const controller = new AbortController();
    observing.current = controller;
    return () => { controller.abort(); };
  }, []);

  async function confirm(message: string, detail?: string): Promise<boolean> {
    const result = await invokeIpc<{ response: number }>('dialog:message', {
      type: 'warning',
      title: text('title', '知识库维护'),
      message,
      detail,
      buttons: [text('cancel', '取消'), text('confirm', '确认继续')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  }

  async function run(operation: MaintenanceOperation): Promise<void> {
    const signal = observing.current?.signal;
    if (disabled || locked.current || !signal || signal.aborted) return;
    locked.current = true;
    setPending(operation);
    setNotice('');
    setError('');
    try {
      let destination: string | undefined;
      let archivePath: string | undefined;
      if (operation === 'project.export-archive') {
        const selected = await invokeIpc<{ canceled: boolean; filePath?: string }>('dialog:save', {
          title: text('export', '导出 ZIP'),
          defaultPath: `${(projectName || 'wiki').replace(/[<>:"/\\|?*]/g, '-')}.llmwiki.zip`,
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
          properties: ['showOverwriteConfirmation'],
        });
        if (signal.aborted || selected.canceled || !selected.filePath) return;
        destination = selected.filePath;
      } else if (operation === 'project.import-archive') {
        const selected = await invokeIpc<{ canceled: boolean; filePaths: string[] }>('dialog:open', {
          title: text('import', '导入 ZIP 为新知识库'),
          properties: ['openFile'],
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        });
        if (signal.aborted || selected.canceled || !selected.filePaths[0]) return;
        archivePath = selected.filePaths[0];
        const directory = await pickLocalDirectory({ title: text('importDestination', '选择新知识库的空目录') });
        if (signal.aborted || !directory) return;
        destination = directory;
        if (!await confirm(text('importConfirm', '将 ZIP 解压到所选空目录并切换为新知识库；不会覆盖当前知识库。'), directory) || signal.aborted) return;
      } else {
        if (!await confirm(text('rebuildConfirm', '重建将重新生成 wiki/index.md 的分类目录，替换其中的手动修改；知识页面不会被删除。')) || signal.aborted) return;
      }

      const receipt = operation === 'project.export-archive'
        ? await hostWikiExportArchive({ projectId, destination: destination! })
        : operation === 'project.import-archive'
          ? await hostWikiImportArchive({ archivePath: archivePath!, destination: destination! })
          : await hostWikiRebuildIndex({ projectId });
      if (signal.aborted) return;
      const call = await waitForCall(receipt, 'wiki', { signal }).catch(() => {
        throw new Error(text('unconfirmed', '无法确认操作结果，请刷新查看；不要重复提交。'));
      });
      if (signal.aborted) return;
      if (call.command !== operation || call.detail.operation !== operation || call.status === 'unknown') {
        throw new Error(text('unconfirmed', '无法确认操作结果，请刷新查看；不要重复提交。'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(text('failed', '维护操作未完成，请检查后重试。'));
      }
      if (operation === 'project.export-archive') {
        setNotice(text('exported', 'ZIP 已导出。'));
        return;
      }
      const result = await hostWikiCallResult({ callId: call.callId }).catch(() => {
        throw new Error(text('unconfirmed', '无法确认操作结果，请刷新查看；不要重复提交。'));
      });
      if (signal.aborted) return;
      if (result.callId !== call.callId || result.operation !== operation) {
        throw new Error(text('unconfirmed', '无法确认操作结果，请刷新查看；不要重复提交。'));
      }
      let completed = text('imported', '新知识库已导入。');
      if (result.operation === 'rebuild-index') {
        if (result.result.projectId !== projectId) throw new Error(text('unconfirmed', '无法确认操作结果，请刷新查看；不要重复提交。'));
        completed = t('maintenance.rebuilt', { defaultValue: '分类索引已重建：{{pages}} 个页面，{{groups}} 个分类。', pages: result.result.pages, groups: result.result.groups });
      }
      setNotice(completed);
      try {
        await onChanged();
      } catch {
        if (!signal.aborted) setError(text('refreshFailed', '操作已完成，但页面刷新失败，请手动刷新。'));
      }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : text('failed', '维护操作未完成，请检查后重试。'));
    } finally {
      if (!signal.aborted) {
        locked.current = false;
        setPending(null);
      }
    }
  }

  return (
    <WikiPanel>
      <WikiPanelHeader title={text('title', '知识库维护')} icon={Wrench} />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        <WikiSurface className="space-y-3 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Archive className="h-4 w-4" />{text('archives', '知识库归档')}</h3>
          <p className="text-xs text-muted-foreground">{text('archiveHint', '导出当前知识库为 ZIP；导入会创建并打开新知识库，目标必须是空目录。')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { void run('project.export-archive'); }}><Download className="h-4 w-4" />{text('export', '导出 ZIP')}</Button>
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { void run('project.import-archive'); }}><Upload className="h-4 w-4" />{text('import', '导入 ZIP 为新知识库')}</Button>
          </div>
        </WikiSurface>
        <WikiSurface className="space-y-3 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><ListRestart className="h-4 w-4" />{text('classification', '分类索引')}</h3>
          <p className="text-xs text-muted-foreground">{text('classificationHint', '根据现有知识页面重新生成 wiki/index.md；不会重建向量索引。')}</p>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { void run('rebuild-index'); }}>{text('rebuild', '重建分类索引')}</Button>
        </WikiSurface>
        <ReindexProgress projectId={projectId} busy={pending ?? busy} />
        <HistorySettingsPanel projectId={projectId} busy={pending ?? busy} />
        {pending ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{text('working', '正在处理，请等待实际操作结果…')}</p> : null}
        {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </div>
    </WikiPanel>
  );
}
