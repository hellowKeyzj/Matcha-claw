import * as React from 'react'
import type { z } from 'zod/v4'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { inputSchema, Output } from './ReadMcpResourceTool.js'
export declare function renderToolUseMessage(
  input: Partial<z.infer<ReturnType<typeof inputSchema>>>,
): React.ReactNode
export declare function userFacingName(): string
export declare function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
