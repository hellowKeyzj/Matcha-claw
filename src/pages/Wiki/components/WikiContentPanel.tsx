import { type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Save, Sparkles } from 'lucide-react';
import { MarkdownPreview } from '@/components/file-preview/MarkdownPreview';
import { HtmlPreview } from '@/components/file-preview/HtmlPreview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { FileContentType } from '@/lib/generated-files';
import { fileName, typeLabel } from '../preview';
import { formatFileSize } from '../wiki-model';
import { WikiPanel, WikiPanelHeader, WikiPrimaryButton } from './WikiChrome';

export type WikiContentPreview = Readonly<
  | { kind: 'empty' }
  | { kind: 'text'; path: string; contentType: FileContentType; ext: string; mimeType: string; content: string }
  | { kind: 'source'; path: string; contentType: FileContentType; ext: string; mimeType: string; content: string }
  | { kind: 'binary'; path: string; contentType: FileContentType; ext: string; mimeType: string; name: string; data: string; size: number }
  | { kind: 'unsupported'; path: string; contentType: FileContentType; ext: string; mimeType: string }
  | { kind: 'error'; path: string; contentType: FileContentType; ext: string; mimeType: string; message: string }
>;

export type WikiContentPanelProps = Readonly<{
  selectedPath: string;
  preview: WikiContentPreview;
  editorText: string;
  busy: string | null;
  resolveImageSrc?(src: string, filePath: string): Promise<string | null> | string | null;
  onEditorTextChange(value: string): void;
  onSave(): void;
  onEmbedPage(): void;
}>;

function binarySource(preview: Extract<WikiContentPreview, { kind: 'binary' }>): string {
  return `data:${preview.mimeType};base64,${preview.data}`;
}

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

function EditorTextArea(props: Readonly<{ value: string; onChange(value: string): void; className?: string }>): JSX.Element {
  return (
    <Textarea
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      className={`h-full min-h-[500px] resize-none rounded-none border-0 bg-transparent p-6 font-mono text-sm leading-6 shadow-none focus-visible:ring-0 ${props.className ?? ''}`}
      spellCheck={false}
    />
  );
}

function MarkdownDocument(props: Readonly<{ path: string; content: string; resolveImageSrc?: WikiContentPanelProps['resolveImageSrc'] }>): JSX.Element {
  return <MarkdownPreview filePath={props.path} markdown={props.content} resolveImageSrc={props.resolveImageSrc} />;
}

function PreviewBody(props: Readonly<{
  preview: WikiContentPreview;
  editorText: string;
  resolveImageSrc?: WikiContentPanelProps['resolveImageSrc'];
  onEditorTextChange(value: string): void;
}>): JSX.Element {
  const { t } = useTranslation('wiki');
  const { preview, editorText, resolveImageSrc, onEditorTextChange } = props;
  const unsupportedTitle = t('content.inlineUnsupported');
  const unsupportedDescription = (contentType: FileContentType, ext: string) => t('content.inlineUnsupportedDescription', { type: typeLabel(contentType, ext) });

  if (preview.kind === 'empty') return <EmptyState />;
  if (preview.kind === 'error') return <Notice title={t('content.previewUnavailable')} description={preview.message} />;
  if (preview.kind === 'unsupported') return <Notice title={unsupportedTitle} description={unsupportedDescription(preview.contentType, preview.ext)} />;
  if (preview.kind === 'source') return <MarkdownDocument path={preview.path} content={preview.content} resolveImageSrc={resolveImageSrc} />;

  if (preview.kind === 'binary') {
    const src = binarySource(preview);
    if (preview.contentType === 'image') {
      return (
        <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-secondary/20 p-6">
          <img src={src} alt={preview.name} className="max-h-full max-w-full rounded-2xl border border-border/70 bg-card shadow-sm" />
        </div>
      );
    }
    if (preview.contentType === 'pdf') {
      return <iframe title={preview.name} src={`${src}#toolbar=0&navpanes=0&scrollbar=1&view=FitH`} className="h-full min-h-[500px] w-full border-0 bg-white" />;
    }
    if (preview.contentType === 'audio') {
      return (
        <div className="flex h-full min-h-0 items-center justify-center p-6">
          <audio controls src={src} className="w-full max-w-xl" />
        </div>
      );
    }
    if (preview.contentType === 'video') {
      return (
        <div className="flex h-full min-h-0 items-center justify-center bg-black p-6">
          <video controls src={src} className="max-h-full max-w-full rounded-2xl" />
        </div>
      );
    }
    return <Notice title={unsupportedTitle} description={unsupportedDescription(preview.contentType, preview.ext)} />;
  }

  if (preview.contentType === 'markdown') {
    return (
      <div className="grid h-full min-h-0 md:grid-cols-2">
        <EditorTextArea value={editorText} onChange={onEditorTextChange} className="border-r border-border/70" />
        <div className="min-h-0 overflow-auto bg-background">
          <MarkdownDocument path={preview.path} content={editorText} resolveImageSrc={resolveImageSrc} />
        </div>
      </div>
    );
  }

  if (preview.contentType === 'html') {
    return (
      <div className="grid h-full min-h-0 md:grid-cols-2">
        <EditorTextArea value={editorText} onChange={onEditorTextChange} className="border-r border-border/70" />
        <div className="min-h-0 overflow-auto bg-background">
          <HtmlPreview fileName={fileName(preview.path)} source={editorText} className="h-full min-h-[500px]" />
        </div>
      </div>
    );
  }

  return <EditorTextArea value={editorText} onChange={onEditorTextChange} />;
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
      <div className="min-h-0 flex-1 overflow-hidden">
        {hasSelectedPage ? <PreviewBody preview={preview} editorText={editorText} resolveImageSrc={resolveImageSrc} onEditorTextChange={onEditorTextChange} /> : <EmptyState />}
      </div>
    </WikiPanel>
  );
}
