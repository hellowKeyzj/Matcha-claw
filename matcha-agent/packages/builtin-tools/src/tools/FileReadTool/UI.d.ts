import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import type { Input, Output } from './FileReadTool.js'
export declare function renderToolUseMessage(
  { file_path, offset, limit, pages }: Partial<Input>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseTag({
  file_path,
}: Partial<Input>): React.ReactNode
export declare function renderToolResultMessage(output: Output): React.ReactNode
export declare function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function userFacingName(
  input: Partial<Input> | undefined,
): string
export declare function getToolUseSummary(
  input: Partial<Input> | undefined,
): string | null
