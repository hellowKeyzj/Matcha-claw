import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { subscribeHostEvent } from '@/lib/host-events';
import { invokeIpc } from '@/lib/api-client';
import { isAppConfirmationRequest, type AppConfirmationRequest } from '@/types/desktop/app-plugin-sdk';

interface ConfirmationEvent {
  ownerId: string;
  requestId: string;
  pluginId: string;
  digest: string;
  pluginName: string;
  request?: AppConfirmationRequest;
}

export function AppPluginConfirmation({ pluginId, digest, container }: { pluginId: string; digest: string; container: React.RefObject<HTMLDivElement | null> }) {
  const { i18n, t } = useTranslation('common');
  const [pending, setPending] = useState<ConfirmationEvent | null>(null);
  const ownerId = useRef(crypto.randomUUID());
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const id = ownerId.current;
    let active = false;
    const invoke = (channel: string, input: unknown) => invokeIpc(channel, input);
    const visible = () => root.isConnected && !root.closest('[inert], [hidden]') && getComputedStyle(root).visibility === 'visible' && root.getBoundingClientRect().width > 0 && root.getBoundingClientRect().height > 0;
    const refresh = () => {
      const next = visible();
      if (next === active) return;
      active = next;
      if (!next) setPending(null);
      void invoke('app-plugins:confirmation-owner', { ownerId: id, pluginId, digest, active: next }).catch(() => {});
    };
    const unsubscribe = subscribeHostEvent<ConfirmationEvent>('app-plugins:confirmation', (event) => {
      if (event.ownerId !== id || event.pluginId !== pluginId || event.digest !== digest) return;
      if (!event.request) { setPending((value) => value?.requestId === event.requestId ? null : value); return; }
      if (!active || !visible() || !isAppConfirmationRequest(event.request)) {
        void invoke('app-plugins:confirmation-decide', { ownerId: id, requestId: event.requestId, allowed: false });
        return;
      }
      setPending(event);
    });
    const mutation = new MutationObserver(refresh);
    for (let node: Element | null = root; node; node = node.parentElement) mutation.observe(node, { attributes: true, attributeFilter: ['inert', 'hidden', 'style', 'class'] });
    const resize = new ResizeObserver(refresh);
    resize.observe(root);
    refresh();
    return () => {
      unsubscribe();
      mutation.disconnect();
      resize.disconnect();
      void invoke('app-plugins:confirmation-owner', { ownerId: id, pluginId, digest, active: false }).catch(() => {});
    };
  }, [pluginId, digest, container]);
  const decide = async (allowed: boolean) => {
    const value = pending;
    if (!value) return;
    const root = container.current;
    if (allowed && (!root?.isConnected || root.closest('[inert], [hidden]') || getComputedStyle(root).visibility !== 'visible'
      || root.getBoundingClientRect().width === 0 || root.getBoundingClientRect().height === 0
      || !document.hasFocus() || !navigator.userActivation?.isActive || document.visibilityState !== 'visible')) return;
    setPending(null);
    await invokeIpc('app-plugins:confirmation-decide', { ownerId: value.ownerId, requestId: value.requestId, allowed });
  };
  const sourceLabels: Record<string, string> = { en: 'Application', zh: '应用', ja: 'アプリ', ru: 'Приложение' };
  const request = pending?.request;
  const message = request ? `${sourceLabels[i18n.language.split('-')[0]] ?? sourceLabels.en}: ${pending.pluginName}\n\n${request.description}\n\n${request.details.map((detail) => `${detail.label}: ${detail.value}`).join('\n')}` : '';
  return <div className="[&_p]:max-h-[60vh] [&_p]:overflow-y-auto [&_p]:whitespace-pre-wrap [&_p]:break-words"
    onClickCapture={(event) => { if (!event.isTrusted) event.stopPropagation(); }}
    onKeyDownCapture={(event) => { if (!event.isTrusted) event.stopPropagation(); }}>
    <ConfirmDialog open={!!request} title={request?.title ?? ''} message={message} confirmLabel={request?.confirmLabel}
      cancelLabel={t('cancel')} onConfirm={() => decide(true)} onCancel={() => { void decide(false); }} />
  </div>;
}
