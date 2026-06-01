import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import type { ToolUseContext } from 'src/Tool.js'
import { type ImageDimensions } from 'src/utils/imageResizer.js'
import { createUserMessage } from 'src/utils/messages.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'
type FileReadListener = (filePath: string, content: string) => void
export declare function registerFileReadListener(
  listener: FileReadListener,
): () => void
export declare class MaxFileReadTokenExceededError extends Error {
  tokenCount: number
  maxTokens: number
  constructor(tokenCount: number, maxTokens: number)
}
declare const inputSchema: () => z.ZodObject<
  {
    file_path: z.ZodString
    offset: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodOptional<z.ZodNumber>
    >
    limit: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodOptional<z.ZodNumber>
    >
    pages: z.ZodOptional<z.ZodString>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>
declare const outputSchema: () => z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        type: z.ZodLiteral<'text'>
        file: z.ZodObject<
          {
            filePath: z.ZodString
            content: z.ZodString
            numLines: z.ZodNumber
            startLine: z.ZodNumber
            totalLines: z.ZodNumber
          },
          z.core.$strip
        >
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'image'>
        file: z.ZodObject<
          {
            base64: z.ZodString
            type: z.ZodEnum<{
              'image/png': 'image/png'
              'image/jpeg': 'image/jpeg'
              'image/gif': 'image/gif'
              'image/webp': 'image/webp'
            }>
            originalSize: z.ZodNumber
            dimensions: z.ZodOptional<
              z.ZodObject<
                {
                  originalWidth: z.ZodOptional<z.ZodNumber>
                  originalHeight: z.ZodOptional<z.ZodNumber>
                  displayWidth: z.ZodOptional<z.ZodNumber>
                  displayHeight: z.ZodOptional<z.ZodNumber>
                },
                z.core.$strip
              >
            >
          },
          z.core.$strip
        >
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'notebook'>
        file: z.ZodObject<
          {
            filePath: z.ZodString
            cells: z.ZodArray<z.ZodAny>
          },
          z.core.$strip
        >
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'pdf'>
        file: z.ZodObject<
          {
            filePath: z.ZodString
            base64: z.ZodString
            originalSize: z.ZodNumber
          },
          z.core.$strip
        >
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'parts'>
        file: z.ZodObject<
          {
            filePath: z.ZodString
            originalSize: z.ZodNumber
            count: z.ZodNumber
            outputDir: z.ZodString
          },
          z.core.$strip
        >
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'file_unchanged'>
        file: z.ZodObject<
          {
            filePath: z.ZodString
          },
          z.core.$strip
        >
      },
      z.core.$strip
    >,
  ],
  'type'
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const FileReadTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    strict: true
    description(): Promise<string>
    prompt(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    userFacingName: typeof userFacingName
    getToolUseSummary: typeof getToolUseSummary
    getActivityDescription(
      input:
        | Partial<{
            file_path: string
            offset?: number | undefined
            limit?: number | undefined
            pages?: string | undefined
          }>
        | undefined,
    ): string
    isConcurrencySafe(): true
    isReadOnly(): true
    toAutoClassifierInput(input: {
      file_path: string
      offset?: number | undefined
      limit?: number | undefined
      pages?: string | undefined
    }): string
    isSearchOrReadCommand(): {
      isSearch: false
      isRead: true
    }
    getPath({
      file_path,
    }: {
      file_path: string
      offset?: number | undefined
      limit?: number | undefined
      pages?: string | undefined
    }): string
    backfillObservableInput(input: Record<string, unknown>): void
    preparePermissionMatcher({
      file_path,
    }: {
      file_path: string
      offset?: number | undefined
      limit?: number | undefined
      pages?: string | undefined
    }): Promise<(pattern: string) => boolean>
    checkPermissions(
      input: {
        file_path: string
        offset?: number | undefined
        limit?: number | undefined
        pages?: string | undefined
      },
      context: ToolUseContext,
    ): Promise<PermissionDecision>
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseTag: typeof renderToolUseTag
    renderToolResultMessage: typeof renderToolResultMessage
    extractSearchText(): string
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
    validateInput(
      {
        file_path,
        pages,
      }: {
        file_path: string
        offset?: number | undefined
        limit?: number | undefined
        pages?: string | undefined
      },
      toolUseContext: ToolUseContext,
    ): Promise<
      | {
          result: false
          message: string
          errorCode: number
        }
      | {
          result: true
          message?: undefined
          errorCode?: undefined
        }
    >
    call(
      {
        file_path,
        offset,
        limit,
        pages,
      }: {
        file_path: string
        offset?: number | undefined
        limit?: number | undefined
        pages?: string | undefined
      },
      context: ToolUseContext,
      _canUseTool?:
        | import('src/hooks/useCanUseTool.js').CanUseToolFn
        | undefined,
      parentMessage?:
        | import('@ant/model-provider').AssistantMessage
        | undefined,
    ): Promise<{
      data: Output
      newMessages?: ReturnType<typeof createUserMessage>[]
    }>
    mapToolResultToToolResultBlockParam(
      data:
        | {
            type: 'text'
            file: {
              filePath: string
              content: string
              numLines: number
              startLine: number
              totalLines: number
            }
          }
        | {
            type: 'image'
            file: {
              base64: string
              type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
              originalSize: number
              dimensions?:
                | {
                    originalWidth?: number | undefined
                    originalHeight?: number | undefined
                    displayWidth?: number | undefined
                    displayHeight?: number | undefined
                  }
                | undefined
            }
          }
        | {
            type: 'notebook'
            file: {
              filePath: string
              cells: any[]
            }
          }
        | {
            type: 'pdf'
            file: {
              filePath: string
              base64: string
              originalSize: number
            }
          }
        | {
            type: 'parts'
            file: {
              filePath: string
              originalSize: number
              count: number
              outputDir: string
            }
          }
        | {
            type: 'file_unchanged'
            file: {
              filePath: string
            }
          },
      toolUseID: string,
    ): import('src/Tool.js').ToolResultBlockParam
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
  userFacingName: typeof userFacingName
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      file_path: string
      offset?: number | undefined
      limit?: number | undefined
      pages?: string | undefined
    },
    context: ToolUseContext,
  ) => Promise<PermissionDecision>
  toAutoClassifierInput: (input: {
    file_path: string
    offset?: number | undefined
    limit?: number | undefined
    pages?: string | undefined
  }) => string
}
export declare const CYBER_RISK_MITIGATION_REMINDER =
  '\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.\n</system-reminder>\n'
type ImageResult = {
  type: 'image'
  file: {
    base64: string
    type: Base64ImageSource['media_type']
    originalSize: number
    dimensions?: ImageDimensions
  }
}
/**
 * Reads an image file and applies token-based compression if needed.
 * Reads the file ONCE, then applies standard resize. If the result exceeds
 * the token limit, applies aggressive compression from the same buffer.
 *
 * @param filePath - Path to the image file
 * @param maxTokens - Maximum token budget for the image
 * @returns Image data with appropriate compression applied
 */
export declare function readImageWithTokenBudget(
  filePath: string,
  maxTokens?: number,
  maxBytes?: number,
): Promise<ImageResult>
export {}
