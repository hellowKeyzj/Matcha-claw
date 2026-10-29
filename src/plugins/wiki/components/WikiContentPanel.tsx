import { Suspense, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Clock3, Eye, FileText, Link2, Pencil, Save, Sparkles } from 'lucide-react';
import { useContributions } from '@/plugin-host/react';
import { wikiContentPreviews, type WikiContentPreviewProps } from '../extensions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { FileContentType } from '@/plugins/files/file-types';
import { findDomTextSelection, findUniqueTextSelection, normalizeEditableMarkdown } from '../wiki-selection';
import type { WikiSelectionApplyReceipt, WikiSelectionSnapshot } from '@/types/wiki-selection';
import { SelectionAssistantPanel } from '@/plugins/wiki/components/SelectionAssistantPanel';
import { fileName, typeLabel } from '@/plugins/wiki/preview';
import { formatFileSize } from '@/plugins/wiki/wiki-model';
import { WikiPanel, WikiPanelHeader, WikiPrimaryButton } from '@/plugins/wiki/components/WikiChrome';
import { FileHistoryPanel } from '@/plugins/wiki/components/FileHistoryPanel';
import { PageLinksPanel } from '@/plugins/wiki/components/PageLinksPanel';

export type WikiContentPreview = Readonly<
  | { kind: 'empty' }
  | { kind: 'text'; path: string; contentType: FileContentType; ext: string; mimeType: string; content: string }
  | { kind: 'source'; path: string; contentType: FileContentType; ext: string; mimeType: string; content: string }
  | { kind: 'binary'; path: string; contentType: FileContentType; ext: string; mimeType: string; name: string; data: string; size: number }
  | { kind: 'unsupported'; path: string; contentType: FileContentType; ext: string; mimeType: string }
  | { kind: 'error'; path: string; contentType: FileContentType; ext: string; mimeType: string; message: string }
>;

export type WikiContentPanelProps = Readonly<{
  projectId: string;
  selectedPath: string;
  preview: WikiContentPreview;
  editorText: string;
  busy: string | null;
  modelRef?: string;
  onSelectionPrepare(snapshot: WikiSelectionSnapshot): Promise<void>;
  onSelectionApplied(receipt: WikiSelectionApplyReceipt): Promise<void>;
  sourceImageIndex?: number;
  resolveImageSrc?(src: string, filePath: string): Promise<string | null> | string | null;
  onEditorTextChange(value: string): void;
  onSave(): void;
  onEmbedPage(): void;
  onRestored(projectId: string, path: string): Promise<void>;
  onOpenFile(path: string): Promise<void>;
  onCreated(projectId: string, path: string): Promise<void>;
}>;

function EmptyState(): JSX.Element {
  const { t } = useTranslation('wiki');
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8 text-center">
      <div className="rounded-[28px] border border-dashed border-border/80 bg-card/60 px-12 py-10">
        <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-full bg-secondary text-muted-foreground">
          <FileText className="h-5 w-5" />
        </div>
        <h2 className="text-lg font-semibold">{t('content.selectPage')}</h2>
      </div>
    </div>
  );
}

function Notice({ title, description }: Readonly<{ title: string; description: string }>): JSX.Element {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8 text-center">
      <div className="max-w-sm rounded-[28px] border border-border/80 bg-card/70 px-6 py-5 shadow-sm">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-1 text-sm text-muted-foreground">{description}</div>
      </div>
    </div>
  );
}

function PreviewBody(props: WikiContentPreviewProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const previews = useContributions(wikiContentPreviews);
  const { preview } = props;

  if (preview.kind === 'empty') return <EmptyState />;
  if (preview.kind === 'error') return <Notice title={t('content.previewUnavailable')} description={preview.message} />;
  const contribution = preview.kind === 'unsupported' ? undefined : previews.find((item) => item.matches(preview));
  if (!contribution) return <Notice title={t('content.inlineUnsupported')} description={t('content.inlineUnsupportedDescription', { type: typeLabel(preview.contentType, preview.ext) })} />;
  const Preview = contribution.component;
  return <Suspense fallback={null}><Preview {...props} /></Suspense>;
}

export function WikiContentPanel(props: WikiContentPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const {
    selectedPath,
    preview,
    editorText,
    busy,
    resolveImageSrc,
    onEditorTextChange,
    onSave,
    onEmbedPage,
  } = props;
  const hasSelectedPage = selectedPath.trim().length > 0;
  const editable = preview.kind === 'text';
  const embeddable = preview.kind === 'text' && preview.contentType === 'markdown';
  const size = preview.kind === 'binary' ? formatFileSize(preview.size) : '';
  const previewRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [selectionRequest, setSelectionRequest] = useState<{ snapshot: WikiSelectionSnapshot; key: number; scope: string } | null>(null);
  const selectionKey = useRef(0);
  const scope = `${props.projectId}\n${selectedPath}\n${preview.kind}\n${editing}`;
  const editableMarkdown = embeddable && editing ? normalizeEditableMarkdown(editorText) : editorText;
  const selection = selectionRequest?.scope === scope ? selectionRequest : null;

  useEffect(() => {
    if (embeddable && editing && editableMarkdown !== editorText) onEditorTextChange(editableMarkdown);
  }, [embeddable, editing, editableMarkdown, editorText, onEditorTextChange]);

  const captureSelection = useCallback((snapshot: WikiSelectionSnapshot | null) => {
    if (!snapshot?.selectedText.trim()) { setSelectionRequest(null); return; }
    setLinksOpen(false);
    setSelectionRequest((current) => current?.scope === scope
      && current.snapshot.prefix === snapshot.prefix && current.snapshot.selectedText === snapshot.selectedText
      && current.snapshot.suffix === snapshot.suffix && current.snapshot.sourceMapped === snapshot.sourceMapped
      ? current : { snapshot, key: ++selectionKey.current, scope });
  }, [scope]);

  const captureEditorSelection = useCallback((markdown: string, start: number, end: number) => {
    if (!embeddable || start === end) { captureSelection(null); return; }
    const value = normalizeEditableMarkdown(markdown);
    if (value !== editorText) onEditorTextChange(value);
    captureSelection({ prefix: value.slice(0, start), selectedText: value.slice(start, end), suffix: value.slice(end), sourceMapped: true });
  }, [captureSelection, editorText, embeddable, onEditorTextChange]);

  const captureRenderedSelection = useCallback((browserSelection: Selection | null, root: HTMLDivElement) => {
    if (!embeddable || !browserSelection) { captureSelection(null); return; }
    const rendered = browserSelection.toString().trim();
    const mapped = findDomTextSelection(editableMarkdown, browserSelection, root)
      ?? findUniqueTextSelection(editableMarkdown, rendered);
    captureSelection(mapped ?? { prefix: '', selectedText: rendered, suffix: '', sourceMapped: false });
  }, [captureSelection, editableMarkdown, embeddable]);

  const changeEditorText = useCallback((value: string) => {
    setSelectionRequest(null);
    onEditorTextChange(embeddable ? normalizeEditableMarkdown(value) : value);
  }, [embeddable, onEditorTextChange]);

  useEffect(() => {
    if (preview.kind !== 'source' || props.sourceImageIndex === undefined || !previewRef.current) return;
    const container = previewRef.current;
    let target: HTMLImageElement | undefined;
    const scroll = () => target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const locate = () => {
      const image = container.querySelectorAll<HTMLImageElement>('img')[props.sourceImageIndex!];
      if (!image || !image.src.startsWith('data:')) return;
      target = image;
      target.addEventListener('load', scroll, { once: true });
      scroll();
      observer.disconnect();
    };
    const observer = new MutationObserver(locate);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    locate();
    return () => { observer.disconnect(); target?.removeEventListener('load', scroll); };
  }, [preview, props.sourceImageIndex]);

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={hasSelectedPage ? fileName(selectedPath) : t('content.selectPage')}
        subtitle={hasSelectedPage ? selectedPath : undefined}
        icon={FileText}
        meta={(
          <>
            {preview.kind !== 'empty' ? <Badge variant="secondary">{typeLabel(preview.contentType, preview.ext)}</Badge> : null}
            {size ? <span className="text-xs text-muted-foreground">{size}</span> : null}
            {busy ? <Badge variant="secondary">{busy}</Badge> : null}
          </>
        )}
        actions={(
          <>
            {embeddable ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => { setSelectionRequest(null); setLinksOpen(false); setEditing((value) => !value); }} disabled={busy !== null} className="h-8 rounded-full" aria-label={t(editing ? 'content.preview' : 'content.edit')}>
                {editing ? <Eye className="h-4 w-4" aria-hidden="true" /> : <Pencil className="h-4 w-4" aria-hidden="true" />}
                {t(editing ? 'content.preview' : 'content.edit')}
              </Button>
            ) : null}
            {embeddable ? <Button type="button" size="sm" variant="ghost" className="h-8 rounded-full" aria-pressed={linksOpen} onClick={() => { setSelectionRequest(null); setLinksOpen((value) => !value); }}><Link2 className="h-4 w-4" />{t('pageLinks.title')}</Button> : null}
            {editable ? <Button size="sm" variant="ghost" disabled={busy !== null} className="h-8 rounded-full" onClick={() => setHistoryOpen(true)}><Clock3 className="h-4 w-4" />{t('history.title', { defaultValue: '文件历史' })}</Button> : null}
            {editable ? (
              <Button size="sm" variant="ghost" onClick={onSave} disabled={busy !== null} className="h-8 rounded-full">
                <Save className="h-4 w-4" />
                {t('content.save')}
              </Button>
            ) : null}
            {embeddable ? (
              <WikiPrimaryButton size="sm" onClick={onEmbedPage} disabled={busy !== null}>
                <Sparkles className="h-4 w-4" />
                {t('content.embed')}
              </WikiPrimaryButton>
            ) : null}
          </>
        )}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div ref={previewRef} className="relative min-w-0 flex-1 overflow-hidden">
          {hasSelectedPage ? <PreviewBody preview={preview} editorText={editableMarkdown} editing={editing} resolveImageSrc={resolveImageSrc} onEditorTextChange={changeEditorText} onEditorSelection={captureEditorSelection} onTextSelection={captureRenderedSelection} /> : <EmptyState />}
          {embeddable && !selection && linksOpen ? <PageLinksPanel projectId={props.projectId} relativePath={selectedPath} busy={busy} unsaved={editorText !== preview.content} onOpenFile={props.onOpenFile} onCreated={props.onCreated} onClose={() => setLinksOpen(false)} /> : null}
        </div>
        {embeddable && selection ? <SelectionAssistantPanel key={selection.key} projectId={props.projectId} relativePath={selectedPath} selection={selection.snapshot} modelRef={props.modelRef} busy={busy} onPrepare={props.onSelectionPrepare} onApplied={props.onSelectionApplied} onOpenFile={props.onOpenFile} onClose={() => setSelectionRequest(null)} /> : null}
      </div>
      <Dialog.Root open={historyOpen} onOpenChange={setHistoryOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-40 flex h-[min(80dvh,760px)] w-[calc(100vw-2rem)] max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-elevated focus:outline-none" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">{t('history.title', { defaultValue: '文件历史' })}</Dialog.Title>
            <FileHistoryPanel projectId={props.projectId} path={selectedPath} currentContent={editorText} busy={busy} onRestored={props.onRestored} onClose={() => setHistoryOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WikiPanel>
  );
}
