import { z } from 'zod/v4'
import type { Tool } from 'src/Tool.js'
declare const inputSchema: () => z.ZodObject<
  {
    to: z.ZodString
    summary: z.ZodOptional<z.ZodString>
    message: z.ZodUnion<
      readonly [
        z.ZodString,
        z.ZodDiscriminatedUnion<
          [
            z.ZodObject<
              {
                type: z.ZodLiteral<'shutdown_request'>
                reason: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >,
            z.ZodObject<
              {
                type: z.ZodLiteral<'shutdown_response'>
                request_id: z.ZodString
                approve: z.ZodPipe<
                  z.ZodTransform<unknown, unknown>,
                  z.ZodType<
                    unknown,
                    unknown,
                    z.core.$ZodTypeInternals<unknown, unknown>
                  >
                >
                reason: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >,
            z.ZodObject<
              {
                type: z.ZodLiteral<'plan_approval_response'>
                request_id: z.ZodString
                approve: z.ZodPipe<
                  z.ZodTransform<unknown, unknown>,
                  z.ZodType<
                    unknown,
                    unknown,
                    z.core.$ZodTypeInternals<unknown, unknown>
                  >
                >
                feedback: z.ZodOptional<z.ZodString>
              },
              z.core.$strip
            >,
          ],
          'type'
        >,
      ]
    >
  },
  z.core.$strip
>
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>
export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}
export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
}
export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  routing?: MessageRouting
}
export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}
export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}
export type SendMessageToolOutput =
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput
export declare const SendMessageTool: Tool<InputSchema, SendMessageToolOutput>
export {}
