import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import type { Tool } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { ThemeName } from 'src/utils/theme.js'
import type { BashProgress, BashToolInput, Out } from './BashTool.js'
export declare function BackgroundHint({
  onBackground,
}?: {
  onBackground?: () => void
}): React.ReactElement | null
export declare function renderToolUseMessage(
  input: Partial<BashToolInput>,
  {
    verbose,
    theme: _theme,
  }: {
    verbose: boolean
    theme: ThemeName
  },
): React.ReactNode
export declare function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage<BashProgress>[],
  {
    verbose,
    tools: _tools,
    terminalSize: _terminalSize,
    inProgressToolCallCount: _inProgressToolCallCount,
  }: {
    tools: Tool[]
    verbose: boolean
    terminalSize?: {
      columns: number
      rows: number
    }
    inProgressToolCallCount?: number
  },
): React.ReactNode
export declare function renderToolUseQueuedMessage(): React.ReactNode
export declare function renderToolResultMessage(
  content: Out,
  progressMessagesForMessage: ProgressMessage<BashProgress>[],
  {
    verbose,
    theme: _theme,
    tools: _tools,
    style: _style,
  }: {
    verbose: boolean
    theme: ThemeName
    tools: Tool[]
    style?: 'condensed'
  },
): React.ReactNode
export declare function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  {
    verbose,
    progressMessagesForMessage: _progressMessagesForMessage,
    tools: _tools,
  }: {
    verbose: boolean
    progressMessagesForMessage: ProgressMessage<BashProgress>[]
    tools: Tool[]
  },
): React.ReactNode
