import { z } from 'zod/v4'
import React from 'react'
declare const inputSchema: () => z.ZodObject<
  {
    artifact: z.ZodString
    title: z.ZodOptional<z.ZodString>
    annotations: z.ZodArray<
      z.ZodObject<
        {
          line: z.ZodOptional<z.ZodNumber>
          message: z.ZodString
          severity: z.ZodOptional<
            z.ZodEnum<{
              error: 'error'
              suggestion: 'suggestion'
              info: 'info'
              warning: 'warning'
            }>
          >
        },
        z.core.$strip
      >
    >
    summary: z.ZodOptional<z.ZodString>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    artifact: z.ZodString
    title: z.ZodOptional<z.ZodString>
    annotationCount: z.ZodNumber
    summary: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const ReviewArtifactTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    description(input: {
      artifact: string
      annotations: {
        message: string
        line?: number | undefined
        severity?: 'error' | 'suggestion' | 'info' | 'warning' | undefined
      }[]
      title?: string | undefined
      summary?: string | undefined
    }): Promise<string>
    userFacingName(): string
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    isConcurrencySafe(): true
    isReadOnly(): true
    toAutoClassifierInput(input: {
      artifact: string
      annotations: {
        message: string
        line?: number | undefined
        severity?: 'error' | 'suggestion' | 'info' | 'warning' | undefined
      }[]
      title?: string | undefined
      summary?: string | undefined
    }): string
    prompt(): Promise<string>
    mapToolResultToToolResultBlockParam(
      output: {
        artifact: string
        annotationCount: number
        title?: string | undefined
        summary?: string | undefined
      },
      toolUseID: string,
    ): {
      tool_use_id: string
      type: 'tool_result'
      content: string
    }
    renderToolUseMessage(
      input: Partial<z.infer<InputSchema>>,
      {
        verbose,
      }: {
        theme?: string
        verbose: boolean
      },
    ): React.ReactNode
    renderToolResultMessage(
      output: Output,
      _progressMessages: unknown[],
      {
        verbose,
      }: {
        verbose: boolean
      },
    ): React.ReactNode
    call(
      {
        artifact,
        title,
        annotations,
        summary,
      }: {
        artifact: string
        annotations: {
          message: string
          line?: number | undefined
          severity?: 'error' | 'suggestion' | 'info' | 'warning' | undefined
        }[]
        title?: string | undefined
        summary?: string | undefined
      },
      _context: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        artifact: string
        annotationCount: number
        title?: string | undefined
        summary?: string | undefined
      }
    }>
  },
  | 'isEnabled'
  | 'userFacingName'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
> & {
  isEnabled: () => boolean
  userFacingName: () => string
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      [key: string]: unknown
    },
    _ctx?: import('src/Tool.js').ToolUseContext,
  ) => Promise<import('src/types/permissions').PermissionResult>
  toAutoClassifierInput: (input: {
    artifact: string
    annotations: {
      message: string
      line?: number | undefined
      severity?: 'error' | 'suggestion' | 'info' | 'warning' | undefined
    }[]
    title?: string | undefined
    summary?: string | undefined
  }) => string
}
export {}
