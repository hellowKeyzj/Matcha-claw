import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, File, FileArchive, FileText, Film, Folder, Loader2, Music, ZoomIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { invokeIpc } from '@/lib/api-client';
import { hostWorkspaceMediaPlayback, hostWorkspaceMediaResolve } from '@/lib/host-api';
import { DIRECTORY_MIME_TYPE } from '@/plugins/files/types';
import { artifactFileErrorMessage } from '@/plugins/files/open-file-utils';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { AttachedFileMeta } from './attachments';
import type { ChatMessageImage } from './chat-message-view';

export interface MessageLightboxState {
  src: string;
  fileName: string;
  filePath?: string;
  mediaReference?: string;
  base64?: string;
  mimeType?: string;
}

interface MessageMediaProps {
  images: ReadonlyArray<ChatMessageImage>;
  attachedFiles: ReadonlyArray<AttachedFileMeta>;
  sessionIdentity?: SessionIdentity;
  onPreview: (item: MessageLightboxState) => void;
  onOpenFile?: (file: AttachedFileMeta) => boolean | void;
}

export function UserMessageMedia(props: MessageMediaProps) {
  return <MessageMedia {...props} isUser />;
}

export function AssistantMessageMedia(props: MessageMediaProps) {
  return <MessageMedia {...props} />;
}

function MessageMedia({ images, attachedFiles, sessionIdentity, onPreview, onOpenFile, isUser = false }: MessageMediaProps & { isUser?: boolean }) {
  const attachmentImageSources = new Set(attachedFiles.flatMap((file) => file.mimeType.startsWith('image/')
    ? [file.preview, file.gatewayUrl].filter((src): src is string => !!src) : []));
  const seenImages = new Set<string>();
  const seenAttachments = new Set<string>();
  return (
    <>
      {images.length > 0 && <div className="flex flex-wrap gap-2.5">
        {images.map((image, index) => {
          const src = image.url || (image.data ? `data:${image.mimeType};base64,${image.data}` : null);
          if (!src || attachmentImageSources.has(src) || seenImages.has(src)) return null;
          seenImages.add(src);
          return <ImageCard key={src + index} src={src} fileName="image" isUser={isUser}
            onPreview={() => onPreview({ src, fileName: 'image', base64: image.data, mimeType: image.mimeType })} />;
        })}
      </div>}
      {attachedFiles.length > 0 && <div className="flex flex-wrap gap-2.5">
        {attachedFiles.map((file, index) => {
          const identity = file.resourceId || file.mediaReference || file.filePath || file.gatewayUrl;
          if (identity && seenAttachments.has(identity)) return null;
          if (identity) seenAttachments.add(identity);
          return <MediaAttachment key={JSON.stringify([sessionIdentity, file.mediaReference, file.filePath, file.gatewayUrl, identity ?? index])}
            file={file} sessionIdentity={sessionIdentity} isUser={isUser} onPreview={onPreview} onOpenFile={onOpenFile} />;
        })}
      </div>}
    </>
  );
}

function MediaAttachment({ file, sessionIdentity, isUser, onPreview, onOpenFile }: {
  file: AttachedFileMeta;
  sessionIdentity?: SessionIdentity;
  isUser: boolean;
  onPreview: MessageMediaProps['onPreview'];
  onOpenFile: MessageMediaProps['onOpenFile'];
}) {
  const { t } = useTranslation('chat');
  const isImage = file.mimeType.startsWith('image/');
  const isPlayer = /^(?:audio|video)\//.test(file.mimeType);
  const [media, setMedia] = useState<{ url: string; failed: boolean } | null>(null);
  useEffect(() => {
    if (!isPlayer || !file.mediaReference || !sessionIdentity) return;
    let active = true;
    let url: string | undefined;
    void hostWorkspaceMediaPlayback({ reference: file.mediaReference, sessionIdentity }).then((blob) => {
      if (!active) return;
      url = URL.createObjectURL(blob);
      setMedia({ url, failed: false });
    }).catch(() => { if (active) setMedia({ url: '', failed: true }); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [file.mediaReference, file.mimeType, isPlayer, sessionIdentity]);

  if (isPlayer && (file.mediaReference && sessionIdentity || file.gatewayUrl && !file.gatewayUrl.startsWith('/'))) {
    const src = media?.url || (!file.mediaReference ? file.gatewayUrl : undefined);
    if (media?.failed) return <FileCard file={{ ...file, previewStatus: 'unavailable' }} sessionIdentity={sessionIdentity} onOpen={onOpenFile} />;
    if (!src) return <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('media.loading')}</div>;
    return <div className="flex max-w-full items-end gap-1">
      {file.mimeType.startsWith('audio/')
        ? <audio controls preload="metadata" src={src} aria-label={file.fileName} onError={() => setMedia({ url: '', failed: true })} />
        : <video controls preload="metadata" src={src} aria-label={file.fileName} className="max-h-96 max-w-full rounded-xl" onError={() => setMedia({ url: '', failed: true })} />}
      {file.mediaReference && sessionIdentity && <FileCard file={file} sessionIdentity={sessionIdentity} downloadOnly />}
    </div>;
  }
  if (isImage && file.preview) {
    return <ImageCard key={file.preview} src={file.preview} fileName={file.fileName} isUser={isUser}
      unavailable={<FileCard file={{ ...file, previewStatus: 'unavailable' }} sessionIdentity={sessionIdentity} onOpen={onOpenFile} />} onPreview={() => {
      if (file.filePath && !file.mediaReference && onOpenFile) { onOpenFile(file); return; }
      onPreview({ src: file.preview!, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType, mediaReference: file.mediaReference });
    }} />;
  }
  if (isImage && !file.filePath && file.previewStatus !== 'unavailable') return <MissingImagePreview />;
  return <FileCard file={file} sessionIdentity={sessionIdentity} onOpen={onOpenFile} />;
}

function FileIcon({ mimeType }: { mimeType: string }) {
  const Icon = mimeType === DIRECTORY_MIME_TYPE ? Folder : mimeType.startsWith('video/') ? Film
    : mimeType.startsWith('audio/') ? Music : mimeType.startsWith('text/') || mimeType === 'application/pdf' ? FileText
      : /zip|compressed|archive|tar|rar|7z/.test(mimeType) ? FileArchive : File;
  return <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileCard({ file, sessionIdentity, onOpen, downloadOnly = false }: {
  file: AttachedFileMeta;
  sessionIdentity?: SessionIdentity;
  onOpen?: (file: AttachedFileMeta) => boolean | void;
  downloadOnly?: boolean;
}) {
  const { t } = useTranslation('chat');
  const [loading, setLoading] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const remote = file.gatewayUrl && /^https?:\/\//.test(file.gatewayUrl) ? file.gatewayUrl : null;
  const canOpen = !!file.filePath || !!remote || !!file.mediaReference && !!sessionIdentity;
  const source = file.source === 'user-upload' ? t('media.uploaded') : file.source === 'tool-result' ? t('media.toolResult')
    : file.source === 'message-ref' ? t('media.messageReference') : null;
  const base = file.fileSize > 0 ? formatFileSize(file.fileSize) : t(file.mimeType === DIRECTORY_MIME_TYPE ? 'media.folder' : 'media.file');
  const detail = file.previewStatus === 'unavailable' ? t('media.previewUnavailable') : source ? `${source} · ${base}` : base;
  const open = async (downloadOnly = false) => {
    if (loading) return;
    setLoading(true);
    try {
      if (file.mediaReference && sessionIdentity) {
        if (!downloadOnly && onOpen?.(file) === true) return;
        const blob = await hostWorkspaceMediaResolve({ reference: file.mediaReference, sessionIdentity });
        if (!active.current) return;
        const url = URL.createObjectURL(new Blob([blob], { type: file.mimeType }));
        const anchor = document.createElement('a');
        try {
          anchor.href = url;
          anchor.download = file.fileName;
          document.body.appendChild(anchor);
          anchor.click();
        } finally { anchor.remove(); URL.revokeObjectURL(url); }
      } else if (file.filePath) {
        if (onOpen) onOpen(file);
        else {
          const error = await invokeIpc<string>('shell:openPath', file.filePath);
          if (error) throw new Error(error);
        }
      } else if (remote) await invokeIpc('shell:openExternal', remote);
    } catch (error) {
      if (!active.current) return;
      toast.error(t('artifacts.openFailed', { error: artifactFileErrorMessage(error, t) }), {
        description: t('artifacts.fileOpenRecovery'),
      });
    } finally { setLoading(false); }
  };
  const downloadButton = file.mediaReference && sessionIdentity ? <button type="button" disabled={loading} onClick={() => { void open(true); }}
    title={t('media.download')} aria-label={`${t('media.download')} · ${file.fileName}`}
    className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
    {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Download className="h-4 w-4" aria-hidden="true" />}
  </button> : null;
  if (downloadOnly) return downloadButton;
  const contents = <><FileIcon mimeType={file.mimeType} /><div className="min-w-0 overflow-hidden">
    <p className="truncate text-xs font-medium">{file.fileName}</p>
    <p className="truncate text-[10px] text-muted-foreground">{detail}</p>
  </div>{loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}</>;
  const className = 'flex max-w-[220px] items-center gap-2 rounded-[16px] border border-border/42 bg-card px-3 py-2 text-left shadow-sm';
  if (!canOpen) return <div className={className}>{contents}</div>;
  return <div className="flex items-center gap-1">
    <button type="button" data-testid="chat-attached-file-card" data-chat-attached-file-path={file.filePath}
      data-chat-attached-file-name={file.fileName} disabled={loading} aria-busy={loading} onClick={() => { void open(); }}
      title={file.filePath || file.fileName}
      className={`${className} transition-colors hover:bg-background/95`}>{contents}</button>
    {downloadButton}
  </div>;
}

function MissingImagePreview({ unavailable = false }: { unavailable?: boolean }) {
  const { t } = useTranslation('chat');
  return <div data-testid={unavailable ? 'chat-image-preview-unavailable' : 'chat-missing-image-preview'}
    className="flex h-36 w-36 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border bg-muted text-muted-foreground">
    {unavailable ? <File className="h-8 w-8" /> : <Loader2 className="h-6 w-6 animate-spin" />}
    <span className="px-3 text-center text-[11px] leading-4">{t(unavailable ? 'media.imageUnavailable' : 'media.imageLoading')}</span>
  </div>;
}

function ImageCard({ src, fileName, isUser, onPreview, unavailable }: { src: string; fileName: string; isUser: boolean; onPreview: () => void; unavailable?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return unavailable ?? <MissingImagePreview unavailable />;
  return <button type="button" onClick={onPreview} aria-label={fileName}
    className={`group/img relative cursor-zoom-in overflow-hidden rounded-[18px] border border-border/42 bg-card shadow-sm ${isUser ? 'h-36 w-36' : 'max-w-xs'}`}>
    <img src={src} alt={fileName} onError={() => setFailed(true)} className={isUser ? 'h-full w-full object-cover' : 'block w-full'} />
    <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/img:bg-black/20">
      <ZoomIn className="h-6 w-6 text-white opacity-0 drop-shadow transition-opacity group-hover/img:opacity-100" />
    </span>
  </button>;
}
