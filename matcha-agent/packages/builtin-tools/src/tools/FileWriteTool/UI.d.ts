import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { Output } from './FileWriteTool.js'
/**
 * Count visible lines in file content. A trailing newline is treated as a
 * line terminator (not a new empty line), matching editor line numbering.
 */
export declare function countLines(content: string): number
export declare function userFacingName(
  input:
    | Partial<{
        file_path: string
        content: string
      }>
    | undefined,
): string
/** Gates fullscreen click-to-expand. Only `create` truncates (to
 *  MAX_LINES_TO_RENDER); `update` renders the full diff regardless of verbose.
 *  Called per visible message on hover/scroll, so early-exit after finding the
 *  (MAX+1)th line instead of splitting the whole (possibly huge) content. */
export declare function isResultTruncated({ type, content }: Output): boolean
export declare function getToolUseSummary(
  input:
    | Partial<{
        file_path: string
        content: string
      }>
    | undefined,
): string | null
export declare function renderToolUseMessage(
  input: Partial<{
    file_path: string
    content: string
  }>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseRejectedMessage(
  {
    file_path,
    content,
  }: {
    file_path: string
    content: string
  },
  {
    style,
    verbose,
  }: {
    style?: 'condensed'
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
  { filePath, content, structuredPatch, type, originalFile }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    style,
    verbose,
  }: {
    style?: 'condensed'
    verbose: boolean
  },
): React.ReactNode
