import type { JSX } from 'react';
import { MarkdownPreview as FileMarkdownPreview } from '@/plugins/files/MarkdownPreview';
import { HtmlPreview as FileHtmlPreview } from '@/plugins/files/HtmlPreview';
import { Textarea } from '@/components/ui/textarea';
import type { WikiContentPreviewProps } from '../extensions';
import type { WikiContentPreview } from './WikiContentPanel';
import { fileName } from '../preview';

function binarySource(preview: Extract<WikiContentPreview, { kind: 'binary' }>): string {
  return `data:${preview.mimeType};base64,${preview.data}`;
}

function EditorTextArea(props: Readonly<{ value: string; onChange(value: string): void; onSelect?(markdown: string, start: number, end: number): void; className?: string }>): JSX.Element {
  return (
    <Textarea
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onSelect={props.onSelect ? (event) => props.onSelect!(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd) : undefined}
      className={`h-full min-h-[500px] resize-none rounded-none border-0 bg-transparent p-6 font-mono text-sm leading-6 shadow-none focus-visible:ring-0 ${props.className ?? ''}`}
      spellCheck={false}
    />
  );
}

function MarkdownDocument(props: Readonly<{ path: string; content: string; resolveImageSrc?: WikiContentPreviewProps['resolveImageSrc']; onTextSelection?(selection: Selection | null, root: HTMLDivElement): void }>): JSX.Element {
  return <FileMarkdownPreview filePath={props.path} markdown={props.content} resolveImageSrc={props.resolveImageSrc} sourceMapping={Boolean(props.onTextSelection)} onTextSelection={props.onTextSelection} />;
}

export function SourcePreview({ preview, resolveImageSrc }: WikiContentPreviewProps): JSX.Element | null {
  if (preview.kind !== 'source') return null;
  return <MarkdownDocument path={preview.path} content={preview.content} resolveImageSrc={resolveImageSrc} />;
}

export function ImagePreview({ preview }: WikiContentPreviewProps): JSX.Element | null {
  if (preview.kind !== 'binary') return null;
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-secondary/20 p-6">
      <img src={binarySource(preview)} alt={preview.name} className="max-h-full max-w-full rounded-2xl border border-border/70 bg-card shadow-sm" />
    </div>
  );
}

export function PdfPreview({ preview }: WikiContentPreviewProps): JSX.Element | null {
  if (preview.kind !== 'binary') return null;
  return <iframe title={preview.name} src={`${binarySource(preview)}#toolbar=0&navpanes=0&scrollbar=1&view=FitH`} className="h-full min-h-[500px] w-full border-0 bg-white" />;
}

export function AudioPreview({ preview }: WikiContentPreviewProps): JSX.Element | null {
  if (preview.kind !== 'binary') return null;
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <audio controls src={binarySource(preview)} className="w-full max-w-xl" />
    </div>
  );
}

export function VideoPreview({ preview }: WikiContentPreviewProps): JSX.Element | null {
  if (preview.kind !== 'binary') return null;
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-black p-6">
      <video controls src={binarySource(preview)} className="max-h-full max-w-full rounded-2xl" />
    </div>
  );
}

export function MarkdownPreview({ preview, editorText, editing, resolveImageSrc, onEditorTextChange, onEditorSelection, onTextSelection }: WikiContentPreviewProps): JSX.Element | null {
  if (preview.kind !== 'text') return null;
  return editing
    ? <EditorTextArea value={editorText} onChange={onEditorTextChange} onSelect={onEditorSelection} />
    : <MarkdownDocument path={preview.path} content={editorText} resolveImageSrc={resolveImageSrc} onTextSelection={onTextSelection} />;
}

export function HtmlPreview({ preview, editorText, onEditorTextChange }: WikiContentPreviewProps): JSX.Element | null {
  if (preview.kind !== 'text') return null;
  return (
    <div className="grid h-full min-h-0 md:grid-cols-2">
      <EditorTextArea value={editorText} onChange={onEditorTextChange} className="border-r border-border/70" />
      <div className="min-h-0 overflow-auto bg-background">
        <FileHtmlPreview fileName={fileName(preview.path)} source={editorText} className="h-full min-h-[500px]" />
      </div>
    </div>
  );
}

export function TextPreview({ editorText, onEditorTextChange }: WikiContentPreviewProps): JSX.Element {
  return <EditorTextArea value={editorText} onChange={onEditorTextChange} />;
}
