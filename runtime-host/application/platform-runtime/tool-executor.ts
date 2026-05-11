import type {
  ToolExecRequest,
  ToolExecResult,
  ToolExecutorPort,
  ToolId,
} from '../../shared/platform-runtime-contracts';

type ToolHandler = (req: ToolExecRequest) => Promise<ToolExecResult>;

export class PlatformToolExecutor implements ToolExecutorPort {
  private readonly handlers = new Map<ToolId, ToolHandler>();

  register(toolId: ToolId, handler: ToolHandler): void {
    this.handlers.set(toolId, handler);
  }

  unregister(toolId: ToolId): void {
    this.handlers.delete(toolId);
  }

  async executeTool(req: ToolExecRequest): Promise<ToolExecResult> {
    const handler = this.handlers.get(req.toolId);
    if (!handler) {
      return {
        ok: false,
        error: `tool_handler_not_found:${req.toolId}`,
      };
    }
    return await handler(req);
  }
}
