import type { ComponentType, JSX, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type IconComponent = ComponentType<{ className?: string }>;

export function WikiPanel(props: Readonly<{ children: ReactNode; className?: string }>): JSX.Element {
  return <div className={cn('flex h-full min-h-0 flex-col bg-background/60', props.className)}>{props.children}</div>;
}

export function WikiPanelHeader(props: Readonly<{
  title: string;
  subtitle?: string;
  icon?: IconComponent;
  meta?: ReactNode;
  actions?: ReactNode;
}>): JSX.Element {
  const Icon = props.icon;
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-card/70 px-5">
      {Icon ? (
        <div className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-muted-foreground">
          <Icon className="h-4 w-4" />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold" title={props.title}>{props.title}</div>
        {props.subtitle ? <div className="truncate text-xs text-muted-foreground" title={props.subtitle}>{props.subtitle}</div> : null}
      </div>
      {props.meta}
      {props.actions ? <div className="flex items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}

export function WikiPrimaryButton(props: React.ComponentProps<typeof Button>): JSX.Element {
  return <Button {...props} className={cn('h-8 rounded-full bg-foreground px-4 text-background hover:bg-foreground/90', props.className)} />;
}

export function WikiIconButton(props: React.ComponentProps<typeof Button>): JSX.Element {
  return <Button {...props} size="icon" variant="ghost" className={cn('h-8 w-8 rounded-full', props.className)} />;
}

export function WikiSurface(props: Readonly<{ children: ReactNode; className?: string }>): JSX.Element {
  return <div className={cn('overflow-hidden rounded-2xl border border-border/70 bg-card', props.className)}>{props.children}</div>;
}

export function WikiEmpty(props: Readonly<{ title: string; icon?: IconComponent; className?: string }>): JSX.Element {
  const Icon = props.icon;
  return (
    <div className={cn('rounded-2xl border border-dashed border-border/80 bg-card/60 p-5 text-center text-sm text-muted-foreground', props.className)}>
      {Icon ? <Icon className="mx-auto mb-2 h-5 w-5" /> : null}
      {props.title}
    </div>
  );
}
