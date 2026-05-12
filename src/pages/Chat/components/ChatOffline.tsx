import { AlertCircle, Loader2 } from 'lucide-react';

export function ChatOffline({
  title,
  description,
  tone = 'error',
}: {
  title: string;
  description: string;
  tone?: 'loading' | 'error';
}) {
  const Icon = tone === 'loading' ? Loader2 : AlertCircle;
  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col items-center justify-center text-center p-8">
      <Icon className={tone === 'loading' ? 'h-12 w-12 text-primary mb-4 animate-spin' : 'h-12 w-12 text-yellow-500 mb-4'} />
      <h2 className="text-xl font-semibold mb-2">{title}</h2>
      <p className="text-muted-foreground max-w-md">
        {description}
      </p>
    </div>
  );
}
