import { RuntimeScopeSelector } from '@/components/common/RuntimeScopeSelector';

interface TaskCenterPageTitleProps {
  title: string;
  subtitle: string;
}

export function TaskCenterPageTitle({ title, subtitle }: TaskCenterPageTitleProps) {
  return (
    <header>
      <div className="flex min-h-11 items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <RuntimeScopeSelector />
      </div>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </header>
  );
}
