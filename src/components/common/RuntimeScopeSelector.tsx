import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  isRuntimeEndpointReady,
  selectManagementRuntime,
  useRuntimeEndpointsStore,
} from '@/stores/runtime-endpoints';
import { buildRuntimeEndpointKey } from '@/types/desktop/runtime-address';

export function RuntimeScopeSelector({ runtimeAdapterId, className, triggerClassName, collisionBoundary }: {
  runtimeAdapterId?: string;
  className?: string;
  triggerClassName?: string;
  collisionBoundary?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const managementRuntime = useRuntimeEndpointsStore(selectManagementRuntime);
  const selected = !runtimeAdapterId || managementRuntime?.runtimeAdapterId === runtimeAdapterId ? managementRuntime : null;
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const status = useRuntimeEndpointsStore((state) => state.status);
  const selectEndpoint = useRuntimeEndpointsStore((state) => state.selectManagementEndpoint);
  useEffect(() => {
    const directory = useRuntimeEndpointsStore.getState();
    directory.init();
    if (directory.status === 'idle') void directory.refresh();
  }, []);
  useEffect(() => {
    if (!runtimeAdapterId || selected) return;
    const candidates = endpoints.filter((entry) => entry.runtimeAdapterId === runtimeAdapterId);
    const target = candidates.find(isRuntimeEndpointReady) ?? candidates[0];
    if (target) selectEndpoint(target.endpointRef);
  }, [endpoints, runtimeAdapterId, selected, selectEndpoint]);
  const choices = endpoints.filter((entry) => (!runtimeAdapterId || entry.runtimeAdapterId === runtimeAdapterId)
    && (isRuntimeEndpointReady(entry) || entry === selected));
  return (
    <div className={cn('flex min-w-0 max-w-full items-center gap-2 text-muted-foreground', className)}>
      {choices.length > 1 ? (
        <SelectPrimitive.Root
          value={selected ? buildRuntimeEndpointKey(selected.endpointRef) : ''}
          onValueChange={(value) => {
            const target = choices.find((entry) => buildRuntimeEndpointKey(entry.endpointRef) === value);
            if (target) selectEndpoint(target.endpointRef);
          }}
        >
          <SelectPrimitive.Trigger asChild aria-label={t('runtimeScope.selectRuntime')}>
            <Button variant="outline" size="sm" className={cn('h-9 w-auto min-w-36 justify-between text-sm', triggerClassName)}>
              <span className="min-w-0 truncate text-left">
                <SelectPrimitive.Value placeholder={t('runtimeScope.selectRuntime')} />
              </span>
              <SelectPrimitive.Icon asChild>
                <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
              </SelectPrimitive.Icon>
            </Button>
          </SelectPrimitive.Trigger>
          <SelectPrimitive.Portal>
            <SelectPrimitive.Content
              position="popper"
              align="start"
              sideOffset={4}
              collisionBoundary={collisionBoundary ?? undefined}
              collisionPadding={12}
              aria-label={t('runtimeScope.selectRuntime')}
              className="z-50 w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-content-available-width)] max-h-[min(20rem,var(--radix-select-content-available-height))] overflow-hidden rounded-[var(--radius-interactive)] border border-border bg-popover text-popover-foreground shadow-[var(--shell-shadow-overlay)]"
            >
              <SelectPrimitive.Viewport className="select-scroll-viewport max-h-[inherit] overflow-y-auto overscroll-contain p-1">
                {choices.map((entry) => (
                  <SelectPrimitive.Item
                    key={buildRuntimeEndpointKey(entry.endpointRef)}
                    value={buildRuntimeEndpointKey(entry.endpointRef)}
                    textValue={entry.displayName}
                    title={entry.displayName}
                    className="relative flex min-w-0 cursor-default select-none items-center rounded-md py-2 pl-3 pr-8 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
                    <SelectPrimitive.ItemText asChild>
                      <span className="min-w-0 truncate">{entry.displayName}</span>
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
                      <Check aria-hidden="true" className="h-4 w-4" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Viewport>
            </SelectPrimitive.Content>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
      ) : (
        <span className="min-w-0 truncate text-sm text-inherit">
          {selected?.displayName ?? t(status === 'error' ? 'runtimeScope.loadFailed' : status === 'ready' ? 'runtimeScope.none' : 'runtimeScope.loading')}
        </span>
      )}
    </div>
  );
}
