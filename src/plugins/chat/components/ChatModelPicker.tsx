import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Check, ChevronDown, Search, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '@/plugins/chat/chat-layout-tokens';
import '@/plugins/chat/components/chat-input.css';

export interface ModelPickerOption {
  id: string;
  label: string;
  provider?: string;
  groupId?: string;
  disabled?: boolean;
  description?: string;
}

export interface ThinkingPickerState {
  currentId: string | null;
  label: string;
  options: { id: string; label: string }[];
  loading: boolean;
  switching: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onReset?: () => void;
}

export interface ModelPickerState {
  currentModelId: string;
  currentLabel: string;
  options: ModelPickerOption[];
  loading: boolean;
  switching: boolean;
  disabled?: boolean;
  onSelect: (modelId: string) => void;
  thinking?: ThinkingPickerState | null;
}

function ThinkingPicker({ state }: { state: ThinkingPickerState }) {
  const { t } = useTranslation('chat');
  const [preview, setPreview] = useState<{
    id: string; currentId: string | null; options: ThinkingPickerState['options'];
  } | null>(null);
  const interactingRef = useRef(false);
  const disabled = state.disabled || state.loading || state.switching;
  const previewId = preview && preview.currentId === state.currentId && preview.options === state.options && !disabled ? preview.id : null;
  if (preview && previewId === null) setPreview(null);
  useLayoutEffect(() => {
    interactingRef.current = false;
  }, [state.currentId, state.options, state.loading, state.switching, state.disabled]);
  const currentIndex = state.options.findIndex((option) => option.id === (previewId ?? state.currentId));
  const label = previewId ? state.options.find((option) => option.id === previewId)?.label : state.label;
  const selectionKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
  const clearPreview = () => { interactingRef.current = false; setPreview(null); };
  const commit = (input: HTMLInputElement) => {
    const interacting = interactingRef.current;
    const option = state.options[input.valueAsNumber];
    clearPreview();
    if (interacting && !disabled && option.id !== state.currentId) state.onSelect(option.id);
  };

  return (
    <div className="shrink-0 border-t border-border/60 px-4 py-3" aria-busy={state.loading || state.switching}>
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{t('input.thinkingIntensity')}</span>
        <span className="min-w-0 truncate font-medium" aria-live="polite" title={label}>{label}</span>
      </div>
      {state.options.length > 0 ? (
        <input
          type="range"
          className="chat-thinking-range mt-3 w-full"
          data-unpositioned={currentIndex < 0 || undefined}
          min={0}
          max={state.options.length - 1}
          step={1}
          value={currentIndex < 0 ? '' : currentIndex}
          disabled={disabled}
          aria-label={t('input.thinkingIntensity')}
          aria-valuetext={label}
          onChange={(event) => {
            const option = state.options[event.currentTarget.valueAsNumber];
            setPreview({ id: option.id, currentId: state.currentId, options: state.options });
          }}
          onPointerDown={(event) => {
            interactingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => commit(event.currentTarget)}
          onPointerCancel={clearPreview}
          onBlur={clearPreview}
          onKeyDown={(event) => {
            if (selectionKeys.includes(event.key)) interactingRef.current = true;
          }}
          onKeyUp={(event) => {
            if (selectionKeys.includes(event.key)) commit(event.currentTarget);
          }}
        />
      ) : null}
      {state.onReset ? <Button type="button" variant="ghost" disabled={disabled}
        className="mt-2 h-7 max-w-full px-2 text-xs" onClick={state.onReset}>
        <span className="truncate">{t('input.thinkingReset')}</span>
      </Button> : null}
    </div>
  );
}

export const ChatModelPicker = memo(function ChatModelPicker({ state, open, onOpenChange, scopeKey, composerAnchorName }: {
  state: ModelPickerState;
  composerAnchorName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopeKey: string;
}) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const anchorName = `--chat-model-${titleId.replace(/:/g, '')}`;
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const listDisabled = state.disabled || state.loading || state.switching;
  const label = state.currentLabel;
  const groups = useMemo(() => {
    if (!open) return [];
    const search = query.trim().toLocaleLowerCase();
    const grouped = new Map<string | undefined, { provider: string | undefined; options: ModelPickerOption[] }>();
    for (const option of state.options) {
      if (search && !`${option.provider ?? ''} ${option.label}`.toLocaleLowerCase().includes(search)) continue;
      const group = grouped.get(option.groupId);
      if (group) group.options.push(option);
      else grouped.set(option.groupId, { provider: option.provider, options: [option] });
    }
    return [...grouped.entries()];
  }, [open, query, state.options]);

  const thinking = state.thinking;
  return (
    <Dialog.Root modal={false} open={open} onOpenChange={(next) => { setQuery(''); onOpenChange(next); }}>
      <Dialog.Trigger asChild>
        <Button
          style={{ anchorName }}
          type="button"
          variant="ghost"
          className={CHAT_LAYOUT_TOKENS.inputModelPickerTrigger}
          aria-label={`${t('input.pickModel')}: ${label}`}
          title={label}
          data-testid="chat-model-picker"
          data-chat-control="model"
          aria-busy={state.loading || state.switching || thinking?.loading || thinking?.switching}
        >
          <span className="chat-model-label min-w-0 truncate">{label}</span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content
          style={{ positionAnchor: anchorName, right: `anchor(${composerAnchorName} right)` }}
          aria-labelledby={titleId}
          aria-describedby={undefined}
          className={cn(CHAT_LAYOUT_TOKENS.inputModelPickerMenu, 'chat-model-picker flex flex-col outline-none')}
          onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus(); }}
        >
          <Dialog.Title id={titleId} className="sr-only">{t('input.modelPickerTitle')}</Dialog.Title>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)}
              aria-label={t('input.searchModels')} placeholder={t('input.searchModels')}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
          </div>
          <div data-chat-model-picker-viewport="true" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5" aria-busy={state.loading || state.switching}>
            {state.loading || state.switching ? <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">{t(state.switching ? 'input.modelSwitching' : 'input.modelLoading')}</p> : null}
            <RadioGroup.Root value={state.currentModelId} disabled={listDisabled} aria-label={t('input.pickModel')} onValueChange={state.onSelect}>
              {groups.map(([groupId, group], index) => (
                <div key={groupId ?? 'ungrouped'} role="group" aria-labelledby={group.provider ? `${titleId}-provider-${index}` : undefined}
                  className="border-t border-border/60 py-1.5 first:border-t-0">
                  {group.provider ? <div id={`${titleId}-provider-${index}`} title={group.provider}
                    className="flex items-center gap-2 px-2.5 pb-1.5 pt-1 text-xs font-semibold text-foreground">
                    <Server aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{group.provider}</span>
                  </div> : null}
                  {group.options.map((option) => (
                    <RadioGroup.Item key={option.id} value={option.id} disabled={listDisabled || option.disabled}
                      title={option.description ? `${option.label} · ${option.description}` : option.label}
                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-secondary">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.label}</span>
                        {option.description ? <span className="block truncate text-muted-foreground">{option.description}</span> : null}
                      </span>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center"><RadioGroup.Indicator><Check aria-hidden="true" className="h-3.5 w-3.5" /></RadioGroup.Indicator></span>
                    </RadioGroup.Item>
                  ))}
                </div>
              ))}
            </RadioGroup.Root>
            {!state.loading && groups.length === 0 ? <p role="status" className="px-2.5 py-3 text-xs text-muted-foreground">{t('input.noModelsFound')}</p> : null}
          </div>
          {thinking ? <ThinkingPicker
            key={scopeKey}
            state={thinking}
          /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
});
