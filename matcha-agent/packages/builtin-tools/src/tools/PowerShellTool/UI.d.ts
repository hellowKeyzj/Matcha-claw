import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import type { Tool } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { PowerShellProgress } from 'src/types/tools.js'
import type { ThemeName } from 'src/utils/theme.js'
import type { Out, PowerShellToolInput } from './PowerShellTool.js'
export declare function renderToolUseMessage(
  input: Partial<PowerShellToolInput>,
  {
    verbose,
    theme: _theme,
  }: {
    verbose: boolean
    theme: ThemeName
  },
): React.ReactNode
export declare function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage<PowerShellProgress>[],
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
  progressMessagesForMessage: ProgressMessage<PowerShellProgress>[],
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
    progressMessagesForMessage: ProgressMessage<PowerShellProgress>[]
    tools: Tool[]
  },
): React.ReactNode
