import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { ToolUseContext } from 'src/Tool.js'
export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
}
export declare function resumeAgentBackground({
  agentId,
  prompt,
  toolUseContext,
  canUseTool,
  invokingRequestId,
}: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
}): Promise<ResumeAgentResult>
