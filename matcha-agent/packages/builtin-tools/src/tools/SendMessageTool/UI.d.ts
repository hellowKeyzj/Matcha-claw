import React from 'react'
import type { Input, SendMessageToolOutput } from './SendMessageTool.js'
export declare function renderToolUseMessage(
  input: Partial<Input>,
): React.ReactNode
export declare function renderToolResultMessage(
  content: SendMessageToolOutput | string,
  _progressMessages: unknown,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
