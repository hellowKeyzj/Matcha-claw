import { z } from 'zod/v4'
/**
 * Discriminated union of all LSP operations
 * Uses 'operation' as the discriminator field
 */
export declare const lspToolInputSchema: () => z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        operation: z.ZodLiteral<'goToDefinition'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        operation: z.ZodLiteral<'findReferences'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        operation: z.ZodLiteral<'hover'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        operation: z.ZodLiteral<'documentSymbol'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        operation: z.ZodLiteral<'workspaceSymbol'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        operation: z.ZodLiteral<'goToImplementation'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        operation: z.ZodLiteral<'prepareCallHierarchy'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        operation: z.ZodLiteral<'incomingCalls'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        operation: z.ZodLiteral<'outgoingCalls'>
        filePath: z.ZodString
        line: z.ZodNumber
        character: z.ZodNumber
      },
      z.core.$strict
    >,
  ],
  'operation'
>
/**
 * TypeScript type for LSPTool input
 */
export type LSPToolInput = z.infer<ReturnType<typeof lspToolInputSchema>>
/**
 * Type guard to check if an operation is a valid LSP operation
 */
export declare function isValidLSPOperation(
  operation: string,
): operation is LSPToolInput['operation']
