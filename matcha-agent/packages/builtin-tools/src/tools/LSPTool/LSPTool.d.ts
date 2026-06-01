import { z } from 'zod/v4'
import type { ValidationResult } from 'src/Tool.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'
/**
 * Tool-compatible input schema (regular ZodObject instead of discriminated union)
 * We validate against the discriminated union in validateInput for better error messages
 */
declare const inputSchema: () => z.ZodObject<
  {
    operation: z.ZodEnum<{
      hover: 'hover'
      goToDefinition: 'goToDefinition'
      findReferences: 'findReferences'
      documentSymbol: 'documentSymbol'
      workspaceSymbol: 'workspaceSymbol'
      goToImplementation: 'goToImplementation'
      prepareCallHierarchy: 'prepareCallHierarchy'
      incomingCalls: 'incomingCalls'
      outgoingCalls: 'outgoingCalls'
    }>
    filePath: z.ZodString
    line: z.ZodNumber
    character: z.ZodNumber
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    operation: z.ZodEnum<{
      hover: 'hover'
      goToDefinition: 'goToDefinition'
      findReferences: 'findReferences'
      documentSymbol: 'documentSymbol'
      workspaceSymbol: 'workspaceSymbol'
      goToImplementation: 'goToImplementation'
      prepareCallHierarchy: 'prepareCallHierarchy'
      incomingCalls: 'incomingCalls'
      outgoingCalls: 'outgoingCalls'
    }>
    result: z.ZodString
    filePath: z.ZodString
    resultCount: z.ZodOptional<z.ZodNumber>
    fileCount: z.ZodOptional<z.ZodNumber>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export type Input = z.infer<InputSchema>
export declare const LSPTool: Omit<
  {
    name: 'LSP'
    searchHint: string
    maxResultSizeChars: number
    isLsp: true
    description(): Promise<string>
    userFacingName: typeof userFacingName
    shouldDefer: true
    isEnabled(): boolean
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    isConcurrencySafe(): true
    isReadOnly(): true
    getPath({
      filePath,
    }: {
      operation:
        | 'hover'
        | 'goToDefinition'
        | 'findReferences'
        | 'documentSymbol'
        | 'workspaceSymbol'
        | 'goToImplementation'
        | 'prepareCallHierarchy'
        | 'incomingCalls'
        | 'outgoingCalls'
      filePath: string
      line: number
      character: number
    }): string
    validateInput(input: Input): Promise<ValidationResult>
    checkPermissions(
      input: {
        operation:
          | 'hover'
          | 'goToDefinition'
          | 'findReferences'
          | 'documentSymbol'
          | 'workspaceSymbol'
          | 'goToImplementation'
          | 'prepareCallHierarchy'
          | 'incomingCalls'
          | 'outgoingCalls'
        filePath: string
        line: number
        character: number
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<PermissionDecision>
    prompt(): Promise<string>
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
    renderToolResultMessage: typeof renderToolResultMessage
    call(
      input: Input,
      _context: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        operation:
          | 'hover'
          | 'goToDefinition'
          | 'findReferences'
          | 'documentSymbol'
          | 'workspaceSymbol'
          | 'goToImplementation'
          | 'prepareCallHierarchy'
          | 'incomingCalls'
          | 'outgoingCalls'
        result: string
        filePath: string
        resultCount?: number | undefined
        fileCount?: number | undefined
      }
    }>
    mapToolResultToToolResultBlockParam(
      output: {
        operation:
          | 'hover'
          | 'goToDefinition'
          | 'findReferences'
          | 'documentSymbol'
          | 'workspaceSymbol'
          | 'goToImplementation'
          | 'prepareCallHierarchy'
          | 'incomingCalls'
          | 'outgoingCalls'
        result: string
        filePath: string
        resultCount?: number | undefined
        fileCount?: number | undefined
      },
      toolUseID: string,
    ): {
      tool_use_id: string
      type: 'tool_result'
      content: string
    }
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
      operation:
        | 'hover'
        | 'goToDefinition'
        | 'findReferences'
        | 'documentSymbol'
        | 'workspaceSymbol'
        | 'goToImplementation'
        | 'prepareCallHierarchy'
        | 'incomingCalls'
        | 'outgoingCalls'
      filePath: string
      line: number
      character: number
    },
    context: import('src/Tool.js').ToolUseContext,
  ) => Promise<PermissionDecision>
  toAutoClassifierInput: (_input?: unknown) => string
}
export {}
