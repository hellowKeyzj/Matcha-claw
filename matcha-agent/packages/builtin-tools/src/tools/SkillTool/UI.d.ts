import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import type { z } from 'zod/v4'
import type { Command } from 'src/commands.js'
import type { Tools } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { inputSchema, Output, Progress } from './SkillTool.js'
type Input = z.infer<ReturnType<typeof inputSchema>>
export declare function renderToolResultMessage(output: Output): React.ReactNode
export declare function renderToolUseMessage(
  { skill }: Partial<Input>,
  {
    commands,
  }: {
    commands?: Command[]
  },
): React.ReactNode
export declare function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<Progress>[],
  {
    tools,
    verbose,
  }: {
    tools: Tools
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseRejectedMessage(
  _input: Input,
  {
    progressMessagesForMessage,
    tools,
    verbose,
  }: {
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  {
    progressMessagesForMessage,
    tools,
    verbose,
  }: {
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
  },
): React.ReactNode
export {}
