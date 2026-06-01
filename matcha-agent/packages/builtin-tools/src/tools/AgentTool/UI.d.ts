import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import type { z } from 'zod/v4'
import { type Tools } from 'src/Tool.js'
import type { Message, ProgressMessage } from 'src/types/message.js'
import type { ModelAlias } from 'src/utils/model/aliases.js'
import type { Theme, ThemeName } from 'src/utils/theme.js'
import type { outputSchema, Progress } from './AgentTool.js'
type Output = z.input<ReturnType<typeof outputSchema>>
export declare function AgentPromptDisplay({
  prompt,
  dim: _dim,
}: {
  prompt: string
  theme?: ThemeName
  dim?: boolean
}): React.ReactNode
export declare function AgentResponseDisplay({
  content,
}: {
  content: {
    type: string
    text: string
  }[]
  theme?: ThemeName
}): React.ReactNode
export declare function renderToolResultMessage(
  data: Output,
  progressMessagesForMessage: ProgressMessage<Progress>[],
  {
    tools,
    verbose,
    theme,
    isTranscriptMode,
  }: {
    tools: Tools
    verbose: boolean
    theme: ThemeName
    isTranscriptMode?: boolean
  },
): React.ReactNode
export declare function renderToolUseMessage({
  description,
  prompt,
}: Partial<{
  description: string
  prompt: string
}>): React.ReactNode
export declare function renderToolUseTag(
  input: Partial<{
    description: string
    prompt: string
    subagent_type: string
    model?: ModelAlias
  }>,
): React.ReactNode
export declare function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<Progress>[],
  {
    tools,
    verbose,
    terminalSize,
    inProgressToolCallCount,
    isTranscriptMode,
  }: {
    tools: Tools
    verbose: boolean
    terminalSize?: {
      columns: number
      rows: number
    }
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
  },
): React.ReactNode
export declare function renderToolUseRejectedMessage(
  _input: {
    description: string
    prompt: string
    subagent_type: string
  },
  {
    progressMessagesForMessage,
    tools,
    verbose,
    isTranscriptMode,
  }: {
    columns: number
    messages: Message[]
    style?: 'condensed'
    theme: ThemeName
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
  },
): React.ReactNode
export declare function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  {
    progressMessagesForMessage,
    tools,
    verbose,
    isTranscriptMode,
  }: {
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
  },
): React.ReactNode
export declare function renderGroupedAgentToolUse(
  toolUses: Array<{
    param: ToolUseBlockParam
    isResolved: boolean
    isError: boolean
    isInProgress: boolean
    progressMessages: ProgressMessage<Progress>[]
    result?: {
      param: ToolResultBlockParam
      output: Output
    }
  }>,
  options: {
    shouldAnimate: boolean
    tools: Tools
  },
): React.ReactNode | null
export declare function userFacingName(
  input:
    | Partial<{
        description: string
        prompt: string
        subagent_type: string
        name: string
        team_name: string
      }>
    | undefined,
): string
export declare function userFacingNameBackgroundColor(
  input:
    | Partial<{
        description: string
        prompt: string
        subagent_type: string
      }>
    | undefined,
): keyof Theme | undefined
export declare function extractLastToolInfo(
  progressMessages: ProgressMessage<Progress>[],
  tools: Tools,
): string | null
export {}
