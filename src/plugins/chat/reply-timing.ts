import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ReplyTiming =
  | { kind: 'running'; startedAtMs: number }
  | { kind: 'finished'; startedAtMs: number; endedAtMs: number };

export function useReplyDuration(timing?: ReplyTiming): string | null {
  const { t } = useTranslation('chat');
  const [now, setNow] = useState(() => Date.now());
  const startedAt = timing?.startedAtMs;
  const running = timing?.kind === 'running';
  const endedAt = timing?.kind === 'finished' ? timing.endedAtMs : undefined;
  useEffect(() => {
    if (startedAt === undefined || !running) return;
    const tick = () => setNow(Date.now());
    const initial = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [startedAt, running]);
  if (startedAt === undefined) return null;
  const seconds = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000));
  return seconds < 60
    ? t('replyTiming.seconds', { count: seconds })
    : t('replyTiming.minutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}
