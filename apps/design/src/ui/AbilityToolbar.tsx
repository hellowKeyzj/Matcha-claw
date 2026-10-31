import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useTranslation } from './i18n';

export type Ability = {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
} & ({ onClick(): void; children?: never } | { children: Ability[]; onClick?: never });

export function AbilityToolbar({ items, extras = [], pinned, width, label, bottom }: {
  items: Ability[]; extras?: Ability[]; pinned?: ReactNode; width: number; label: string; bottom?: boolean;
}) {
  const { t } = useTranslation();
  const measure = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [visible, setVisible] = useState(items.length);
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<Ability | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const element = measure.current!;
    const update = () => {
      const buttons = [...element.querySelectorAll<HTMLElement>('[data-ability]')];
      const pinnedWidth = element.querySelector<HTMLElement>('[data-pinned]')!.getBoundingClientRect().width;
      const moreWidth = element.querySelector<HTMLElement>('[data-more]')!.getBoundingClientRect().width;
      let used = pinnedWidth + 8;
      let count = 0;
      for (const [index, button] of buttons.entries()) {
        const next = used + button.getBoundingClientRect().width + 4;
        if (next + (extras.length || index < buttons.length - 1 ? moreWidth + 4 : 0) > width) break;
        used = next;
        count += 1;
      }
      setVisible(count);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [items, extras.length, width]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const button = anchor.current ?? trigger.current!;
      const popup = menu.current!;
      const box = button.getBoundingClientRect();
      const top = bottom ? box.top - popup.offsetHeight - 8 : box.bottom + 8;
      popup.style.left = `${Math.max(8, Math.min(box.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
      popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - popup.offsetHeight - 8))}px`;
    };
    const observer = new ResizeObserver(position);
    observer.observe(menu.current!);
    observer.observe(anchor.current ?? trigger.current!);
    window.addEventListener('resize', position);
    position();
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [open, bottom, width, visible, group]);
  const hidden = items.slice(visible);
  const button = (item: Ability, measuring = false) => <button key={item.id} data-ability={measuring ? '' : undefined} className="ic-tool-btn" type="button" disabled={item.disabled} title={item.label} popoverTarget={!measuring && item.children ? menuId : undefined} popoverTargetAction="show" aria-expanded={!measuring && item.children ? open && group?.id === item.id : undefined} onClick={measuring ? undefined : item.children ? (event) => { anchor.current = event.currentTarget; setGroup(item); } : item.onClick} tabIndex={measuring ? -1 : undefined}>{item.icon}<span>{item.label}</span>{item.children && <ChevronDown size={12} />}</button>;
  const menuItem = (item: Ability): ReactNode => item.children
    ? <details className="ic-ability-group" key={item.id}><summary>{item.icon}{item.label}<ChevronRight size={12} /></summary>{item.children.map(menuItem)}</details>
    : <button type="button" className="ic-overflow-menu-btn" key={item.id} disabled={item.disabled} onClick={() => { menu.current?.hidePopover(); item.onClick(); }}>{item.icon}{item.label}</button>;
  return <div className={`ic-toolbar ic-toolbar--default${bottom ? ' ic-business-toolbar' : ''}`} role="toolbar" aria-label={label} style={{ maxWidth: width }}>
    {items.slice(0, visible).map((item) => button(item))}
    <div className="ic-more">
      {(hidden.length > 0 || extras.length > 0) && <button ref={trigger} type="button" className="ic-tool-btn" popoverTarget={menuId} popoverTargetAction="show" aria-label={t('更多{label}', { label })} title={t('更多')} aria-expanded={open && !group} onClick={(event) => { anchor.current = event.currentTarget; setGroup(null); }}><MoreHorizontal size={18} /></button>}
      <div ref={menu} id={menuId} popover="auto" className="ic-overflow-menu" aria-label={t('更多{label}', { label })} onToggle={(event) => setOpen(event.newState === 'open')} onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),summary')].filter((element) => element.getClientRects().length);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>{(group?.children ?? [...hidden, ...extras]).map(menuItem)}</div>
    </div>
    {pinned}
    <div ref={measure} className="ic-ability-measure" aria-hidden="true" inert>{items.map((item) => button(item, true))}<span data-more className="ic-tool-btn"><MoreHorizontal size={18} /></span><div data-pinned className="ic-measured-pinned">{pinned}</div></div>
  </div>;
}
