import { createContext, useContext, useState, type DragEvent } from 'react';
import { RefreshCw, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { invokeIpc } from '@/lib/api-client';
import { hostImportSkillArchive, requireSkillsScope } from '@/lib/skills';
import { cn } from '@/lib/utils';
import { readLocalSkillImport } from '@/services/local-path-picker';
import type { SkillOwnerProps, SkillViewProps } from '../extensions';
import { useSkillsStore } from '../stores/skills';

const PlainTransferContext = createContext<(() => void) | null>(null);

async function importPlainSkill(sourcePath: string, archive: File | null, selectionCurrent: () => boolean) {
  const scope = requireSkillsScope();
  const generation = useSkillsStore.getState().scopeGeneration;
  const { fetchSkills, importLocalSkill, finishSkillInstallation } = useSkillsStore.getState();
  if (scope.kind === 'agent' && archive) {
    await hostImportSkillArchive(archive, archive.name.replace(/\.zip$/i, ''), scope);
    if (!selectionCurrent()) return;
    await fetchSkills({ force: true, scope });
    if (selectionCurrent()) return { kind: 'native' as const };
    return;
  }
  if (scope.kind === 'agent' && /\.zip$/i.test(sourcePath)) throw new Error('Use the ZIP file input to preserve binary resources');
  const importedSkill = await readLocalSkillImport(sourcePath);
  if (!importedSkill) return;
  const skillKey = importedSkill.skillKey.trim();
  if (!skillKey) throw new Error('Imported skill did not return a skill key');
  if (useSkillsStore.getState().scopeGeneration !== generation || !selectionCurrent()) return;
  await importLocalSkill(importedSkill, scope);
  if (useSkillsStore.getState().scopeGeneration !== generation || !selectionCurrent()) return;
  if (scope.kind === 'agent') {
    await fetchSkills({ force: true, scope });
    if (selectionCurrent()) return { kind: 'native' as const };
    return;
  }

  let enableError: unknown = null;
  try {
    await finishSkillInstallation(skillKey, scope, selectionCurrent);
  } catch (error) {
    enableError = error;
    if (!selectionCurrent()) return;
    try {
      await fetchSkills({ force: true, fresh: true, scope });
    } catch (refreshError) {
      console.error('Failed to refresh skills after local import:', refreshError);
    }
  }
  if (selectionCurrent()) return { kind: 'plain' as const, skillKey, enableError };
}

interface LocalSkillUploadDialogProps {
  open: boolean;
  importing: boolean;
  selectedSourceName: string;
  selectedSourcePath: string;
  nativeAgent: boolean;
  onArchiveFile: (file: File) => void;
  onClose: () => void;
  onChooseSource: () => void;
  onDropSourcePath: (path: string) => void;
  onImport: () => void;
}

function LocalSkillUploadDialog({
  open,
  importing,
  selectedSourceName,
  selectedSourcePath,
  nativeAgent,
  onArchiveFile,
  onClose,
  onChooseSource,
  onDropSourcePath,
  onImport,
}: LocalSkillUploadDialogProps) {
  const { t } = useTranslation('skills');
  const [dragActive, setDragActive] = useState(false);

  if (!open) {
    return null;
  }

  const handleClose = () => {
    setDragActive(false);
    onClose();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const archive = nativeAgent && Array.from(event.dataTransfer.files).find((file) => file.name.toLowerCase().endsWith('.zip'));
    if (archive) { onArchiveFile(archive); return; }
    const droppedPaths = Array.from(event.dataTransfer.files)
      .map((file) => window.electron.getPathForFile(file))
      .filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
    if (droppedPaths.length === 0) {
      return;
    }
    onDropSourcePath(droppedPaths[0]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={handleClose}>
      <Card
        className="w-full max-w-[30rem] rounded-[1.5rem] border border-border/80 bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="text-xl">{t('marketplace.uploadDialog.title')}</CardTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={handleClose} disabled={importing}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-5">
          <div
            role="button"
            tabIndex={0}
            className={cn(
              'rounded-[1.25rem] border border-dashed px-6 py-8 text-center transition-colors',
              dragActive
                ? 'border-primary bg-primary/5'
                : 'border-border/70 bg-muted/15 hover:border-primary/50 hover:bg-muted/30',
            )}
            onClick={onChooseSource}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onChooseSource();
              }
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragActive(false);
            }}
            onDrop={handleDrop}
          >
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
              <Upload className="h-5 w-5" />
            </div>
            {selectedSourceName ? (
              <div className="mt-4 space-y-1">
                <p className="text-base font-medium text-foreground">{selectedSourceName}</p>
                <p className="break-all text-xs text-muted-foreground">{selectedSourcePath}</p>
                <p className="pt-1 text-sm text-muted-foreground">{t('marketplace.uploadDialog.replace')}</p>
              </div>
            ) : (
              <div className="mt-4 space-y-1">
                <p className="text-base font-medium text-foreground">{t('marketplace.uploadDialog.empty')}</p>
                <p className="text-sm text-muted-foreground">{t('marketplace.uploadDialog.hint')}</p>
              </div>
            )}
          </div>

          {nativeAgent && <label className="block space-y-2 text-sm">
            <span>{t('nativeArchiveLabel', { defaultValue: '二进制 ZIP（不超过 32 MiB，以文件名作为技能目录名）' })}</span>
            <Input type="file" accept=".zip" disabled={importing} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onArchiveFile(file);
            }} />
          </label>}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">{t('marketplace.uploadDialog.requirementsTitle')}</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('marketplace.uploadDialog.requirementDirectoryZip')}</li>
              <li>{t('marketplace.uploadDialog.requirementMarkdown')}</li>
            </ul>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={importing}>
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button onClick={onImport} disabled={!selectedSourcePath || importing} className="gap-2">
              {importing ? <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Upload className="h-4 w-4" />}
              {t('marketplace.uploadDialog.confirm')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function PlainTransferOwner({ children, scopeKey, nativeAgent, selectionCurrent }: SkillOwnerProps) {
  const { t } = useTranslation('skills');
  const [dialog, setDialog] = useState({ scopeKey, open: false, sourcePath: '', archive: null as File | null, importing: false });

  if (dialog.scopeKey !== scopeKey) {
    setDialog({ scopeKey, open: false, sourcePath: '', archive: null, importing: false });
  }

  const resetLocalSkillDialog = () => {
    setDialog({ scopeKey, open: false, sourcePath: '', archive: null, importing: false });
  };
  const localSkillSourceName = dialog.sourcePath.split(/[\\/]/).pop() || dialog.sourcePath;

  const handleChooseLocalSkillSource = async () => {
    try {
      const result = await invokeIpc<{ canceled: boolean; filePaths?: string[] }>('dialog:open', {
        properties: ['openFile', 'openDirectory'],
        filters: [
          {
            name: t('marketplace.uploadDialog.skillSourceFilter'),
            extensions: nativeAgent ? ['md'] : ['zip', 'md'],
          },
          {
            name: t('marketplace.uploadDialog.allFilesFilter'),
            extensions: ['*'],
          },
        ],
      });
      if (result.canceled || !result.filePaths?.length) {
        return;
      }
      if (!selectionCurrent()) return;
      setDialog((state) => ({ ...state, archive: null, sourcePath: result.filePaths![0] }));
    } catch (error) {
      if (selectionCurrent()) {
        toast.error(t('toast.failedImportLocalSkill') + ': ' + String(error));
      }
    }
  };

  const handleImportLocalSkill = async () => {
    if (dialog.importing || !dialog.sourcePath.trim()) {
      return;
    }

    const generation = useSkillsStore.getState().scopeGeneration;
    setDialog((state) => ({ ...state, importing: true }));
    try {
      const result = await importPlainSkill(dialog.sourcePath, dialog.archive, selectionCurrent);
      if (!result || !selectionCurrent()) return;
      if (result.kind === 'native') {
        toast.success(t('nativeInstalled', { defaultValue: '已安装到所选 Agent；新会话按原生策略发现' }));
      } else if (result.enableError) {
        toast.warning(t('toast.importedLocalSkillEnableFailed', { name: result.skillKey }) + ': ' + String(result.enableError));
      } else {
        toast.success(t('toast.importedLocalSkillEnabled', { name: result.skillKey }));
      }

      resetLocalSkillDialog();
    } catch (error) {
      if (useSkillsStore.getState().scopeGeneration !== generation || !selectionCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('toast.failedImportLocalSkill') + ': ' + message);
    } finally {
      if (useSkillsStore.getState().scopeGeneration === generation) setDialog((state) => ({ ...state, importing: false }));
    }
  };

  return (
    <PlainTransferContext.Provider value={() => setDialog((state) => ({ ...state, open: true }))}>
      {children}
      <LocalSkillUploadDialog
        open={dialog.open}
        importing={dialog.importing}
        selectedSourceName={localSkillSourceName}
        selectedSourcePath={dialog.sourcePath}
        nativeAgent={nativeAgent}
        onArchiveFile={(file) => setDialog((state) => ({ ...state, archive: file, sourcePath: file.name }))}
        onClose={() => {
          if (!dialog.importing) resetLocalSkillDialog();
        }}
        onChooseSource={() => { void handleChooseLocalSkillSource(); }}
        onDropSourcePath={(path) => setDialog((state) => ({ ...state, archive: null, sourcePath: path }))}
        onImport={() => { void handleImportLocalSkill(); }}
      />
    </PlainTransferContext.Provider>
  );
}

export function PlainImportEntry({ scope }: SkillViewProps) {
  const { t } = useTranslation('skills');
  const openDialog = useContext(PlainTransferContext)!;

  return (
    <Button
      type="button"
      variant="outline"
      className="h-9 gap-2"
      disabled={!scope}
      onClick={openDialog}
    >
      <Upload className="h-4 w-4" />
      {t('marketplace.uploadSkill')}
    </Button>
  );
}
