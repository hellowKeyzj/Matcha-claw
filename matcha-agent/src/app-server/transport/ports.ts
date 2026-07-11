import type {
  AppServerEventEnvelope,
  ApprovalRespondParams,
  EventsReplayParams,
  EventsSubscribeParams,
  InitializeParams,
  InitializeResult,
  ModelsListParams,
  SessionCancelParams,
  SessionCloseParams,
  SessionCreateParams,
  SessionLoadParams,
  SessionPromptParams,
  SessionRecord,
  SessionSetModeParams,
  SessionSetModelParams,
  SessionSnapshot,
  SessionSnapshotParams,
  SessionTranscriptParams,
} from '../protocol/types.js'

export type SessionListResult = {
  sessions: SessionRecord[]
}

export type SessionPromptResult = {
  runId: string
}

export type SessionTranscriptResult = {
  lines: string[]
}

export type EventsReplayResult = {
  events: AppServerEventEnvelope[]
}

export type EventsSubscribeResult =
  | {
      resultType: 'subscribed'
      clientId: string
      sessionId: string
      afterSeq?: number
      replayed?: AppServerEventEnvelope[]
    }
  | { resultType: 'clientNotFound'; clientId: string }
  | { resultType: 'clientRequired' }

export type ModelsListResult = {
  models: string[]
}

export type AppServerPorts = {
  initialize(
    params: InitializeParams,
  ): InitializeResult | Promise<InitializeResult>
  session: {
    create(params: SessionCreateParams): SessionRecord | Promise<SessionRecord>
    load(params: SessionLoadParams): SessionRecord | Promise<SessionRecord>
    list(): SessionListResult | Promise<SessionListResult>
    close(params: SessionCloseParams): SessionRecord | Promise<SessionRecord>
    prompt(
      params: SessionPromptParams,
    ): SessionPromptResult | Promise<SessionPromptResult>
    transcript(
      params: SessionTranscriptParams,
    ): SessionTranscriptResult | Promise<SessionTranscriptResult>
    cancel(params: SessionCancelParams): unknown | Promise<unknown>
    snapshot(
      params: SessionSnapshotParams,
    ): SessionSnapshot | Promise<SessionSnapshot>
    setModel(
      params: SessionSetModelParams,
    ): SessionRecord | Promise<SessionRecord>
    setMode(
      params: SessionSetModeParams,
    ): SessionRecord | Promise<SessionRecord>
  }
  events: {
    replay?(
      params: EventsReplayParams,
    ): EventsReplayResult | Promise<EventsReplayResult>
    subscribe(
      clientId: string | undefined,
      params: EventsSubscribeParams,
    ): EventsSubscribeResult | Promise<EventsSubscribeResult>
  }
  approval: {
    respond(params: ApprovalRespondParams): unknown | Promise<unknown>
  }
  models: {
    list(params: ModelsListParams): ModelsListResult | Promise<ModelsListResult>
  }
}
