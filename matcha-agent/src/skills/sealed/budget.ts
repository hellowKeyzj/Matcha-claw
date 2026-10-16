import type { ToolUseContext } from '../../Tool.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from '../../utils/context.js'

// Use the same local estimator and real tool schemas as native requests. No
// protected content is sent to a token-count service.
export async function sealedReadTokenBudget(
  context: ToolUseContext,
): Promise<number> {
  const { roughTokenCountEstimation, roughTokenCountEstimationForMessages } =
    await import('../../services/tokenEstimation.js')
  const { toolToAPISchema } = await import('../../utils/api.js')
  const tools = await Promise.all(
    context.options.tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: async () =>
          context.getAppState().toolPermissionContext,
        tools: context.options.tools,
        agents: context.options.agentDefinitions.activeAgents,
        model: context.options.mainLoopModel,
      }),
    ),
  )
  const system = context.renderedSystemPrompt ?? [
    context.options.customSystemPrompt ?? '',
    context.options.appendSystemPrompt ?? '',
  ]
  const { normalizeMessagesForAPI } = await import('../../utils/messages.js')
  const messages = normalizeMessagesForAPI(
    context.messages,
    context.options.tools,
  )
  const used =
    roughTokenCountEstimationForMessages(
      messages.map(({ type, message }) => ({ type, message })),
    ) + roughTokenCountEstimation(JSON.stringify({ system, tools }))
  const { getAPIProvider } = await import('../../utils/model/providers.js')
  const provider = getAPIProvider()
  const outputTokens =
    provider === 'openai' || provider === 'openaiResponses'
      ? (
          await import('../../services/api/openai/requestBody.js')
        ).resolveOpenAIMaxTokens(
          getModelMaxOutputTokens(context.options.mainLoopModel).upperLimit,
        )
      : (
          await import('../../services/api/claude.js')
        ).getMaxOutputTokensForModel(context.options.mainLoopModel)
  return Math.max(
    0,
    getContextWindowForModel(context.options.mainLoopModel) -
      outputTokens -
      Math.ceil((used * 4) / 3),
  )
}
