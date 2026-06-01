import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import type { Input, Output } from './LSPTool.js'
export declare function userFacingName(): string
export declare function renderToolUseMessage(
  input: Partial<Input>,
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
  output: Output,
  _progressMessages: unknown[],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
