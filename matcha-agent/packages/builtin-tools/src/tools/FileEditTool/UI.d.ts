import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import type { Tools } from 'src/Tool.js'
import type { Message, ProgressMessage } from 'src/types/message.js'
import type { ThemeName } from 'src/utils/theme.js'
import type { FileEditOutput } from './types.js'
export declare function userFacingName(
  input:
    | Partial<{
        file_path: string
        old_string: string
        new_string: string
        replace_all: boolean
        edits: unknown[]
      }>
    | undefined,
): string
export declare function getToolUseSummary(
  input:
    | Partial<{
        file_path: string
        old_string: string
        new_string: string
        replace_all: boolean
      }>
    | undefined,
): string | null
export declare function renderToolUseMessage(
  {
    file_path,
  }: {
    file_path?: string
  },
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolResultMessage(
  { filePath, structuredPatch, originalFile }: FileEditOutput,
  _progressMessagesForMessage: ProgressMessage[],
  {
    style,
    verbose,
  }: {
    style?: 'condensed'
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseRejectedMessage(
  input: {
    file_path: string
    old_string?: string
    new_string?: string
    replace_all?: boolean
    edits?: unknown[]
  },
  options: {
    columns: number
    messages: Message[]
    progressMessagesForMessage: ProgressMessage[]
    style?: 'condensed'
    theme: ThemeName
    tools: Tools
    verbose: boolean
  },
): React.ReactElement
export declare function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  options: {
    progressMessagesForMessage: ProgressMessage[]
    tools: Tools
    verbose: boolean
  },
): React.ReactElement
