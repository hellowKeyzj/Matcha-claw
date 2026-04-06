import type {
  AssembleRequest,
  ContextAssemblerPort,
  Credentials,
  PolicyEnginePort,
  RunContext,
  ToolDefinition,
  ToolRegistryPort,
} from '../../shared/platform-runtime-contracts';

const DEFAULT_CREDENTIALS: Credentials = {};

function filterAllowedTools(
  tools: ToolDefinition[],
  decisions: Array<{ toolId: string; allow: boolean }>,
): ToolDefinition[] {
  const denied = new Set(decisions.filter((decision) => !decision.allow).map((decision) => decision.toolId));
  return tools.filter((tool) => !denied.has(tool.id));
}

export class ContextAssembler implements ContextAssemblerPort {
  constructor(
    private readonly toolRegistry: ToolRegistryPort,
    private readonly policyEngine?: PolicyEnginePort,
  ) {}

  async assemble(req: AssembleRequest): Promise<RunContext> {
    const tools = await this.toolRegistry.listEffective({
      includeDisabled: false,
      requestedToolIds: req.requestedToolIds,
    });

    let allowedTools = tools;
    if (this.policyEngine) {
      const decisions = await Promise.all(
        tools.map(async (tool) => ({
          toolId: tool.id,
          ...(await this.policyEngine.authorizeTool({
            toolId: tool.id,
            action: 'execute',
            sessionId: req.sessionId,
          })),
        })),
      );
      allowedTools = filterAllowedTools(tools, decisions);
    }

    return {
      sessionId: req.sessionId,
      systemPrompt: req.systemPrompt ?? '',
      resourceBindings: req.resourceBindings ?? [],
      enabledTools: allowedTools,
      platformCredentials: req.credentials ?? DEFAULT_CREDENTIALS,
    };
  }
}
