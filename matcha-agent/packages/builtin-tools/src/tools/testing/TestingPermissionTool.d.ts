/**
 * This testing-only tool will always pop up a permission dialog when called by
 * the model.
 */
import { z } from 'zod/v4'
import type { Tool } from 'src/Tool.js'
declare const inputSchema: () => z.ZodObject<{}, z.core.$strict>
type InputSchema = ReturnType<typeof inputSchema>
export declare const TestingPermissionTool: Tool<InputSchema, string>
export {}
