import * as React from 'react'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { Output } from './VaultHttpFetchTool.js'
export declare function renderToolUseMessage(
  input: Partial<{
    method?: string
    url?: string
    vault_auth_key?: string
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
