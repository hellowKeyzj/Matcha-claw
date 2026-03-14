import type { AuditEvent, PolicyCheck, PolicyDecision, StandardEvent } from './models';

export interface PolicyEnginePort {
  authorizeTool(req: PolicyCheck): Promise<PolicyDecision>;
}

export interface AuditSinkPort {
  append(event: AuditEvent): Promise<void>;
}

export interface EventBusPort {
  publish(event: StandardEvent): Promise<void>;
}
