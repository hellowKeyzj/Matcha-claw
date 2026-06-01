/**
 * SDK Control Types — inferred from Zod schemas in controlSchemas.ts / coreSchemas.ts.
 *
 * These types define the control protocol between the CLI bridge and the server.
 * Used by bridge/transport layer, remote session manager, and CLI print/IO paths.
 */
import type { z } from 'zod'
import type {
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlReloadPluginsResponseSchema,
  SDKControlPermissionRequestSchema,
  SDKControlReadFileContentResponseSchema,
  SDKControlReadFileResponseSchema,
  SDKControlMcpAuthenticateResponseSchema,
  SDKControlClaudeAuthenticateResponseSchema,
  SDKControlBackgroundTasksResponseSchema,
  SDKControlGenerateSessionTitleResponseSchema,
  SDKControlSideQuestionResponseSchema,
  SDKControlRemoteControlResponseSchema,
  SDKControlCancelRequestSchema,
  SDKControlRequestInnerSchema,
  StdoutMessageSchema,
  StdinMessageSchema,
} from './controlSchemas.js'
import type { SDKPartialAssistantMessageSchema } from './coreSchemas.js'

export type SDKControlRequest = z.infer<
  ReturnType<typeof SDKControlRequestSchema>
>
export type SDKControlResponse = z.infer<
  ReturnType<typeof SDKControlResponseSchema>
>
export type StdoutMessage = z.infer<ReturnType<typeof StdoutMessageSchema>>
export type SDKControlInitializeRequest = z.infer<
  ReturnType<typeof SDKControlInitializeRequestSchema>
>
export type SDKControlInitializeResponse = z.infer<
  ReturnType<typeof SDKControlInitializeResponseSchema>
>
export type SDKControlMcpSetServersResponse = z.infer<
  ReturnType<typeof SDKControlMcpSetServersResponseSchema>
>
export type SDKControlReloadPluginsResponse = z.infer<
  ReturnType<typeof SDKControlReloadPluginsResponseSchema>
>
export type SDKControlReadFileResponse = z.infer<
  ReturnType<typeof SDKControlReadFileResponseSchema>
>
export type SDKControlReadFileContentResponse = z.infer<
  ReturnType<typeof SDKControlReadFileContentResponseSchema>
>
export type SDKControlMcpAuthenticateResponse = z.infer<
  ReturnType<typeof SDKControlMcpAuthenticateResponseSchema>
>
export type SDKControlClaudeAuthenticateResponse = z.infer<
  ReturnType<typeof SDKControlClaudeAuthenticateResponseSchema>
>
export type SDKControlBackgroundTasksResponse = z.infer<
  ReturnType<typeof SDKControlBackgroundTasksResponseSchema>
>
export type SDKControlGenerateSessionTitleResponse = z.infer<
  ReturnType<typeof SDKControlGenerateSessionTitleResponseSchema>
>
export type SDKControlSideQuestionResponse = z.infer<
  ReturnType<typeof SDKControlSideQuestionResponseSchema>
>
export type SDKControlRemoteControlResponse = z.infer<
  ReturnType<typeof SDKControlRemoteControlResponseSchema>
>
export type StdinMessage = z.infer<ReturnType<typeof StdinMessageSchema>>
export type SDKPartialAssistantMessage = z.infer<
  ReturnType<typeof SDKPartialAssistantMessageSchema>
>
export type SDKControlPermissionRequest = z.infer<
  ReturnType<typeof SDKControlPermissionRequestSchema>
>
export type SDKControlCancelRequest = z.infer<
  ReturnType<typeof SDKControlCancelRequestSchema>
>
export type SDKControlRequestInner = z.infer<
  ReturnType<typeof SDKControlRequestInnerSchema>
>
