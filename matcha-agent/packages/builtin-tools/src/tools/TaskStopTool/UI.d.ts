import React from 'react'
import type { Output } from './TaskStopTool.js'
export declare function renderToolUseMessage(): React.ReactNode
export declare function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: unknown[],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
