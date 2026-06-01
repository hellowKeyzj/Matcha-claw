import React from 'react'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { Output } from './WebFetchTool.js'
export declare function renderToolUseMessage(
  {
    url,
    prompt,
  }: Partial<{
    url: string
    prompt: string
  }>,
  {
    verbose,
  }: {
    theme?: string
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseProgressMessage(): React.ReactNode
export declare function renderToolResultMessage(
  { bytes, code, codeText, result }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function getToolUseSummary(
  input:
    | Partial<{
        url: string
        prompt: string
      }>
    | undefined,
): string | null
