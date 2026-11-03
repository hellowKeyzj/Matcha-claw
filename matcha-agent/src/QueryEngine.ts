import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import type { BetaMessageDeltaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { accumulateUsage, updateUsage } from 'src/services/api/claude.js'
import type { NonNullableUsage } from '@ant/model-provider'
import { EMPTY_USAGE } from '@ant/model-provider'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { APIError } from '@anthropic-ai/sdk'
import type {
  Message,
  StreamEvent,
  SystemCompactBoundaryMessage,
} from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import { currentInvestigation } from './world/investigation.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { debugIdentifierHash, traceSessionTiming } from './utils/debug.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import {
  countToolCalls,
  SYNTHETIC_MESSAGES,
  SYNTHETIC_MODEL,
} from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { getAPIProvider } from './utils/model/providers.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

// Lazy: MessageSelector.tsx pulls React/ink; only needed for message filtering at query time
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector = ():
  | typeof import('src/components/MessageSelector.js')
  | null => {
  try {
    return require('src/components/MessageSelector.js')
  } catch {
    return null
  }
}

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// Dead code elimination: conditional import for coordinator mode
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

// Dead code elimination: conditional import for snip compaction
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const snipProjection = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipProjection.js') as typeof import('./services/compact/snipProjection.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  refreshTools?: () => Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  /** Handler for URL elicitations triggered by MCP tool -32042 errors. */
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  setSDKStatus?: (status: SDKStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  /**
   * Snip-boundary handler: receives each yielded system message plus the
   * current mutableMessages store. Returns undefined if the message is not a
   * snip boundary; otherwise returns the replayed snip result. Injected by
   * ask() when HISTORY_SNIP is enabled so feature-gated strings stay inside
   * the gated module (keeps QueryEngine free of excluded strings and testable
   * despite feature() returning false under bun test). SDK-only: the REPL
   * keeps full history for UI scrollback and projects on demand via
   * projectSnippedView; QueryEngine truncates here to bound memory in long
   * headless sessions (no UI to preserve).
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine owns the query lifecycle and session state for a conversation.
 * It extracts the core logic from ask() into a standalone class that can be
 * used by both the headless/SDK path and (in a future phase) the REPL.
 *
 * One QueryEngine per conversation. Each submitMessage() call starts a new
 * turn within the same conversation. State (messages, file cache, usage, etc.)
 * persists across turns.
 */
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  // Turn-scoped skill discovery tracking (feeds was_discovered on
  // tengu_skill_tool_invocation). Must persist across the two
  // processUserInputContext rebuilds inside submitMessage, but is cleared
  // at the start of each submitMessage to avoid unbounded growth across
  // many turns in SDK mode.
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }

  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools: configuredTools,
      refreshTools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config
    const tools = refreshTools?.() ?? configuredTools

    this.discoveredSkillNames.clear()
    this.permissionDenials = []
    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()
    const nativeStartedAt = performance.now()
    const inputMessageId = options?.uuid ?? randomUUID()
    const tracing = process.env.MATCHACLAW_TRACE === '1'
    const traceInputHash = tracing ? debugIdentifierHash(inputMessageId) : undefined
    let tracedFirstStreamEvent = false
    let tracedFirstContentDelta = false
    let tracedAssistantResponseId: string | undefined
    const nativeInvestigation = currentInvestigation() !== undefined
    const tokenFields = [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ] as const
    type TokenField = (typeof tokenFields)[number]
    const nativeTotals: Partial<Record<TokenField, number>> = {}
    const nativeMissing = new Set<TokenField>()
    const nativeResponses = new Map<string, Record<string, unknown>>()
    const nativeSettled = new Set<string>()
    const rawAnthropic = [
      'firstParty',
      'bedrock',
      'vertex',
      'foundry',
    ].includes(getAPIProvider())
    let nativeIncomplete = false
    let nativePending = false
    const nativeResult = (complete = false) => ({
      input_message_id: inputMessageId,
      native_measurement: {
        scope: 'native_query' as const,
        coverage: 'foreground_query_responses' as const,
        complete:
          complete &&
          !nativeIncomplete &&
          !nativePending &&
          !this.abortController.signal.aborted &&
          [...nativeResponses.keys()].every(id => nativeSettled.has(id)),
        elapsed_ms: {
          availability: 'available' as const,
          value: Math.max(0, Math.floor(performance.now() - nativeStartedAt)),
          provenance: 'query_monotonic_clock',
        },
        ...Object.fromEntries(
          tokenFields.map(field => [
            field,
            nativeTotals[field] !== undefined &&
            !nativeMissing.has(field) &&
            !nativeIncomplete &&
            !nativePending &&
            !this.abortController.signal.aborted &&
            [...nativeResponses.keys()].every(id => nativeSettled.has(id))
              ? {
                  availability: 'available',
                  value: nativeTotals[field],
                  provenance: 'native_response_usage',
                }
              : {
                  availability: 'unavailable',
                  provenance: 'native_response_usage',
                  reason: 'raw_usage_missing_or_incomplete',
                },
          ]),
        ),
        ...Object.fromEntries(
          ['cost', 'model_calls', 'steps', 'source_reads', 'rows', 'bytes'].map(
            field => [
              field,
              {
                availability: 'unavailable',
                provenance: 'native_query',
                reason: 'not_measured',
              },
            ],
          ),
        ),
      },
    })

    // Wrap canUseTool to track permission denials
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // Track denials for SDK reporting
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          type: 'permission_denial',
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    const initialAppState = getAppState()
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    headlessProfilerCheckpoint('before_getSystemPrompt')
    // Narrow once so TS tracks the type through the conditionals below.
    const customPrompt =
      typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    // When an SDK caller provides a custom system prompt AND has set
    // CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, inject the memory-mechanics prompt.
    // The env var is an explicit opt-in signal — the caller has wired up
    // a memory directory and needs Claude to know how to use it (which
    // Write/Edit tools to call, MEMORY.md filename, loading semantics).
    // The caller can layer their own policy text via appendSystemPrompt.
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    // Register function hook for structured output enforcement
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // Slash commands that mutate the message array (e.g. /force-snip)
      // call setMessages(fn).  In interactive mode this writes back to
      // AppState; in print mode we write back to mutableMessages so the
      // rest of the query loop (push at :389, snapshot at :392) sees
      // the result.  The second processUserInputContext below (after
      // slash-command processing) keeps the no-op — nothing else calls
      // setMessages past that point.
      setMessages: fn => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // we use stdout, so don't want to clobber it
        tools,
        refreshTools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: (
        updater: (prev: FileHistoryState) => FileHistoryState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (
        updater: (prev: AttributionState) => AttributionState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    // Handle orphaned permission (only once per engine lifetime)
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: inputMessageId,
      isMeta: options?.isMeta,
      querySource: 'sdk',
    })

    // Push new messages, including user input and any attachments
    this.mutableMessages.push(...messagesFromUserInput)

    // Update params to reflect updates from processing /slash commands
    const messages = [...this.mutableMessages]

    // Persist the user's message(s) to transcript BEFORE entering the query
    // loop. The for-await below only calls recordTranscript when ask() yields
    // an assistant/user/compact_boundary message — which doesn't happen until
    // the API responds. If the process is killed before that (e.g. user clicks
    // Stop in cowork seconds after send), the transcript is left with only
    // queue-operation entries; getLastSessionLog filters those out, returns
    // null, and --resume fails with "No conversation found". Writing now makes
    // the transcript resumable from the point the user message was accepted,
    // even if no API response ever arrives.
    //
    // --bare / SIMPLE: fire-and-forget. Scripted calls don't --resume after
    // kill-mid-request. The await is ~4ms on SSD, ~30ms under disk contention
    // — the single largest controllable critical-path cost after module eval.
    // Transcript is still written (for post-hoc debugging); just not blocking.
    if (persistSession && messagesFromUserInput.length > 0) {
      const recordStartedAt = tracing ? performance.now() : 0
      traceSessionTiming('query.input.record.begin', () => ({
        inputHash: traceInputHash,
        entryCount: messages.length,
        inputEntryCount: messagesFromUserInput.length,
        awaited: !isBareMode() || nativeInvestigation,
      }))
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode() && !nativeInvestigation) {
        void transcriptPromise
        traceSessionTiming('query.input.record.detached', () => ({ inputHash: traceInputHash }))
      } else {
        await transcriptPromise
        traceSessionTiming('query.input.record.end', () => ({
          inputHash: traceInputHash,
          elapsedMs: performance.now() - recordStartedAt,
        }))
        if (
          nativeInvestigation ||
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          const flushStartedAt = tracing ? performance.now() : 0
          traceSessionTiming('query.input.flush.begin', () => ({ inputHash: traceInputHash }))
          await flushSessionStorage()
          traceSessionTiming('query.input.flush.end', () => ({
            inputHash: traceInputHash,
            elapsedMs: performance.now() - flushStartedAt,
          }))
        }
      }
    }

    // Filter messages that should be acknowledged after transcript
    const _selector = messageSelector()
    const replayableMessages = messagesFromUserInput.filter(
      msg =>
        (msg.type === 'user' &&
          !msg.isMeta && // Skip synthetic caveat messages
          !msg.toolUseResult && // Skip tool results (they'll be acked from query)
          (_selector?.selectableUserMessagesFilter(msg) ?? true)) || // Skip non-user-authored messages (task notifications, etc.)
        (msg.type === 'system' && msg.subtype === 'compact_boundary'), // Always ack compact boundaries
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []
    let hasAcknowledgedInitialMessages = false
    function* acknowledgeInitialMessages(): Generator<SDKUserMessageReplay> {
      if (hasAcknowledgedInitialMessages || messagesToAck.length === 0) return
      hasAcknowledgedInitialMessages = true
      for (const msgToAck of messagesToAck) {
        if (msgToAck.type === 'user') {
          traceSessionTiming('query.input.ack', () => ({
            inputHash: traceInputHash,
            messageHash: debugIdentifierHash(msgToAck.uuid),
            persistenceEnabled: persistSession,
          }))
          yield {
            type: 'user',
            message: msgToAck.message,
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msgToAck.uuid,
            timestamp: msgToAck.timestamp,
            isReplay: true,
          } as unknown as SDKUserMessageReplay
        }
      }
    }
    yield* acknowledgeInitialMessages()

    // Update the ToolPermissionContext based on user input processing (as necessary)
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // Recreate after processing the prompt to pick up updated messages and
    // model (from slash commands).
    processUserInputContext = {
      messages,
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        refreshTools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    headlessProfilerCheckpoint('before_skills_plugins')
    // Cache-only: headless/SDK/CCR startup must not block on network for
    // ref-tracked plugins. CCR populates the cache via CLAUDE_CODE_SYNC_PLUGIN_INSTALL
    // (headlessPluginInstall) or CLAUDE_CODE_PLUGIN_SEED_DIR before this runs;
    // SDK callers that need fresh source can call /reload-plugins.
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')

    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext
        .mode as PermissionMode, // TODO: avoid the cast
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
      fastMode: initialAppState.fastMode,
    })

    // Record when system message is yielded for headless latency tracking
    headlessProfilerCheckpoint('system_message_yielded')

    if (!shouldQuery) {
      // Return the results of local slash commands.
      // Use messagesFromUserInput (not replayableMessages) for command output
      // because selectableUserMessagesFilter excludes local-command-stdout tags.
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === 'user' &&
          typeof msg.message!.content === 'string' &&
          (msg.message!.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message!.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: 'user',
            message: {
              ...msg.message,
              content: stripAnsi(msg.message!.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as unknown as SDKUserMessageReplay
        }

        // Local command output — yield as a synthetic assistant message so
        // RC renders it as assistant-style text rather than a user bubble.
        // Emitted as assistant (not the dedicated SDKLocalCommandOutputMessage
        // system subtype) so mobile clients + session-ingress can parse it.
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          const compactMsg = msg as SystemCompactBoundaryMessage
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(compactMsg.compactMetadata),
          } as unknown as SDKCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      traceSessionTiming('query.result.ready', () => ({
        inputHash: traceInputHash, outcome: 'success', resultKind: 'local_command',
      }))
      yield {
        type: 'result',
        ...nativeResult(true),
        subtype: 'success',
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
      }
      return
    }

    if (fileHistoryEnabled() && persistSession) {
      const _sel = messageSelector()
      const _filter =
        _sel?.selectableUserMessagesFilter ?? ((_msg: unknown) => true)
      messagesFromUserInput.filter(_filter).forEach(message => {
        void fileHistoryMakeSnapshot(
          (updater: (prev: FileHistoryState) => FileHistoryState) => {
            setAppState(prev => ({
              ...prev,
              fileHistory: updater(prev.fileHistory),
            }))
          },
          message.uuid,
        )
      })
    }

    // Stream usage is provisional until completion; fallback assistants are
    // already complete. Both paths settle once per response, not content block.
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    let currentMessageId: string | undefined
    let currentMessageStopReason: string | null = null
    let currentAssistantMessage: Message | undefined
    let hasInputUsage = false
    let hasOutputUsage = false
    const settledMessageIds = new Set<string>()
    const settleUsage = (
      id: string | undefined,
      usage: NonNullable<Message['message']>['usage'],
    ) => {
      if (
        !id ||
        settledMessageIds.has(id) ||
        typeof usage?.input_tokens !== 'number' ||
        typeof usage.output_tokens !== 'number'
      ) {
        return
      }
      const completeUsage = updateUsage(
        EMPTY_USAGE,
        usage as BetaMessageDeltaUsage,
      )
      this.totalUsage = accumulateUsage(this.totalUsage, {
        ...completeUsage,
        service_tier:
          typeof usage.service_tier === 'string'
            ? usage.service_tier
            : completeUsage.service_tier,
        inference_geo:
          typeof usage.inference_geo === 'string'
            ? usage.inference_geo
            : completeUsage.inference_geo,
      })
      settledMessageIds.add(id)
      const raw = nativeResponses.get(id) ?? {}
      nativeResponses.set(id, raw)
      nativeSettled.add(id)
      nativePending = false
      for (const field of tokenFields) {
        const value = raw[field]
        const total = (nativeTotals[field] ?? 0) + Number(value)
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < 0 ||
          !Number.isSafeInteger(total)
        ) {
          nativeMissing.add(field)
        } else {
          nativeTotals[field] = total
        }
      }
    }
    const settleAssistantUsage = (msg: Message | undefined) => {
      if (
        msg?.message?.model !== SYNTHETIC_MODEL &&
        msg?.message?.stop_reason != null
      ) {
        if (msg.message.id && !nativeResponses.has(msg.message.id)) {
          nativeResponses.set(
            msg.message.id,
            rawAnthropic ? { ...msg.message.usage } : {},
          )
        }
        settleUsage(msg.message.id, msg.message.usage)
      }
    }
    const settleCompletedUsage = () => {
      if (currentMessageStopReason != null && hasInputUsage && hasOutputUsage) {
        settleUsage(currentMessageId, currentMessageUsage)
      }
      // Claude mutates the last block before yielding its terminal delta.
      settleAssistantUsage(currentAssistantMessage)
    }
    let turnCount = 1
    // Track structured output from StructuredOutput tool calls
    let structuredOutputFromTool: unknown
    // Track the last stop_reason from assistant messages
    let lastStopReason: string | null = null
    // Reference-based watermark so error_during_execution's errors[] is
    // turn-scoped. A length-based index breaks when the 100-entry ring buffer
    // shift()s during the turn — the index slides. If this entry is rotated
    // out, lastIndexOf returns -1 and we include everything (safe fallback).
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // Snapshot count before this query for delta-based retry limiting
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    const queryMessages = query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })
    async function* withUsageSettlement() {
      try {
        yield* queryMessages
      } catch (error) {
        traceSessionTiming('query.failed', () => ({
          inputHash: traceInputHash,
          failure: 'query_iteration',
          aborted: processUserInputContext.abortController.signal.aborted,
        }))
        throw error
      } finally {
        settleCompletedUsage()
        traceSessionTiming('query.iteration.end', () => ({
          inputHash: traceInputHash,
          elapsedMs: performance.now() - nativeStartedAt,
        }))
      }
    }

    for await (const message of withUsageSettlement()) {
      // Record assistant, user, and compact boundary messages
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        // Before writing a compact boundary, flush any in-memory-only
        // messages up through the preservedSegment tail. Attachments and
        // progress are now recorded inline (their switch cases below), but
        // this flush still matters for the preservedSegment tail walk.
        // If the SDK subprocess restarts before then (claude-desktop kills
        // between turns), tailUuid points to a never-written message →
        // applyPreservedSegmentRelinks fails its tail→head walk → returns
        // without pruning → resume loads full pre-compact history.
        if (
          persistSession &&
          message.type === 'system' &&
          message.subtype === 'compact_boundary'
        ) {
          const compactMsg = message as SystemCompactBoundaryMessage
          const tailUuid =
            compactMsg.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex(
              m => m.uuid === tailUuid,
            )
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message as Message)
        if (persistSession) {
          // Fire-and-forget for assistant messages. claude.ts yields one
          // assistant message per content block, then mutates the last
          // one's message.usage/stop_reason on message_delta — relying on
          // the write queue's 100ms lazy jsonStringify. Awaiting here
          // blocks ask()'s generator, so message_delta can't run until
          // every block is consumed; the drain timer (started at block 1)
          // elapses first. Interactive CC doesn't hit this because
          // useLogMessages.ts fire-and-forgets. enqueueWrite is
          // order-preserving so fire-and-forget here is safe.
          if (message.type === 'assistant') {
            if (tracing) {
              const assistant = message as Message
              const responseId = assistant.message?.id || assistant.uuid
              if (responseId !== tracedAssistantResponseId) {
                tracedAssistantResponseId = responseId
                traceSessionTiming('query.assistant.record.begin', () => ({
                  inputHash: traceInputHash,
                  assistantHash: debugIdentifierHash(assistant.uuid),
                  providerMessageHash: assistant.message?.id
                    ? debugIdentifierHash(assistant.message.id) : undefined,
                  entryCount: messages.length,
                  awaited: false,
                }))
              }
            }
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }
      }

      if (message.type === 'user') {
        turnCount++
      }

      switch (message.type) {
        case 'tombstone':
          // Tombstone messages are control signals for removing messages, skip them
          break
        case 'assistant': {
          // Capture stop_reason if already set (synthetic messages). For
          // streamed responses, this is null at content_block_stop time;
          // the real value arrives via message_delta (handled below).
          const msg = message as Message
          const stopReason = msg.message?.stop_reason as
            | string
            | null
            | undefined
          if (stopReason != null) {
            lastStopReason = stopReason
          }
          if (msg.message?.model !== SYNTHETIC_MODEL) {
            currentAssistantMessage = msg
            if (msg.message?.id !== currentMessageId) {
              settleAssistantUsage(msg)
            }
          }
          this.mutableMessages.push(msg)
          yield* normalizeMessage(msg)
          break
        }
        case 'progress': {
          const msg = message as Message
          this.mutableMessages.push(msg)
          // Record inline so the dedup loop in the next ask() call sees it
          // as already-recorded. Without this, deferred progress interleaves
          // with already-recorded tool_results in mutableMessages, and the
          // dedup walk freezes startingParentUuid at the wrong message —
          // forking the chain and orphaning the conversation on resume.
          if (persistSession) {
            messages.push(msg)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(msg)
          break
        }
        case 'user': {
          const msg = message as Message
          this.mutableMessages.push(msg)
          yield* normalizeMessage(msg)
          break
        }
        case 'stream_event': {
          const event = (
            message as unknown as { event: Record<string, unknown> }
          ).event
          if (tracing) {
            const milestone = event.type === 'message_start' ? 'message_start'
              : event.type === 'message_stop' ? 'message_stop'
              : event.type === 'message_delta' &&
                  (event.delta as { stop_reason?: string | null })?.stop_reason != null
                ? 'stop_delta'
              : event.type === 'content_block_delta' && !tracedFirstContentDelta
                ? 'first_content_delta' : undefined
            if (!tracedFirstStreamEvent || milestone) {
              traceSessionTiming('query.stream.milestone', () => {
                const providerId = event.type === 'message_start'
                  ? (event.message as { id?: string }).id : currentMessageId
                return {
                  inputHash: traceInputHash,
                  milestone: milestone ?? 'first_event',
                  firstEvent: !tracedFirstStreamEvent,
                  providerMessageHash: providerId ? debugIdentifierHash(providerId) : undefined,
                  assistantHash: event.type !== 'message_start' && currentAssistantMessage?.uuid
                    ? debugIdentifierHash(currentAssistantMessage.uuid) : undefined,
                }
              })
            }
            tracedFirstStreamEvent = true
            if (event.type === 'message_start') tracedFirstContentDelta = false
            if (event.type === 'content_block_delta') tracedFirstContentDelta = true
          }
          if (event.type === 'message_start') {
            const eventMessage = event.message as {
              id?: string
              usage?: BetaMessageDeltaUsage
            }
            currentMessageId = eventMessage.id
            if (currentMessageId) {
              const raw = rawAnthropic ? { ...eventMessage.usage } : {}
              delete raw.output_tokens
              nativeResponses.set(currentMessageId, raw)
            }
            currentMessageStopReason = null
            currentAssistantMessage = undefined
            hasInputUsage = typeof eventMessage.usage?.input_tokens === 'number'
            hasOutputUsage = false
            currentMessageUsage = updateUsage(EMPTY_USAGE, eventMessage.usage)
          }
          if (event.type === 'message_delta') {
            const usage = event.usage as BetaMessageDeltaUsage | undefined
            if (rawAnthropic && currentMessageId && usage) {
              const raw = nativeResponses.get(currentMessageId) ?? {}
              for (const field of tokenFields) {
                if (
                  usage[field] !== undefined &&
                  (field === 'output_tokens' || raw[field] === undefined)
                ) {
                  raw[field] = usage[field]
                }
              }
              nativeResponses.set(currentMessageId, raw)
            }
            hasInputUsage ||= typeof usage?.input_tokens === 'number'
            hasOutputUsage ||= typeof usage?.output_tokens === 'number'
            currentMessageUsage = updateUsage(currentMessageUsage, usage)
            // Capture stop_reason from message_delta. The assistant message
            // is yielded at content_block_stop with stop_reason=null; the
            // real value only arrives here (see claude.ts message_delta
            // handler). Without this, result.stop_reason is always null.
            const delta = event.delta as { stop_reason?: string | null }
            if (delta.stop_reason != null) {
              lastStopReason = delta.stop_reason
              currentMessageStopReason = delta.stop_reason
            }
          }
          if (event.type === 'message_stop') {
            nativeIncomplete ||=
              (message as StreamEvent).nativeComplete === false
            const rawSnapshot = (message as StreamEvent).nativeUsageSnapshot
            if (currentMessageId && rawSnapshot) {
              nativeResponses.set(
                currentMessageId,
                rawSnapshot as Record<string, unknown>,
              )
            }
            const snapshot = (message as StreamEvent).usageSnapshot
            if (snapshot) {
              currentMessageUsage = { ...currentMessageUsage, ...snapshot }
              hasInputUsage ||= typeof snapshot.input_tokens === 'number'
              hasOutputUsage ||= typeof snapshot.output_tokens === 'number'
            }
            if (hasInputUsage && hasOutputUsage) {
              settleUsage(currentMessageId, currentMessageUsage)
            }
            settleAssistantUsage(currentAssistantMessage)
          }

          if (includePartialMessages) {
            const publicEvent = { ...event }
            delete publicEvent.native_usage
            delete publicEvent.native_complete
            yield {
              type: 'stream_event' as const,
              event: publicEvent,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        }
        case 'attachment': {
          const msg = message as Message
          this.mutableMessages.push(msg)
          // Record inline (same reason as progress above).
          if (persistSession) {
            messages.push(msg)
            void recordTranscript(messages)
          }

          const attachment = msg.attachment as {
            type: string
            data?: unknown
            turnCount?: number
            maxTurns?: number
            prompt?: string
            source_uuid?: string
            [key: string]: unknown
          }

          // Extract structured output from StructuredOutput tool calls
          if (attachment.type === 'structured_output') {
            structuredOutputFromTool = attachment.data
          }
          // Handle max turns reached signal from query.ts
          else if (attachment.type === 'max_turns_reached') {
            settleCompletedUsage()
            if (persistSession) {
              if (
                isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
                isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            traceSessionTiming('query.result.ready', () => ({
              inputHash: traceInputHash, outcome: 'error_max_turns',
            }))
            yield {
              type: 'result',
              ...nativeResult(),
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: attachment.turnCount as number,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(
                mainLoopModel,
                initialAppState.fastMode,
              ),
              uuid: randomUUID(),
              errors: [
                `Reached maximum number of turns (${attachment.maxTurns})`,
              ],
            }
            return
          }
          // Yield queued_command attachments as SDK user message replays
          else if (replayUserMessages && attachment.type === 'queued_command') {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: attachment.source_uuid || msg.uuid,
              timestamp: msg.timestamp,
              isReplay: true,
            } as unknown as SDKUserMessageReplay
          }
          break
        }
        case 'stream_request_start':
          nativePending = true
          // Don't yield stream request start messages
          break
        case 'system': {
          const msg = message as Message
          // Snip boundary: replay on our store to remove zombie messages and
          // stale markers. The yielded boundary is a signal, not data to push —
          // the replay produces its own equivalent boundary. Without this,
          // markers persist and re-trigger on every turn, and mutableMessages
          // never shrinks (memory leak in long SDK sessions). The subtype
          // check lives inside the injected callback so feature-gated strings
          // stay out of this file (excluded-strings check).
          const snipResult = this.config.snipReplay?.(msg, this.mutableMessages)
          if (snipResult !== undefined) {
            if (snipResult.executed) {
              this.mutableMessages.length = 0
              this.mutableMessages.push(...snipResult.messages)
            }
            break
          }
          this.mutableMessages.push(msg)
          // Yield compact boundary messages to SDK
          if (msg.subtype === 'compact_boundary' && msg.compactMetadata) {
            const compactMsg = msg as SystemCompactBoundaryMessage
            // Release pre-compaction messages for GC. The boundary was just
            // pushed so it's the last element. query.ts already uses
            // getMessagesAfterCompactBoundary() internally, so only
            // post-boundary messages are needed going forward.
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: msg.uuid,
              compact_metadata: toSDKCompactMetadata(
                compactMsg.compactMetadata,
              ),
            }
          }
          if (msg.subtype === 'api_error') {
            const apiErrorMsg = msg as Message & {
              retryAttempt: number
              maxRetries: number
              retryInMs: number
              error: APIError
            }
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: apiErrorMsg.retryAttempt,
              max_retries: apiErrorMsg.maxRetries,
              retry_delay_ms: apiErrorMsg.retryInMs,
              error_status: apiErrorMsg.error.status ?? null,
              error: categorizeRetryableAPIError(apiErrorMsg.error),
              session_id: getSessionId(),
              uuid: msg.uuid,
            }
          }
          // Don't yield other system messages in headless mode
          break
        }
        case 'tool_use_summary': {
          const msg = message as Message & {
            summary: unknown
            precedingToolUseIds: unknown
          }
          // Yield tool use summary messages to SDK
          yield {
            type: 'tool_use_summary' as const,
            summary: msg.summary,
            preceding_tool_use_ids: msg.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: msg.uuid,
          }
          break
        }
      }

      // Check if USD budget has been exceeded
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        settleCompletedUsage()
        if (persistSession) {
          if (
            isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        traceSessionTiming('query.result.ready', () => ({
          inputHash: traceInputHash, outcome: 'error_max_budget_usd',
        }))
        yield {
          type: 'result',
          ...nativeResult(),
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            mainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [
            `Reached maximum budget ($${maxBudgetUsd}). Increase the limit with --max-budget-usd or start a new session.`,
          ],
        }
        return
      }

      // Check if structured output retry limit exceeded (only on user messages)
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )
        if (callsThisQuery >= maxRetries) {
          settleCompletedUsage()
          if (persistSession) {
            if (
              isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          traceSessionTiming('query.result.ready', () => ({
            inputHash: traceInputHash, outcome: 'error_max_structured_output_retries',
          }))
          yield {
            type: 'result',
            ...nativeResult(),
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              mainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `Failed to provide valid structured output after ${maxRetries} attempts`,
            ],
          }
          return
        }
      }
    }

    // Stop hooks yield progress/attachment messages AFTER the assistant
    // response (via yield* handleStopHooks in query.ts). Since #23537 pushes
    // those to `messages` inline, last(messages) can be a progress/attachment
    // instead of the assistant — which makes textResult extraction below
    // return '' and -p mode emit a blank line. Allowlist to assistant|user:
    // isResultSuccessful handles both (user with all tool_result blocks is a
    // valid successful terminal state).
    const result = messages.findLast(
      m => m.type === 'assistant' || m.type === 'user',
    )
    // Capture for the error_during_execution diagnostic — isResultSuccessful
    // is a type predicate (message is Message), so inside the false branch
    // `result` narrows to never and these accesses don't typecheck.
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContentType =
      result?.type === 'assistant'
        ? (last(
            result.message!
              .content as import('@anthropic-ai/sdk/resources/beta/messages/messages.js').BetaContentBlock[],
          )?.type ?? 'none')
        : 'n/a'

    traceSessionTiming('query.stream.end', () => ({
      inputHash: traceInputHash,
      providerMessageHash: currentMessageId ? debugIdentifierHash(currentMessageId) : undefined,
      assistantHash: result?.type === 'assistant' ? debugIdentifierHash(result.uuid) : undefined,
      aborted: this.abortController.signal.aborted,
    }))
    // Flush buffered transcript writes before yielding result.
    // The desktop app kills the CLI process immediately after receiving the
    // result message, so any unflushed writes would be lost.
    if (persistSession) {
      if (
        isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
      ) {
        const flushStartedAt = tracing ? performance.now() : 0
        traceSessionTiming('query.result.flush.begin', () => ({ inputHash: traceInputHash }))
        await flushSessionStorage()
        traceSessionTiming('query.result.flush.end', () => ({
          inputHash: traceInputHash,
          elapsedMs: performance.now() - flushStartedAt,
        }))
      }
    }

    if (!isResultSuccessful(result, lastStopReason)) {
      traceSessionTiming('query.result.ready', () => ({
        inputHash: traceInputHash, outcome: 'error_during_execution',
      }))
      yield {
        type: 'result',
        ...nativeResult(),
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        // Diagnostic prefix: these are what isResultSuccessful() checks — if
        // the result type isn't assistant-with-text/thinking or user-with-
        // tool_result, and stop_reason isn't end_turn, that's why this fired.
        // errors[] is turn-scoped via the watermark; previously it dumped the
        // entire process's logError buffer (ripgrep timeouts, ENOENT, etc).
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark
            ? all.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map(_ => _.error),
          ]
        })(),
      }
      return
    }

    // Extract the text result based on message type
    let textResult = ''
    let isApiError = false

    if (result.type === 'assistant') {
      const lastContent = last(
        result.message!
          .content as import('@anthropic-ai/sdk/resources/beta/messages/messages.js').BetaContentBlock[],
      )
      if (
        lastContent?.type === 'text' &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    traceSessionTiming('query.result.ready', () => ({
      inputHash: traceInputHash,
      outcome: isApiError ? 'api_error' : 'success',
    }))
    yield {
      type: 'result',
      ...nativeResult(!isApiError),
      subtype: 'success',
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(
        mainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  }

  interrupt(): void {
    this.abortController.abort()
  }

  /** Reset the abort controller so the next submitMessage() call can start
   *  with a fresh, non-aborted signal. Must be called after interrupt(). */
  resetAbortController(): void {
    this.abortController = createAbortController()
  }

  /** Expose the current abort signal for external consumers (e.g. ACP bridge). */
  getAbortSignal(): AbortSignal {
    return this.abortController.signal
  }

  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }
}

/**
 * Sends a single prompt to the Claude API and returns the response.
 * Assumes that claude is being used non-interactively -- will not
 * ask the user for permissions or further input.
 *
 * Convenience wrapper around QueryEngine for one-shot usage.
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  refreshTools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  refreshTools?: () => Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  setSDKStatus?: (status: SDKStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  const engine = new QueryEngine({
    cwd,
    tools,
    refreshTools,
    commands,
    mcpClients,
    agents: agents ?? [],
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
    ...(feature('HISTORY_SNIP')
      ? {
          snipReplay: (yielded: Message, store: Message[]) => {
            if (!snipProjection!.isSnipBoundaryMessage(yielded))
              return undefined
            return snipModule!.snipCompactIfNeeded(store, { force: true })
          },
        }
      : {}),
  })

  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}
