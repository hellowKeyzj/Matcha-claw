import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ChannelType } from '@/types/channel';
import { channelConnectionLabelKey, type ChannelPresentation } from './extensions';
import { ChannelIcon } from './ChannelIcon';

export function ChannelCatalogDialog({ channels, onSelect, onClose }: {
  channels: readonly ChannelPresentation[];
  onSelect: (type: ChannelType) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('channels');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[hsl(var(--shell-scrim))] p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <Card
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-[1.35rem] bg-[hsl(var(--shell-surface))] shadow-[var(--shell-shadow-overlay)] [border-color:hsl(var(--shell-border))]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between gap-4 border-b p-5 [border-color:hsl(var(--shell-border))]">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[0.95rem] border bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
              <Plus className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-lg">{t('dialog.addTitle')}</CardTitle>
              <CardDescription className="mt-1 line-clamp-2 leading-5">{t('dialog.selectDesc')}</CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {channels.map(({ meta }) => (
              <button
                key={meta.id}
                onClick={() => onSelect(meta.id)}
                className="group rounded-[1rem] border bg-[hsl(var(--shell-surface-muted))] p-4 text-left transition-[background-color,border-color] duration-150 [border-color:hsl(var(--shell-border))] hover:bg-[hsl(var(--shell-surface-hover))] hover:[border-color:hsl(var(--shell-border-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-[0.85rem] border bg-[hsl(var(--shell-surface))] [border-color:hsl(var(--shell-border))]">
                    <ChannelIcon id={meta.iconId} className="h-6 w-6" />
                  </span>
                  <Badge variant="secondary">{t(channelConnectionLabelKey(meta.connectionType))}</Badge>
                </div>
                <p className="mt-3 font-semibold tracking-[-0.02em]">{meta.name}</p>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{t(meta.description)}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
