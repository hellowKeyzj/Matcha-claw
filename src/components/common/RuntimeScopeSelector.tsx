import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { Portal as TooltipPortal } from '@radix-ui/react-tooltip';
import { Server } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  isRuntimeEndpointReady,
  selectManagementRuntime,
  useRuntimeEndpointsStore,
} from '@/stores/runtime-endpoints';
import { buildRuntimeEndpointKey } from '@/types/desktop/runtime-address';

const RUNTIME_SYMBOLS = new Map([
  ['openclaw', '🦞'],
  ['matcha-agent', '🍵'],
]);

export function RuntimeScopeSelector({ runtimeAdapterId, className, collisionBoundary }: {
  runtimeAdapterId?: string;
  className?: string;
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
  const selectedSymbol = selected?.endpointRef.kind === 'native-runtime'
    ? RUNTIME_SYMBOLS.get(selected.endpointRef.runtimeAdapterId) : undefined;
  return (
    <TooltipProvider>
      <div className={cn('flex shrink-0 items-center text-muted-foreground', className)}>
        {!selected ? (
          <span className="min-w-0 truncate text-sm text-inherit">
            {t(status === 'error' ? 'runtimeScope.loadFailed' : status === 'ready' ? 'runtimeScope.none' : 'runtimeScope.loading')}
          </span>
        ) : choices.length > 1 ? (
          <RadioGroupPrimitive.Root
            value={selected ? buildRuntimeEndpointKey(selected.endpointRef) : ''}
            onValueChange={(value) => {
              const target = choices.find((entry) => buildRuntimeEndpointKey(entry.endpointRef) === value);
              if (target) selectEndpoint(target.endpointRef);
            }}
            orientation="horizontal"
            aria-label={t('runtimeScope.selectRuntime')}
            className="isolate inline-flex h-8 w-max shrink-0 -space-x-2 items-center"
          >
            {choices.map((entry, index) => {
              const symbol = entry.endpointRef.kind === 'native-runtime'
                ? RUNTIME_SYMBOLS.get(entry.endpointRef.runtimeAdapterId) : undefined;
              return (
                <Tooltip key={buildRuntimeEndpointKey(entry.endpointRef)}>
                  <RadioGroupPrimitive.Item
                    asChild
                    value={buildRuntimeEndpointKey(entry.endpointRef)}
                    aria-label={entry.displayName}
                    className={cn(
                      'relative flex h-8 w-8 shrink-0 cursor-pointer select-none items-center justify-center rounded-[10px] border border-border bg-muted p-0 text-muted-foreground shadow-sm transition-[transform,background-color,border-color,box-shadow] duration-150 hover:-translate-y-0.5 hover:rotate-0 hover:border-foreground/40 focus-visible:!z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-checked:z-10 aria-checked:rotate-0 aria-checked:border-foreground aria-checked:bg-foreground aria-checked:text-background motion-reduce:transition-none',
                      index % 2 === 0 ? '-rotate-[7deg]' : 'rotate-[7deg]',
                    )}
                  >
                    <TooltipTrigger>
                      <span aria-hidden="true" className="text-[18px] leading-none">
                        {symbol ?? <Server className="h-[18px] w-[18px]" />}
                      </span>
                    </TooltipTrigger>
                  </RadioGroupPrimitive.Item>
                  <TooltipPortal>
                    <TooltipContent
                      sideOffset={8}
                      collisionBoundary={collisionBoundary ?? undefined}
                      collisionPadding={12}
                      className="motion-reduce:animate-none"
                    >
                      {entry.displayName}
                    </TooltipContent>
                  </TooltipPortal>
                </Tooltip>
              );
            })}
          </RadioGroupPrimitive.Root>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                tabIndex={0}
                aria-label={selected.displayName}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-foreground bg-foreground text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span aria-hidden="true" className="text-[18px] leading-none">
                  {selectedSymbol ?? <Server className="h-[18px] w-[18px]" />}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                sideOffset={8}
                collisionBoundary={collisionBoundary ?? undefined}
                collisionPadding={12}
                className="motion-reduce:animate-none"
              >
                {selected.displayName}
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
