import { z } from 'zod/v4'
import type { TaskType } from 'src/Task.js'
import type { Tool } from 'src/Tool.js'
declare const inputSchema: () => z.ZodObject<
  {
    task_id: z.ZodString
    block: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodDefault<z.ZodBoolean>
    >
    timeout: z.ZodDefault<z.ZodNumber>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
type TaskOutput = {
  task_id: string
  task_type: TaskType
  status: string
  description: string
  output: string
  exitCode?: number | null
  error?: string
  prompt?: string
  result?: string
}
type TaskOutputToolOutput = {
  retrieval_status: 'success' | 'timeout' | 'not_ready'
  task: TaskOutput | null
}
export type { TaskOutputProgress as Progress } from 'src/types/tools.js'
export declare const TaskOutputTool: Tool<InputSchema, TaskOutputToolOutput>
export default TaskOutputTool
