import { useCallback, useEffectEvent, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { hostIabCommand } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import type { IabChoiceMenu, IabEvent } from '@/types/desktop/iab';

type MenuItem = { id: string; label: string; icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; selected?: boolean; badge?: string };
type MenuRequest = {
  id: string; scopeKey: string; anchor: IabChoiceMenu['anchor']; keyboard: boolean;
  items: readonly MenuItem[]; phase: 'preparing' | 'pending' | 'shown';
};

function iconData(element: Element | null | undefined): string | undefined {
  let data: string | undefined;
  if (element instanceof SVGSVGElement) {
    const svg = new XMLSerializer().serializeToString(element).replaceAll('currentColor', getComputedStyle(element).color);
    data = `data:image/svg+xml;base64,${btoa(Array.from(new TextEncoder().encode(svg), (byte) => String.fromCharCode(byte)).join(''))}`;
  } else if (element instanceof HTMLImageElement) data = element.currentSrc || element.src;
  return data && data.length < 100_000 && /^data:image\/(?:png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/i.test(data)
    && !data.endsWith(',') ? data : undefined;
}

export function WorkspaceMenu({ items, label, align, scopeKey, onSelect, children }: {
  items: readonly MenuItem[]; label: string; align: 'start' | 'end'; scopeKey: string;
  onSelect: (id: string) => void | Promise<void>; children: ReactNode;
}) {
  const { t, i18n } = useTranslation('workspace');
  const trigger = useRef<HTMLButtonElement>(null);
  const icons = useRef<HTMLSpanElement>(null);
  const active = useRef<MenuRequest | null>(null);
  const [request, setRequest] = useState<MenuRequest | null>(null);
  const updateRequest = useCallback((next: MenuRequest | null) => { active.current = next; setRequest(next); }, []);
  const selected = useEffectEvent((id: string) => {
    if (items.some((item) => item.id === id)) {
      void Promise.resolve().then(() => onSelect(id)).catch((error: unknown) => toast.error(error instanceof Error ? error.message : t('openFailed')));
    }
  });
  useLayoutEffect(() => {
    const unsubscribe = subscribeHostEvent<IabEvent>('iab:event', (event) => {
      const current = active.current;
      if (!current) return;
      if (event.type === 'choice-selected' && event.requestId === current.id && current.phase === 'shown') selected(event.id);
      if (event.type !== 'overlay-state') return;
      if (event.state?.kind === 'choices' && event.state.requestId === current.id) {
        updateRequest({ ...current, phase: 'shown' });
      } else if (current.phase === 'shown') {
        updateRequest(null);
        if (event.state === null && document.hasFocus()) trigger.current?.focus({ preventScroll: true });
      }
    });
    return () => {
      unsubscribe();
      const current = active.current;
      updateRequest(null);
      if (current && current.phase !== 'preparing') void hostIabCommand({ command: { action: 'dismiss-choices', requestId: current.id } }).catch(() => {});
    };
  }, [scopeKey, updateRequest]);
  useLayoutEffect(() => {
    if (!request || request.scopeKey !== scopeKey || request.phase !== 'preparing' || active.current !== request) return;
    const show = async () => {
      const menu: IabChoiceMenu = {
        requestId: request.id, anchor: request.anchor, align, keyboard: request.keyboard,
        items: request.items.map(({ icon: _Icon, ...item }, index) => {
          const icon = iconData(icons.current?.children[index]?.querySelector('svg, img'));
          return { ...item, ...(icon ? { icon } : {}) };
        }),
        initialPage: Math.floor(Math.max(0, request.items.findIndex((item) => item.selected)) / 40),
        labels: { empty: t('noLaunchers'), previous: t('previousPage'), next: t('nextPage'), page: t('menuPage', { current: '{current}', total: '{total}' }) },
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', locale: i18n.language,
      };
      updateRequest({ ...request, phase: 'pending' });
      const response = await hostIabCommand({ command: { action: 'show-choices', menu } });
      if (response.result.resultType === 'error') throw new Error(response.result.message);
      if (active.current?.id === request.id && active.current.phase === 'pending') updateRequest(null);
    };
    void show().catch((error: unknown) => {
      if (active.current?.id !== request.id) return;
      updateRequest(null);
      toast.error(error instanceof Error ? error.message : t('openFailed'));
    });
  }, [request, scopeKey, align, i18n.language, t, updateRequest]);
  const show = (keyboard: boolean) => {
    const current = active.current;
    if (current) {
      updateRequest(null);
      if (current.phase !== 'preparing') void hostIabCommand({ command: { action: 'dismiss-choices', requestId: current.id } }).catch(() => {});
      return;
    }
    const rect = trigger.current!.getBoundingClientRect();
    updateRequest({ id: crypto.randomUUID(), scopeKey, anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      keyboard, items, phase: 'preparing' });
  };
  return <>
    <Button ref={trigger} type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-md motion-reduce:transition-none"
      aria-label={label} title={label} aria-haspopup="menu" aria-expanded={request?.scopeKey === scopeKey && request.phase === 'shown'}
      onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); if (!active.current) show(true); } }}
      onClick={(event) => show(event.detail === 0)}>
      {children}
    </Button>
    {request?.scopeKey === scopeKey && request.phase === 'preparing' && <span ref={icons} hidden aria-hidden="true">
      {request.items.map(({ id, icon: Icon }) => <span key={id}>{Icon && <Icon aria-hidden={true} />}</span>)}
    </span>}
  </>;
}
