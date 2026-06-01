import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
type Output = {
  mode?: 'content' | 'files_with_matches' | 'count'
  numFiles: number
  filenames: string[]
  content?: string
  numLines?: number
  numMatches?: number
}
export declare function renderToolUseMessage(
  {
    pattern,
    path,
  }: Partial<{
    pattern: string
    path?: string
  }>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolResultMessage(
  { mode, filenames, numFiles, content, numLines, numMatches }: Output,
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
        pattern: string
        path?: string
        glob?: string
        type?: string
        output_mode?: 'content' | 'files_with_matches' | 'count'
        head_limit?: number
      }>
    | undefined,
): string | null
export {}
