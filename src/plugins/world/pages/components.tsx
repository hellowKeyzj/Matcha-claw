import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import i18n from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Cell, Definition, Value } from '@/types/world';

export const selectClass = 'world-control h-9 min-w-0 max-w-full rounded-[7px] border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface))] px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/20 disabled:opacity-50';
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="world-field grid min-w-0 gap-1.5 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}
export function TextField({ label, value, onChange, placeholder, type = 'text', required = true }: {
  label: string; value: string; onChange(value: string): void; placeholder?: string; type?: string; required?: boolean;
}) {
  return <Field label={label}><Input className="h-9 text-sm" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} type={type} required={required} /></Field>;
}
export function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="world-section min-w-0"><header className="world-section-header mb-4 flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold tracking-tight">{title}</h2>{description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}</div>{action && <div className="flex min-w-0 flex-wrap items-center gap-2">{action}</div>}</header>{children}</section>;
}
export function Inspector({ title, description, onClose, children, className = '' }: { title: string; description?: string; onClose(): void; children: ReactNode; className?: string }) {
  const { t } = useTranslation('world');
  const titleId = useId();
  return <aside aria-labelledby={titleId} className={`world-inspector flex min-h-0 min-w-0 flex-col ${className}`}><header className="world-inspector-header flex shrink-0 items-start justify-between gap-3"><div className="min-w-0"><h2 id={titleId} className="break-words text-sm font-semibold">{title}</h2>{description && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>}</div><Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label={t('shared.close')} title={t('shared.close')}><X className="h-4 w-4" aria-hidden="true" /></Button></header><div className="world-inspector-body min-h-0 min-w-0 space-y-5">{children}</div></aside>;
}
export function Empty({ children, icon, title, description, action }: { children?: ReactNode; icon?: ReactNode; title?: string; description?: string; action?: ReactNode }) {
  return <div className="world-empty flex min-w-0 flex-col items-center px-6 py-12 text-center text-sm text-muted-foreground">{icon && <div className="mb-4 text-muted-foreground" aria-hidden="true">{icon}</div>}{title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}{description && <p className="mt-2 max-w-md leading-relaxed">{description}</p>}{children != null && <div className={title || description ? 'mt-2 max-w-md leading-relaxed' : 'max-w-md leading-relaxed'}>{children}</div>}{action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}</div>;
}
export function DataTable({ columns, rows, empty, rowKeys, selectedRowKey, onRowSelect }: {
  columns: string[]; rows: ReactNode[][]; empty?: string; rowKeys?: string[]; selectedRowKey?: string; onRowSelect?(key: string): void;
}) {
  const { t } = useTranslation('world');
  if (!rows.length) return <Empty>{empty ?? t('shared.empty')}</Empty>;
  return <div className="world-table min-w-0 max-w-full overflow-x-auto"><table className="w-full border-collapse text-left text-sm"><thead className="text-xs text-muted-foreground"><tr>{columns.map((column, index) => <th scope="col" className="h-10 whitespace-nowrap px-4 py-2 font-medium" key={index}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => {
    const key = rowKeys?.[index];
    const selected = key !== undefined && key === selectedRowKey;
    return <tr key={key ?? index} aria-selected={key === undefined ? undefined : selected} tabIndex={onRowSelect && key !== undefined ? 0 : undefined} className={`h-11 align-top ${onRowSelect && key !== undefined ? 'cursor-pointer' : ''}`} onClick={onRowSelect && key !== undefined ? event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || (event.target instanceof Element && event.target.closest('a,button,input,select,textarea,label,details,[role="button"],[role="link"],[contenteditable]'))) return;
      onRowSelect(key);
    } : undefined} onKeyDown={onRowSelect && key !== undefined ? event => {
      if (event.target !== event.currentTarget || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      onRowSelect(key);
    } : undefined}>{row.map((cell, index) => <td className="max-w-md break-words px-4 py-3" key={index}>{cell}</td>)}</tr>;
  })}</tbody></table></div>;
}
export function definitionName(definition: Definition): string {
  const body = definition.body.body;
  return 'name' in body ? body.name : definition.reference.id;
}
export function valueText(value: Value): string {
  if ('value' in value) return String(value.value);
  if (value.kind === 'null') return i18n.t('world:shared.value.null');
  return JSON.stringify(value);
}
export function cellText(cell: Cell): string {
  switch (cell.kind) {
    case 'known': return valueText(cell.value);
    case 'unknown': return i18n.t('world:shared.cell.unknown');
    case 'conflicted': return i18n.t('world:shared.cell.conflicted');
    case 'source_unavailable': return i18n.t('world:shared.cell.sourceUnavailable');
  }
}
export function SmallButton({ children, onClick, disabled = false }: { children: ReactNode; onClick(): void; disabled?: boolean }) {
  return <Button variant="outline" size="sm" className="h-8 rounded-[7px]" type="button" onClick={onClick} disabled={disabled}>{children}</Button>;
}
export function safeAction(action: () => Promise<unknown>): void { void action().catch(() => undefined); }
