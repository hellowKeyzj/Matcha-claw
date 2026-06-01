import React from 'react'
import type { Output } from './TeamDeleteTool.js'
export declare function renderToolUseMessage(
  _input: Record<string, unknown>,
): React.ReactNode
export declare function renderToolResultMessage(
  content: Output | string,
  _progressMessages: unknown,
  {
    verbose: _verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
