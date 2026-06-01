import React from 'react'
import type { ProgressMessage } from 'src/types/message.js'
import type { Output, WebSearchProgress } from './WebSearchTool.js'
export declare function renderToolUseMessage(
  {
    query,
    allowed_domains,
    blocked_domains,
  }: Partial<{
    query: string
    allowed_domains?: string[]
    blocked_domains?: string[]
  }>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<WebSearchProgress>[],
): React.ReactNode
export declare function renderToolResultMessage(output: Output): React.ReactNode
export declare function getToolUseSummary(
  input:
    | Partial<{
        query: string
      }>
    | undefined,
): string | null
