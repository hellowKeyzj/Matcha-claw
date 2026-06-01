import { z } from 'zod/v4'
declare const inputSchema: () => z.ZodObject<
  {
    file_path: z.ZodString
    old_string: z.ZodString
    new_string: z.ZodString
    replace_all: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodOptional<z.ZodDefault<z.ZodBoolean>>
    >
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
export type FileEditInput = z.output<InputSchema>
export type EditInput = Omit<FileEditInput, 'file_path'>
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}
export declare const hunkSchema: () => z.ZodObject<
  {
    oldStart: z.ZodNumber
    oldLines: z.ZodNumber
    newStart: z.ZodNumber
    newLines: z.ZodNumber
    lines: z.ZodArray<z.ZodString>
  },
  z.core.$strip
>
export declare const gitDiffSchema: () => z.ZodObject<
  {
    filename: z.ZodString
    status: z.ZodEnum<{
      added: 'added'
      modified: 'modified'
    }>
    additions: z.ZodNumber
    deletions: z.ZodNumber
    changes: z.ZodNumber
    patch: z.ZodString
    repository: z.ZodOptional<z.ZodNullable<z.ZodString>>
  },
  z.core.$strip
>
declare const outputSchema: () => z.ZodObject<
  {
    filePath: z.ZodString
    oldString: z.ZodString
    newString: z.ZodString
    originalFile: z.ZodString
    structuredPatch: z.ZodArray<
      z.ZodObject<
        {
          oldStart: z.ZodNumber
          oldLines: z.ZodNumber
          newStart: z.ZodNumber
          newLines: z.ZodNumber
          lines: z.ZodArray<z.ZodString>
        },
        z.core.$strip
      >
    >
    userModified: z.ZodBoolean
    replaceAll: z.ZodBoolean
    gitDiff: z.ZodOptional<
      z.ZodObject<
        {
          filename: z.ZodString
          status: z.ZodEnum<{
            added: 'added'
            modified: 'modified'
          }>
          additions: z.ZodNumber
          deletions: z.ZodNumber
          changes: z.ZodNumber
          patch: z.ZodString
          repository: z.ZodOptional<z.ZodNullable<z.ZodString>>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type FileEditOutput = z.infer<OutputSchema>
export { inputSchema, outputSchema }
