import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import type { Message, ProgressMessage } from 'src/types/message.js'
import type { ThemeName } from 'src/utils/theme.js'
import type { z } from 'zod/v4'
import type { Tools } from 'src/Tool.js'
import type { inputSchema, Output } from './NotebookEditTool.js'
export declare function getToolUseSummary(
  input: Partial<z.infer<ReturnType<typeof inputSchema>>> | undefined,
): string | null
export declare function renderToolUseMessage(
  {
    notebook_path,
    cell_id,
    new_source,
    cell_type,
    edit_mode,
  }: Partial<z.infer<ReturnType<typeof inputSchema>>>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseRejectedMessage(
  input: z.infer<ReturnType<typeof inputSchema>>,
  {
    verbose,
  }: {
    columns?: number
    messages?: Message[]
    progressMessagesForMessage?: ProgressMessage[]
    theme?: ThemeName
    tools?: Tools
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
export declare function renderToolResultMessage({
  cell_id,
  new_source,
  error,
}: Output): React.ReactNode
