import { useId, useState, type CSSProperties } from 'react';
import { ChevronDown, FileText, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ComposerContext } from '../composer-drafts';

export function ComposerContextChip({ context, onRemove, onPromptChange, busy = false }: { context: ComposerContext; onRemove(): void; onPromptChange?(text: string): void; busy?: boolean }) {
  const { t } = useTranslation('chat');
  const id = useId().replace(/:/g, '');
  const popoverId = `composer-context-${id}`;
  const anchorName = `--composer-context-${id}`;
  const [expanded, setExpanded] = useState(false);

  return <div className="inline-flex max-w-full items-center rounded-full border border-border/50 bg-background pr-1 text-xs">
    {context.prompt !== undefined ? <button
      type="button"
      popoverTarget={popoverId}
      style={{ anchorName } as CSSProperties}
      aria-expanded={expanded}
      aria-haspopup="dialog"
      aria-label={t('input.viewContext', { name: context.name })}
      title={context.name}
      className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-64 truncate font-medium">{context.name}</span>
      <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button> : <span className="inline-flex h-8 min-w-0 items-center gap-1.5 px-2.5 text-foreground">
      <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-64 truncate font-medium" title={context.name}>{context.name}</span>
    </span>}
    <button
      type="button"
      onClick={onRemove}
      aria-label={t('input.removeContext', { name: context.name })}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <X aria-hidden="true" className="h-3 w-3" />
    </button>
    {context.prompt !== undefined && <div
      id={popoverId}
      popover="auto"
      role="dialog"
      aria-labelledby={`${popoverId}-title`}
      onToggle={(event) => setExpanded(event.newState === 'open')}
      style={{ positionAnchor: anchorName, bottom: 'anchor(top)', left: 'anchor(left)', top: 'auto', right: 'auto', positionTryFallbacks: 'flip-block, flip-inline', margin: '8px 0' } as CSSProperties}
      className="fixed w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-popover p-0 text-popover-foreground shadow-elevated"
      data-chat-composer-wheel-local="true"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-2.5">
        <h3 id={`${popoverId}-title`} className="min-w-0 break-words text-sm font-medium">{context.name}</h3>
        <button type="button" popoverTarget={popoverId} popoverTargetAction="hide" aria-label={t('input.closeContext')} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && <label className="block space-y-2 p-4">
        <span className="text-xs font-medium">{t('input.editContextPrompt')}</span>
        <textarea value={context.prompt} onChange={(event) => onPromptChange?.(event.target.value)} disabled={busy} maxLength={32 * 1024}
          className="min-h-20 max-h-[50dvh] w-full resize-y rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>}
    </div>}
  </div>;
}
