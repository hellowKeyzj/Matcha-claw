import * as React from 'react'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { Output } from './LocalMemoryRecallTool.js'
export declare function renderToolUseMessage(
  input: Partial<{
    action?: 'list_stores' | 'list_entries' | 'fetch'
    store?: string
    key?: string
    preview_only?: boolean
  }>,
  _options?: {
    theme?: unknown
    verbose?: boolean
    commands?: unknown
  },
): React.ReactNode
export declare function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
