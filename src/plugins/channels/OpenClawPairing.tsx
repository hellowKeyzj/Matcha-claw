import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Loader2, Check, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { hostChannelsListPairingRequests, hostChannelsApprovePairingRequest, type ChannelPairingRequest } from '@/lib/channel-runtime';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { ChannelPairingProps } from './extensions';
import { channelScopeCurrent } from './scope';

export default function OpenClawPairing({ scope, channel, onClose }: ChannelPairingProps) {
  const { t } = useTranslation('channels');
  const active = useRef(true);
  const requestSequence = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; requestSequence.current += 1; }; }, []);
  const [requests, setRequests] = useState<ChannelPairingRequest[]>([]);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshRequests = useCallback(async () => {
    const id = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await hostChannelsListPairingRequests(scope, channel.type, channel.accountId);
      if (!active.current || requestSequence.current !== id || !channelScopeCurrent(scope)) return;
      setRequests(result.requests || []);
    } catch (err) {
      if (active.current && requestSequence.current === id && channelScopeCurrent(scope)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (active.current && requestSequence.current === id && channelScopeCurrent(scope)) setLoading(false);
    }
  }, [scope, channel.accountId, channel.type]);

  useEffect(() => {
    void refreshRequests();
  }, [refreshRequests]);

  const approveCode = async (rawCode: string) => {
    const pairingCode = rawCode.trim().toUpperCase();
    if (!pairingCode) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await hostChannelsApprovePairingRequest(scope, channel.type, {
        code: pairingCode,
        accountId: channel.accountId,
      });
      if (!active.current || !channelScopeCurrent(scope)) return;
      toast.success(t('pairing.approvedToast'));
      setCode('');
      await refreshRequests();
    } catch (err) {
      if (active.current && channelScopeCurrent(scope)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (active.current && channelScopeCurrent(scope)) setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[hsl(var(--shell-scrim))] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Card
        className="w-full max-w-lg"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>{t('pairing.title', { name: channel.name })}</CardTitle>
            <CardDescription>{t('pairing.description')}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="channel-pairing-code">{t('pairing.codeLabel')}</Label>
            <div className="flex gap-2">
              <Input
                id="channel-pairing-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={t('pairing.codePlaceholder')}
                className="font-mono uppercase"
              />
              <Button
                onClick={() => { void approveCode(code); }}
                disabled={submitting || !code.trim()}
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t('pairing.approve')}
              </Button>
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{t('pairing.pendingTitle')}</p>
              <Button variant="ghost" size="sm" onClick={() => { void refreshRequests(); }} disabled={loading}>
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common:status.loading', 'Loading...')}
              </div>
            ) : requests.length > 0 ? (
              <div className="space-y-2">
                {requests.map((request) => (
                  <div key={request.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{request.id}</p>
                      <p className="truncate text-xs text-muted-foreground">{request.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                {t('pairing.empty')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

