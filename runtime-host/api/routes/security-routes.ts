import type { OpenClawBridge } from '../../openclaw-bridge';
import { createSecurityRuntimeService } from '../../application/security/service';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface SecurityRouteDeps {
  openclawBridge: Pick<
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
}

export async function handleSecurityRoute(
  method: string,
  routePath: string,
  routeUrl: URL,
  payload: unknown,
  deps: SecurityRouteDeps,
): Promise<LocalDispatchResponse | null> {
  const service = createSecurityRuntimeService(deps.openclawBridge);

  if (method === 'GET' && routePath === '/api/security') {
    return {
      status: 200,
      data: service.readPolicy(),
    };
  }

  if (method === 'PUT' && routePath === '/api/security') {
    try {
      return {
        status: 200,
        data: await service.writePolicy(payload),
      };
    } catch (error) {
      return {
        status: 500,
        data: {
          success: false,
          error: String(error),
        },
      };
    }
  }

  if (method === 'GET' && routePath === '/api/security/destructive-rule-catalog') {
    return {
      status: 200,
      data: service.listRuleCatalog(routeUrl.searchParams.get('platform')),
    };
  }

  if (method === 'GET' && routePath === '/api/security/audit') {
    try {
      return {
        status: 200,
        data: await service.queryAudit(routeUrl),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/security/sync-current-policy') {
    try {
      return {
        status: 200,
        data: await service.syncCurrentPolicyToGatewayIfRunning(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/security/quick-audit') {
    try {
      return {
        status: 200,
        data: await service.runQuickAudit(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/security/emergency-response') {
    try {
      return {
        status: 200,
        data: await service.runEmergencyResponse(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && routePath === '/api/security/integrity') {
    try {
      return {
        status: 200,
        data: await service.checkIntegrity(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/security/integrity/rebaseline') {
    try {
      return {
        status: 200,
        data: await service.rebaselineIntegrity(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/security/skills/scan') {
    try {
      return {
        status: 200,
        data: await service.scanSkillsFromPayload(payload),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && routePath === '/api/security/advisories') {
    try {
      return {
        status: 200,
        data: await service.checkAdvisoriesFromUrl(routeUrl),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && routePath === '/api/security/remediation/preview') {
    try {
      return {
        status: 200,
        data: await service.previewRemediation(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/security/remediation/apply') {
    try {
      return {
        status: 200,
        data: await service.applyRemediationFromPayload(payload),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/security/remediation/rollback') {
    try {
      return {
        status: 200,
        data: await service.rollbackRemediationFromPayload(payload),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  return null;
}
