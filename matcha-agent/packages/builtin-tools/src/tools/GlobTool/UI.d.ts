import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
export declare function userFacingName(): string
export declare function renderToolUseMessage(
  {
    pattern,
    path,
  }: Partial<{
    pattern: string
    path: string
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
export declare const renderToolResultMessage: typeof import('../GrepTool/UI.js').renderToolResultMessage
export declare function getToolUseSummary(
  input:
    | Partial<{
        pattern: string
        path: string
      }>
    | undefined,
): string | null
