import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  hostSecurityCheckAdvisories,
  hostSecurityCheckIntegrity,
  hostSecurityRebaselineIntegrity,
  hostSecurityRunEmergencyResponse,
  hostSecurityRunQuickAudit,
  hostSecurityScanSkills,
  resolveSecurityEmergencyOutcome,
  SECURITY_EMERGENCY_TARGET_REJECTED_MESSAGE,
} from './security-runtime';
import type { SecurityCheckProps } from './extensions';

export function QuickAuditCheck({ disabled, runSecurityOp }: SecurityCheckProps) {
  const { t } = useTranslation('security');
  return (
    <Button
      title={t('actionCenter.quickAuditTitle')}
      variant="outline"
      disabled={disabled}
      onClick={() => void runSecurityOp(t('actionCenter.quickAudit'), async () => await hostSecurityRunQuickAudit())}
    >
      {t('actionCenter.quickAudit')}
    </Button>
  );
}

export function EmergencyCheck({ disabled, runSecurityOp }: SecurityCheckProps) {
  const { t } = useTranslation('security');
  return (
    <Button
      title={t('actionCenter.emergencyTitle')}
      variant="destructive"
      disabled={disabled}
      onClick={() => void runSecurityOp(
        t('actionCenter.emergency'),
        async () => await hostSecurityRunEmergencyResponse(),
        (response) => {
          const outcome = resolveSecurityEmergencyOutcome(response);
          const display = JSON.stringify({ outcome: outcome.outcome });
          if (outcome.outcome === 'target_rejected') {
            return { display: `ERROR: ${SECURITY_EMERGENCY_TARGET_REJECTED_MESSAGE}`, success: false, message: SECURITY_EMERGENCY_TARGET_REJECTED_MESSAGE };
          }
          if (outcome.outcome === 'outcome_unknown') {
            return { display: `ERROR: ${outcome.message}`, success: false, message: outcome.message };
          }
          return { display, success: true };
        },
      )}
    >
      {t('actionCenter.emergency')}
    </Button>
  );
}

export function IntegrityCheck({ disabled, runSecurityOp }: SecurityCheckProps) {
  const { t } = useTranslation('security');
  return <Button variant="outline" disabled={disabled} onClick={() => void runSecurityOp(t('actionCenter.integrity'), async () => await hostSecurityCheckIntegrity())}>{t('actionCenter.integrity')}</Button>;
}

export function RebaselineCheck({ disabled, runSecurityOp }: SecurityCheckProps) {
  const { t } = useTranslation('security');
  return <Button variant="outline" disabled={disabled} onClick={() => void runSecurityOp(t('actionCenter.rebaseline'), async () => await hostSecurityRebaselineIntegrity())}>{t('actionCenter.rebaseline')}</Button>;
}

export function SkillScanCheck({ disabled, runSecurityOp }: SecurityCheckProps) {
  const { t } = useTranslation('security');
  return <Button variant="outline" disabled={disabled} onClick={() => void runSecurityOp(t('actionCenter.skillScan'), async () => await hostSecurityScanSkills())}>{t('actionCenter.skillScan')}</Button>;
}

export function AdvisoriesCheck({ disabled, runSecurityOp }: SecurityCheckProps) {
  const { t } = useTranslation('security');
  return <Button variant="outline" disabled={disabled} onClick={() => void runSecurityOp(t('actionCenter.advisories'), async () => await hostSecurityCheckAdvisories())}>{t('actionCenter.advisories')}</Button>;
}
