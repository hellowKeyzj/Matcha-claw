import { forwardRef, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useContributions } from '@/plugin-host/react';
import { surfaceRenderers, type RuntimeSurfaceProps } from './extensions';
import type { RuntimeContentHandle } from './content-snapshot';

export type { RuntimeContentHandle } from './content-snapshot';
export type { RuntimeContentSource, RuntimeSurfaceSource } from './extensions';

export const RuntimeContentHost = forwardRef<RuntimeContentHandle, RuntimeSurfaceProps>(function RuntimeContentHost(props, ref) {
  const { t } = useTranslation('chat');
  const renderers = useContributions(surfaceRenderers);
  const renderer = renderers.reduce<typeof renderers[number] | undefined>((selected, entry) => (
    entry.kind === props.source.kind && (!selected || (entry.priority ?? 0) > (selected.priority ?? 0))
      ? entry : selected
  ), undefined);
  if (!renderer) return <p role="status" className={cn('p-3 text-xs text-muted-foreground', props.className)}>{t('runtimeContent.unavailable', { defaultValue: 'Native content is unavailable.' })}</p>;
  return <Suspense fallback={<div role="status" className={cn('flex h-full min-h-0 items-center justify-center text-muted-foreground', props.className)}><Loader2 className="h-5 w-5 animate-spin" /></div>}>
    {renderer.render({ ...props, ref })}
  </Suspense>;
});
