import type { OpenClawBridge } from '../../openclaw-bridge';
import {
  createSecurityEmergencyLockdownPayload,
  listSecurityRuleCatalog,
} from './security-policy-rules';
import {
  readSecurityPolicyFromFile,
  writeSecurityPolicyToFile,
} from './security-policy-store';

type SecurityRuntimeBridge = Pick<
  OpenClawBridge,
  | 'isGatewayRunning'
  | 'securityPolicySync'
  | 'securityAuditQueryFromUrl'
  | 'securityQuickAuditRun'
  | 'securityEmergencyRun'
  | 'securityIntegrityCheck'
  | 'securityIntegrityRebaseline'
  | 'securitySkillsScan'
  | 'securityAdvisoriesCheck'
  | 'securityRemediationPreview'
  | 'securityRemediationApply'
  | 'securityRemediationRollback'
>;

export function createSecurityRuntimeService(openclawBridge: SecurityRuntimeBridge) {
  function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  return {
    readPolicy() {
      return readSecurityPolicyFromFile();
    },

    async writePolicy(payload: unknown) {
      const normalized = await writeSecurityPolicyToFile(payload);
      const gatewayRunning = await openclawBridge.isGatewayRunning();
      let syncError: string | null = null;
      if (gatewayRunning) {
        try {
          await openclawBridge.securityPolicySync(normalized);
        } catch (error) {
          syncError = String(error);
        }
      }

      return {
        success: true,
        policy: normalized,
        syncError,
      };
    },

    async syncCurrentPolicyToGatewayIfRunning() {
      const gatewayRunning = await openclawBridge.isGatewayRunning();
      if (!gatewayRunning) {
        return { synced: false, policy: null as unknown };
      }

      const policy = readSecurityPolicyFromFile();
      await openclawBridge.securityPolicySync(policy);
      return { synced: true, policy };
    },

    listRuleCatalog(platform?: string | null) {
      return listSecurityRuleCatalog(platform);
    },

    async queryAudit(routeUrl: URL) {
      return await openclawBridge.securityAuditQueryFromUrl(routeUrl);
    },

    async runQuickAudit() {
      return await openclawBridge.securityQuickAuditRun();
    },

    async runEmergencyResponse() {
      const current = readSecurityPolicyFromFile();
      const emergencyPayload = createSecurityEmergencyLockdownPayload(current);
      const normalizedPolicy = await writeSecurityPolicyToFile(emergencyPayload);
      const gatewayRunning = await openclawBridge.isGatewayRunning();

      let syncError: string | null = null;
      if (gatewayRunning) {
        try {
          await openclawBridge.securityPolicySync(normalizedPolicy);
        } catch (error) {
          syncError = String(error);
        }
      }

      let emergency: unknown = null;
      let emergencyError: string | null = null;
      if (gatewayRunning) {
        try {
          emergency = await openclawBridge.securityEmergencyRun();
        } catch (error) {
          emergencyError = String(error);
        }
      }

      return {
        success: true,
        lockdownApplied: true,
        policy: normalizedPolicy,
        syncError,
        emergency,
        emergencyError,
      };
    },

    async checkIntegrity() {
      return await openclawBridge.securityIntegrityCheck();
    },

    async rebaselineIntegrity() {
      return await openclawBridge.securityIntegrityRebaseline();
    },

    async scanSkills(scanPath?: string) {
      return await openclawBridge.securitySkillsScan(scanPath);
    },

    async scanSkillsFromPayload(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      const scanPath = typeof body.scanPath === 'string' ? body.scanPath : undefined;
      return await openclawBridge.securitySkillsScan(scanPath);
    },

    async checkAdvisories(feedUrl?: string | null) {
      return await openclawBridge.securityAdvisoriesCheck(feedUrl);
    },

    async checkAdvisoriesFromUrl(routeUrl: URL) {
      return await openclawBridge.securityAdvisoriesCheck(routeUrl.searchParams.get('feedUrl'));
    },

    async previewRemediation() {
      return await openclawBridge.securityRemediationPreview();
    },

    async applyRemediation(actions: string[]) {
      return await openclawBridge.securityRemediationApply(actions);
    },

    async applyRemediationFromPayload(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      const actions = Array.isArray(body.actions)
        ? body.actions.filter((item) => typeof item === 'string')
        : [];
      return await openclawBridge.securityRemediationApply(actions);
    },

    async rollbackRemediation(snapshotId?: string) {
      return await openclawBridge.securityRemediationRollback(snapshotId);
    },

    async rollbackRemediationFromPayload(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : undefined;
      return await openclawBridge.securityRemediationRollback(snapshotId);
    },
  };
}
