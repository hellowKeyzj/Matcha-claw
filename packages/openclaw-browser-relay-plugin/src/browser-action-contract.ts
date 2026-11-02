export const browserToolActions = [
  'open',
  'close',
  'stop',
  'start',
  'status',
  'console',
  'focus',
  'snapshot',
  'navigate',
  'profiles',
  'dialog',
  'tabs',
  'screenshot',
  'pdf',
  'upload',
  'act',
  'scroll',
  'errors',
  'requests',
  'cookies',
  'storage',
  'highlight',
  'closeagenttabs',
  'close_agent_tabs',
] as const

export const browserIabToolActions = [...browserToolActions, 'utility'] as const
export type BrowserToolAction = typeof browserIabToolActions[number]
export type NormalizedBrowserToolAction = Lowercase<BrowserToolAction>

export const browserRequestKinds = [
  'select',
  'type',
  'fill',
  'close',
  'resize',
  'wait',
  'hover',
  'click',
  'clickCoords',
  'press',
  'drag',
  'evaluate',
  'scroll',
  'scrollIntoView',
] as const

export const browserIabRequestKinds = [...browserRequestKinds, 'hoverCoords', 'dragCoords', 'wheelCoords'] as const

export type BrowserRequestKind = typeof browserIabRequestKinds[number]
export type NormalizedBrowserRequestKind = Lowercase<BrowserRequestKind>

export const relayDirectActions = [
  'start',
  'status',
  'profiles',
  'tabs',
  'open',
  'focus',
  'close',
  'console',
  'closeagenttabs',
  'close_agent_tabs',
] as const satisfies readonly NormalizedBrowserToolAction[]

export const closeAgentTabsActions = [
  'closeagenttabs',
  'close_agent_tabs',
] as const satisfies readonly NormalizedBrowserToolAction[]
export type RelayDirectAction = typeof relayDirectActions[number]
export type CloseAgentTabsAction = typeof closeAgentTabsActions[number]

export const browserDataOperations = ['get', 'set', 'clear'] as const
export type BrowserDataOperation = typeof browserDataOperations[number]

export const waitLoadStates = ['load', 'domcontentloaded', 'networkidle'] as const
export type WaitLoadState = typeof waitLoadStates[number]

export const mouseButtons = ['left', 'middle', 'right'] as const
export type MouseButton = typeof mouseButtons[number]

export type BrowserConnectionMode = 'relay' | 'direct-cdp'
export type BrowserStorageType = 'local' | 'session'
export type BrowserScreenshotType = 'jpeg' | 'png'
export type BrowserAnimationMode = 'allow' | 'disabled'
export type BrowserCaretMode = 'hide' | 'initial'
export type BrowserScaleMode = 'css' | 'device'

type BrowserExecutionActionBase = {
  connectionMode?: BrowserConnectionMode
  targetId?: string
  timeoutMs?: number
  workspaceDir?: string
}

type BrowserSaveActionBase = BrowserExecutionActionBase & {
  savePath?: string
}

export type BrowserCookieInput = {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
}

export type BrowserFillFieldInput = {
  ref?: string
  backendNodeId?: number
  frameId?: string
  type?: string
  value?: string | number | boolean
}

export type BrowserClickRequest = {
  kind: 'click'
  targetId?: string
  timeoutMs?: number
  ref?: string
  backendNodeId?: number
  frameId?: string
  selector?: string
  doubleClick?: boolean
  button?: MouseButton
  modifiers?: string[]
  humanize?: boolean
}

export type BrowserClickCoordsRequest = {
  kind: 'clickCoords'
  targetId?: string
  timeoutMs?: number
  x?: number
  y?: number
  doubleClick?: boolean
  button?: MouseButton
  delayMs?: number
  modifiers?: string[]
  humanize?: boolean
}

export type BrowserHoverCoordsRequest = {
  kind: 'hoverCoords'
  targetId?: string
  timeoutMs?: number
  x?: number
  y?: number
  humanize?: boolean
}

export type BrowserDragCoordsRequest = {
  kind: 'dragCoords'
  targetId?: string
  timeoutMs?: number
  from?: { x: number; y: number }
  to?: { x: number; y: number }
  steps?: number
  durationMs?: number
}

export type BrowserWheelCoordsRequest = {
  kind: 'wheelCoords'
  targetId?: string
  timeoutMs?: number
  x?: number
  y?: number
  deltaX?: number
  deltaY?: number
  humanize?: boolean
}

export type BrowserTypeRequest = {
  kind: 'type'
  targetId?: string
  timeoutMs?: number
  ref?: string
  backendNodeId?: number
  frameId?: string
  text?: string
  submit?: boolean
  slowly?: boolean
  clearFirst?: boolean
}

export type BrowserPressRequest = {
  kind: 'press'
  targetId?: string
  timeoutMs?: number
  key?: string
  delayMs?: number
}

export type BrowserHoverRequest = {
  kind: 'hover'
  targetId?: string
  timeoutMs?: number
  ref?: string
  backendNodeId?: number
  frameId?: string
}

export type BrowserScrollIntoViewRequest = {
  kind: 'scrollIntoView'
  targetId?: string
  timeoutMs?: number
  ref?: string
  backendNodeId?: number
  frameId?: string
}

export type BrowserDragRequest = {
  kind: 'drag'
  targetId?: string
  timeoutMs?: number
  startRef?: string
  endRef?: string
  endX?: number
  endY?: number
  steps?: number
  durationMs?: number
}

export type BrowserSelectRequest = {
  kind: 'select'
  targetId?: string
  timeoutMs?: number
  ref?: string
  backendNodeId?: number
  frameId?: string
  values?: string[]
}

export type BrowserFillRequest = {
  kind: 'fill'
  targetId?: string
  timeoutMs?: number
  fields?: BrowserFillFieldInput[]
}

export type BrowserResizeRequest = {
  kind: 'resize'
  targetId?: string
  timeoutMs?: number
  width?: number
  height?: number
}

export type BrowserWaitRequest = {
  kind: 'wait'
  targetId?: string
  timeoutMs?: number
  timeMs?: number
  text?: string
  textGone?: string
  selector?: string
  url?: string
  loadState?: WaitLoadState
  fn?: string
}

export type BrowserEvaluateRequest = {
  kind: 'evaluate'
  targetId?: string
  timeoutMs?: number
  ref?: string
  fn?: string
  expression?: string
  frameId?: string
}

export type BrowserEvaluateShortcutRequest = {
  kind?: undefined
  targetId?: string
  timeoutMs?: number
  ref?: string
  fn?: string
  expression?: string
  frameId?: string
}

export type BrowserCloseRequest = {
  kind: 'close'
  targetId?: string
  timeoutMs?: number
}

export type BrowserScrollRequest = {
  kind: 'scroll'
  targetId?: string
  timeoutMs?: number
  scrollDirection?: string
  scrollAmount?: number
}

export type BrowserActRequest =
  | BrowserClickRequest
  | BrowserClickCoordsRequest
  | BrowserHoverCoordsRequest
  | BrowserDragCoordsRequest
  | BrowserWheelCoordsRequest
  | BrowserTypeRequest
  | BrowserPressRequest
  | BrowserHoverRequest
  | BrowserScrollIntoViewRequest
  | BrowserDragRequest
  | BrowserSelectRequest
  | BrowserFillRequest
  | BrowserResizeRequest
  | BrowserWaitRequest
  | BrowserEvaluateRequest
  | BrowserEvaluateShortcutRequest
  | BrowserCloseRequest
  | BrowserScrollRequest

export type BrowserStartAction = {
  action: 'start'
}

export type BrowserStopAction = {
  action: 'stop'
}

export type BrowserStatusAction = {
  action: 'status'
}

export type BrowserProfilesAction = {
  action: 'profiles'
}

export type BrowserTabsAction = {
  action: 'tabs'
}

export type BrowserOpenAction = {
  action: 'open'
  url?: string
  retain?: boolean
  sessionKey?: string
}

export type BrowserFocusAction = BrowserExecutionActionBase & {
  action: 'focus'
}

export type BrowserCloseAction = BrowserExecutionActionBase & {
  action: 'close'
}

export type BrowserConsoleAction = BrowserSaveActionBase & {
  action: 'console'
  expression?: string
  scriptPath?: string
  frameId?: string
  ref?: string
  level?: string
}

export type BrowserSnapshotAction = BrowserExecutionActionBase & {
  action: 'snapshot'
  limit?: number
  maxChars?: number
  mode?: 'efficient'
  snapshotFormat?: 'ai' | 'aria'
  refs?: 'role' | 'aria'
  selector?: string
  frame?: string
  interactive?: boolean
  compact?: boolean
  efficient?: boolean
  depth?: number
  scope?: { frame?: string; landmark?: string; selector?: string }
  filter?: { keywords?: string[]; roles?: string[]; contextLines?: number; maxMatches?: number }
}

export type BrowserNavigateAction = BrowserExecutionActionBase & {
  action: 'navigate'
  url?: string
  waitUntil?: string
}

export type BrowserDialogAction = BrowserExecutionActionBase & {
  action: 'dialog'
  accept?: boolean
  promptText?: string
}

export type BrowserScreenshotAction = BrowserSaveActionBase & {
  action: 'screenshot'
  ref?: string
  element?: string
  fullPage?: boolean
  type?: BrowserScreenshotType
  quality?: number
  animations?: BrowserAnimationMode
  caret?: BrowserCaretMode
  scale?: BrowserScaleMode
  omitBackground?: boolean
}

export type BrowserPdfOptions = {
  landscape?: boolean
  printBackground?: boolean
  paper?: 'a3' | 'a4' | 'a5' | 'letter' | 'legal' | 'tabloid' | 'ledger'
  scale?: number
}

export type BrowserPdfAction = BrowserSaveActionBase & BrowserPdfOptions & {
  action: 'pdf'
}

export type BrowserUploadAction = BrowserExecutionActionBase & {
  action: 'upload'
  paths?: string[]
  ref?: string
  backendNodeId?: number
  frameId?: string
  inputRef?: string
  element?: string
}

export type BrowserActAction = BrowserExecutionActionBase & {
  action: 'act'
  request?: BrowserActRequest
}

export type BrowserScrollAction = BrowserExecutionActionBase & {
  action: 'scroll'
  scrollDirection?: string
  scrollAmount?: number
}

export type BrowserErrorsAction = BrowserExecutionActionBase & {
  action: 'errors'
  clear?: boolean
}

export type BrowserRequestsAction = BrowserExecutionActionBase & {
  action: 'requests'
  filter?: string
  clear?: boolean
}

export type BrowserCookiesAction = BrowserExecutionActionBase & {
  action: 'cookies'
  operation?: BrowserDataOperation
  cookies?: BrowserCookieInput[]
}

export type BrowserStorageAction = BrowserExecutionActionBase & {
  action: 'storage'
  storageType?: BrowserStorageType | 'indexedDB'
  operation?: BrowserDataOperation | 'remove'
  key?: string
  value?: string | number | boolean
}

export type BrowserHighlightAction = BrowserExecutionActionBase & {
  action: 'highlight'
  ref?: string
  backendNodeId?: number
  frameId?: string
  durationMs?: number
}

export type BrowserCloseAgentTabsAction = {
  action: CloseAgentTabsAction
}

export const browserUtilityKinds = [
  'highlight', 'upload', 'dialog', 'errors', 'events', 'requests', 'pdf', 'cookies',
  'frames', 'a11yTree', 'domTree', 'scripts', 'sourceMap', 'har', 'download', 'settings', 'som', 'intercept', 'metrics', 'emulate', 'goBack', 'goForward', 'reload',
] as const

export type BrowserRuntimeSettings = {
  pace?: { minIntervalMs: number; jitterMs?: number } | null
  humanize?: boolean | null
  stealth?: { enabled: boolean } | null
}

export type BrowserInterceptRule = {
  pattern: string
  match?: 'substring' | 'glob'
  action: 'block' | 'mock' | 'modify' | 'continue'
  status?: number
  headers?: Record<string, string>
  body?: string
  contentType?: string
  method?: string
}

export type BrowserUtilityRequest = { targetId?: string; timeoutMs?: number } & (
  | { kind: 'highlight'; ref?: string; backendNodeId?: number; frameId?: string; durationMs?: number }
  | { kind: 'upload'; paths?: string[]; ref?: string; backendNodeId?: number; frameId?: string; inputRef?: string; element?: string }
  | { kind: 'dialog'; accept?: boolean; promptText?: string }
  | { kind: 'errors'; clear?: boolean }
  | { kind: 'events'; filter?: string; since?: number; clear?: boolean }
  | { kind: 'requests'; filter?: string; clear?: boolean; last?: number }
  | ({ kind: 'pdf'; savePath?: string } & BrowserPdfOptions)
  | { kind: 'cookies'; operation?: BrowserDataOperation; cookies?: BrowserCookieInput[] }
  | { kind: 'frames' }
  | { kind: 'goBack' | 'goForward' }
  | { kind: 'reload'; ignoreCache?: boolean }
  | { kind: 'a11yTree'; text?: string; max?: number }
  | { kind: 'domTree'; scope?: string; text?: string; max?: number; depth?: number; deepText?: boolean; includeHrefInFilter?: boolean }
  | { kind: 'scripts'; filter?: string; includeSource?: boolean; limit?: number; maxChars?: number }
  | { kind: 'sourceMap'; scriptId?: string; filter?: string; line?: number; column?: number }
  | { kind: 'har'; savePath?: string; filter?: string; last?: number; clear?: boolean }
  | { kind: 'download'; savePath?: string; dir?: string; trigger?: BrowserClickRequest | BrowserClickCoordsRequest }
  | { kind: 'settings'; settings?: BrowserRuntimeSettings | string }
  | { kind: 'som'; mode?: 'dom' | 'vision'; maxMarks?: number; selector?: string; screenshot?: boolean }
  | { kind: 'intercept'; rules?: BrowserInterceptRule[] | string; clear?: boolean; cacheBypass?: boolean }
  | { kind: 'metrics' }
  | {
    kind: 'emulate'
    action: 'device' | 'timezone' | 'locale' | 'geolocation' | 'colorScheme' | 'userAgent' | 'network' | 'cpu'
    clear?: boolean
    device?: string | Record<string, unknown>
    timezoneId?: string
    locale?: string
    latitude?: number
    longitude?: number
    accuracy?: number
    scheme?: 'light' | 'dark'
    userAgent?: string
    preset?: string | Record<string, unknown>
    rate?: number
  }
)

export type BrowserUtilityAction = BrowserExecutionActionBase & {
  action: 'utility'
  request?: BrowserUtilityRequest
}

export type BrowserActionContext = {
  sessionKey: string
  agentId: string
  workspaceDir?: string
  sessionId: string
}

export type BrowserActionInvocation = {
  context?: BrowserActionContext
  signal?: AbortSignal
  assertInvocationCurrent?: () => void
}

export type BrowserActionParams =
  | BrowserStartAction
  | BrowserStopAction
  | BrowserStatusAction
  | BrowserProfilesAction
  | BrowserTabsAction
  | BrowserOpenAction
  | BrowserFocusAction
  | BrowserCloseAction
  | BrowserConsoleAction
  | BrowserSnapshotAction
  | BrowserNavigateAction
  | BrowserDialogAction
  | BrowserScreenshotAction
  | BrowserPdfAction
  | BrowserUploadAction
  | BrowserActAction
  | BrowserScrollAction
  | BrowserErrorsAction
  | BrowserRequestsAction
  | BrowserCookiesAction
  | BrowserStorageAction
  | BrowserHighlightAction
  | BrowserCloseAgentTabsAction
  | BrowserUtilityAction
