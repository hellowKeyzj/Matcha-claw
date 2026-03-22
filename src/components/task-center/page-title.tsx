interface TaskCenterPageTitleProps {
  title: string;
  subtitle: string;
}

export function TaskCenterPageTitle({ title, subtitle }: TaskCenterPageTitleProps) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

