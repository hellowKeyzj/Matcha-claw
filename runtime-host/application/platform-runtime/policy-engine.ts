import type { PolicyCheck, PolicyDecision, PolicyEnginePort } from '../../shared/platform-runtime-contracts';

export class PolicyEngine implements PolicyEnginePort {
  constructor(private readonly blockedToolIds: Set<string> = new Set()) {}

  async authorizeTool(req: PolicyCheck): Promise<PolicyDecision> {
    if (this.blockedToolIds.has(req.toolId)) {
      return {
        allow: false,
        reason: `tool_blocked:${req.toolId}`,
      };
    }
    return { allow: true };
  }
}
