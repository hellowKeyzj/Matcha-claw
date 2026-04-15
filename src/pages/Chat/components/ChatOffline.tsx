import { AlertCircle } from 'lucide-react';

export function ChatOffline({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col items-center justify-center text-center p-8">
      <AlertCircle className="h-12 w-12 text-yellow-500 mb-4" />
      <h2 className="text-xl font-semibold mb-2">{title}</h2>
      <p className="text-muted-foreground max-w-md">
        {description}
      </p>
    </div>
  );
}

