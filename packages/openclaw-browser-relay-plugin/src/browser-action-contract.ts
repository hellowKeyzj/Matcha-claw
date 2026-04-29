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

export type BrowserToolAction = typeof browserToolActions[number]
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
  'press',
  'drag',
  'evaluate',
  'scroll',
  'scrollIntoView',
] as const

export type BrowserRequestKind = typeof browserRequestKinds[number]
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
  ref: string
  type: string
  value?: string | number | boolean
}

export type BrowserClickRequest = {
  kind: 'click'
  targetId?: string
  timeoutMs?: number
  ref?: string
  doubleClick?: boolean
  button?: MouseButton
  modifiers?: string[]
}

export type BrowserTypeRequest = {
  kind: 'type'
  targetId?: string
  timeoutMs?: number
  ref?: string
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
}

export type BrowserScrollIntoViewRequest = {
  kind: 'scrollIntoView'
  targetId?: string
  timeoutMs?: number
  ref?: string
}

export type BrowserDragRequest = {
  kind: 'drag'
  targetId?: string
  timeoutMs?: number
  startRef?: string
  endRef?: string
}

export type BrowserSelectRequest = {
  kind: 'select'
  targetId?: string
  timeoutMs?: number
  ref?: string
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
}

export type BrowserEvaluateShortcutRequest = {
  kind?: undefined
  targetId?: string
  timeoutMs?: number
  ref?: string
  fn?: string
  expression?: string
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
  ref?: string
  level?: string
}

export type BrowserSnapshotAction = BrowserExecutionActionBase & {
  action: 'snapshot'
  selector?: string
  frame?: string
  interactive?: boolean
  compact?: boolean
  efficient?: boolean
  depth?: number
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

export type BrowserPdfAction = BrowserSaveActionBase & {
  action: 'pdf'
}

export type BrowserUploadAction = BrowserExecutionActionBase & {
  action: 'upload'
  paths?: string[]
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
  storageType?: BrowserStorageType
  operation?: BrowserDataOperation
  key?: string
  value?: string | number | boolean
}

export type BrowserHighlightAction = BrowserExecutionActionBase & {
  action: 'highlight'
  ref?: string
  durationMs?: number
}

export type BrowserCloseAgentTabsAction = {
  action: CloseAgentTabsAction
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
