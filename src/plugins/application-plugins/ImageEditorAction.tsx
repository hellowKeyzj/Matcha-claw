import { useLayoutEffect, useRef, useState } from 'react';
import { Loader2, PenTool } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { hostAppPluginCall } from '@/lib/host-api';
import { resolveSupportedLanguage } from '@/i18n/language';
import { usePluginHost } from '@/plugin-host/react';
import { selectChatSelection } from '@/plugins/chat/chat-session';
import { useChatStore, type ChatStoreState } from '@/plugins/chat/store';
import { openChatPanel } from '@/plugins/chat/workspace-actions';
import { imagePreviewActions, type ImagePreviewAction, type ImagePreviewActionProps } from '@/plugins/message-rendering/extensions';
import { sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity } from '@/types/desktop/runtime-address';

interface ImageEditorActionProps extends ImagePreviewActionProps {
  pluginId: string;
  digest: string;
  panelId: string;
  label: string;
  translations?: Readonly<Record<string, string>>;
  tool: string;
  action: ImagePreviewAction;
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function isSelectedSession(state: ChatStoreState, identity?: SessionIdentity): identity is SessionIdentity {
  if (!identity || validateSessionIdentity(identity)) return false;
  const { currentConversation, currentWorkspaceIdentity } = selectChatSelection(state);
  return currentConversation?.kind === 'session' && !!currentWorkspaceIdentity
    && sessionIdentitiesEqual(identity, currentWorkspaceIdentity);
}

async function readPreviewImage(src: string, signal: AbortSignal, t: TFunction<'common'>): Promise<{ mimeType: string; data: string }> {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(t('imagePreview.readFailed'));
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!/^image\/[a-z0-9.+-]+$/.test(mimeType)) throw new Error(t('imagePreview.invalidImage'));
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error(t('imagePreview.tooLarge'));
  if (!response.body) throw new Error(t('imagePreview.emptyImage'));
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error(t('imagePreview.tooLarge'));
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!size) throw new Error(t('imagePreview.emptyImage'));
  signal.throwIfAborted();
  const blob = new Blob(chunks, { type: mimeType });
  chunks.length = 0;
  const data = await new Promise<string>((resolve, reject) => {
    const fileReader = new FileReader();
    const abort = () => fileReader.abort();
    fileReader.onload = () => resolve((fileReader.result as string).split(',')[1]!);
    fileReader.onerror = () => reject(new Error(t('imagePreview.conversionFailed')));
    fileReader.onabort = () => reject(signal.reason);
    fileReader.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    fileReader.readAsDataURL(blob);
  });
  return { mimeType, data };
}

export function ImageEditorAction({ src, fileName, sessionIdentity, onClose, pluginId, digest, panelId, label, translations, tool, action }: ImageEditorActionProps) {
  const { t, i18n } = useTranslation('common');
  const actionLabel = translations?.[resolveSupportedLanguage(i18n.resolvedLanguage)] ?? label;
  const host = usePluginHost();
  const eligible = useChatStore((state) => isSelectedSession(state, sessionIdentity));
  const pending = useRef<AbortController | null>(null);
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current?.abort();
      pending.current = null;
    };
  }, []);

  const editImage = async () => {
    if (pending.current || !active.current || !host.get(imagePreviewActions).includes(action)) return;
    if (!isSelectedSession(useChatStore.getState(), sessionIdentity)) {
      setMessage(t('imagePreview.sessionMismatch'));
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage(null);
    const isCurrent = () => active.current && pending.current === controller && host.get(imagePreviewActions).includes(action);
    const timeout = window.setTimeout(() => controller.abort(new Error(t('imagePreview.readTimeout'))), 30_000);
    try {
      const image = await readPreviewImage(src, controller.signal, t).finally(() => window.clearTimeout(timeout));
      if (!isCurrent()) return;
      if (!isSelectedSession(useChatStore.getState(), sessionIdentity)) throw new Error(t('imagePreview.sessionChanged'));
      // Only the image read is abortable here; Main owns the accepted plugin operation.
      const result = await hostAppPluginCall({ id: pluginId, digest, name: tool, arguments: { name: fileName, mimeType: image.mimeType, data: image.data, sessionIdentity } });
      if (!isCurrent()) return;
      if (result.isError) {
        const detail = result.content.find((part) => part.type === 'text' && typeof part.text === 'string')?.text;
        throw new Error(typeof detail === 'string' ? t('imagePreview.editorFailedDetail', { detail: detail.slice(0, 400) }) : t('imagePreview.editorFailed'));
      }
      if (!isSelectedSession(useChatStore.getState(), sessionIdentity)) {
        setMessage(t('imagePreview.savedToOriginalSession'));
        return;
      }
      openChatPanel({ id: panelId, sessionIdentity });
      onClose();
    } catch (error) {
      if (isCurrent()) {
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        setMessage(failure instanceof Error ? failure.message : t('imagePreview.openFailed'));
      }
    } finally {
      window.clearTimeout(timeout);
      controller.abort();
      if (isCurrent()) {
        pending.current = null;
        setBusy(false);
      }
    }
  };

  return <div className="flex max-w-80 flex-col items-center gap-2">
    <Button type="button" size="sm" className="h-9 rounded-full bg-emerald-700 px-4 text-white hover:bg-emerald-800 motion-reduce:transition-none" disabled={busy || !eligible} aria-busy={busy} title={eligible ? actionLabel : t('imagePreview.requiresSession')} onClick={() => { void editImage(); }}>
      {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <PenTool aria-hidden="true" className="h-4 w-4" />}
      {busy ? t('imagePreview.opening') : actionLabel}
    </Button>
    {message && <p role="status" className="max-w-80 whitespace-normal text-center text-xs text-white/90">{message}</p>}
  </div>;
}
