import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { ClientInvitation } from '@/types/desktop/interconnect';

export function InvitationList({ invitations, disabled, onStop }: { invitations: ClientInvitation[]; disabled: boolean; onStop: (invitation: ClientInvitation) => void }) {
  const { t, i18n } = useTranslation('access');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!invitations.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invitations.length]);
  if (!invitations.length) return null;
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  return <section className="access-invitations" aria-label={t('interop.invitations')}>
    <h2>{t('interop.invitations')}</h2>
    <ul>{invitations.map((invitation) => {
      const status = invitation.expiresAt <= now ? 'expired' : invitation.uses >= invitation.maxUses ? 'full' : 'active';
      return <li key={invitation.id}>
        <div className="access-invitation-copy"><strong>{invitation.name}</strong><div className="access-invitation-meta"><span>{t('interop.invitationUsage', { uses: invitation.uses, maxUses: invitation.maxUses })}</span><time dateTime={new Date(invitation.expiresAt).toISOString()}>{t('interop.invitationExpires', { time: date.format(invitation.expiresAt) })}</time><span className="access-badge">{t(`interop.invitationStates.${status}`)}</span></div></div>
        <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={t('interop.stopInvitationNamed', { name: invitation.name })} onClick={() => onStop(invitation)}>{t('interop.stopInvitation')}</Button>
      </li>;
    })}</ul>
  </section>;
}
