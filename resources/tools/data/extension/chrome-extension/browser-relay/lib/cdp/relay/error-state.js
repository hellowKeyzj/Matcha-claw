export const RELAY_ERROR_STORAGE_KEYS = Object.freeze({
  CODE: '_relayError',
  SEVERITY: '_relayErrorSeverity',
})

export const RELAY_ERROR_SEVERITY = Object.freeze({
  RETRYING: 'retrying',
  TERMINAL: 'terminal',
})

export const RELAY_ERROR_CLEAR_REASON = Object.freeze({
  SUCCESS: 'success',
  USER_DISABLE: 'userDisable',
  USER_ENABLE: 'userEnable',
  CAUSE_GONE: 'causeGone',
})

export const RELAY_ERROR_CODES = Object.freeze({
  ENCRYPTION_UNSUPPORTED: 'encryption_unsupported',
  SESSION_KEY_FAILED: 'session_key_failed',
  ENCRYPTION_ACTIVATION_FAILED: 'encryption_activation_failed',
  DEBUGGER_LISTENER_FAILED: 'debugger_listener_failed',
})

export const LOCAL_RELAY_ERROR_CODES = new Set([
  RELAY_ERROR_CODES.SESSION_KEY_FAILED,
  RELAY_ERROR_CODES.ENCRYPTION_ACTIVATION_FAILED,
  RELAY_ERROR_CODES.DEBUGGER_LISTENER_FAILED,
])

const ALL_RELAY_ERROR_CODES = new Set(Object.values(RELAY_ERROR_CODES))
const ALL_RELAY_ERROR_CLEAR_REASONS = new Set(Object.values(RELAY_ERROR_CLEAR_REASON))

export const RELAY_ERROR_MESSAGES = Object.freeze({
  [RELAY_ERROR_CODES.ENCRYPTION_UNSUPPORTED]: {
    [RELAY_ERROR_SEVERITY.TERMINAL]:
      'Desktop app does not support encrypted transport. Please update the desktop app to the latest version.',
  },
  [RELAY_ERROR_CODES.SESSION_KEY_FAILED]: {
    [RELAY_ERROR_SEVERITY.RETRYING]:
      'Extension failed to prepare encrypted transport. It is retrying automatically.',
    [RELAY_ERROR_SEVERITY.TERMINAL]:
      'Extension failed to prepare encrypted transport. Relay has been disabled. Please reload the extension or reinstall it.',
  },
  [RELAY_ERROR_CODES.ENCRYPTION_ACTIVATION_FAILED]: {
    [RELAY_ERROR_SEVERITY.RETRYING]:
      'Extension failed to activate encrypted transport. It is retrying automatically.',
    [RELAY_ERROR_SEVERITY.TERMINAL]:
      'Extension failed to activate encrypted transport. Relay has been disabled. Please reload the extension or reinstall it.',
  },
  [RELAY_ERROR_CODES.DEBUGGER_LISTENER_FAILED]: {
    [RELAY_ERROR_SEVERITY.RETRYING]:
      'Extension failed to initialize browser control listeners. It is retrying automatically.',
    [RELAY_ERROR_SEVERITY.TERMINAL]:
      'Extension failed to initialize browser control listeners. Relay has been disabled. Please reload the extension or reinstall it.',
  },
})

export function isLocalRelayError(code) {
  return LOCAL_RELAY_ERROR_CODES.has(code)
}

const LOCALIZED_RELAY_ERROR_MESSAGES = {
  zh: {
    [RELAY_ERROR_CODES.ENCRYPTION_UNSUPPORTED]: {
      terminal: '桌面应用不支持加密连接，请更新到最新版本。',
    },
    [RELAY_ERROR_CODES.SESSION_KEY_FAILED]: {
      retrying: '扩展无法准备加密连接，正在自动重试。',
      terminal: '扩展无法准备加密连接，中继已停用。请重新加载或安装扩展。',
    },
    [RELAY_ERROR_CODES.ENCRYPTION_ACTIVATION_FAILED]: {
      retrying: '扩展无法启用加密连接，正在自动重试。',
      terminal: '扩展无法启用加密连接，中继已停用。请重新加载或安装扩展。',
    },
    [RELAY_ERROR_CODES.DEBUGGER_LISTENER_FAILED]: {
      retrying: '扩展无法初始化浏览器控制监听器，正在自动重试。',
      terminal: '扩展无法初始化浏览器控制监听器，中继已停用。请重新加载或安装扩展。',
    },
  },
  ja: {
    [RELAY_ERROR_CODES.ENCRYPTION_UNSUPPORTED]: {
      terminal: 'デスクトップアプリが暗号化接続に対応していません。最新バージョンに更新してください。',
    },
    [RELAY_ERROR_CODES.SESSION_KEY_FAILED]: {
      retrying: '拡張機能が暗号化接続を準備できませんでした。自動的に再試行しています。',
      terminal: '拡張機能が暗号化接続を準備できなかったため、リレーを無効にしました。拡張機能を再読み込みするか、再インストールしてください。',
    },
    [RELAY_ERROR_CODES.ENCRYPTION_ACTIVATION_FAILED]: {
      retrying: '拡張機能が暗号化接続を有効にできませんでした。自動的に再試行しています。',
      terminal: '拡張機能が暗号化接続を有効にできなかったため、リレーを無効にしました。拡張機能を再読み込みするか、再インストールしてください。',
    },
    [RELAY_ERROR_CODES.DEBUGGER_LISTENER_FAILED]: {
      retrying: '拡張機能がブラウザー制御リスナーを初期化できませんでした。自動的に再試行しています。',
      terminal: '拡張機能がブラウザー制御リスナーを初期化できなかったため、リレーを無効にしました。拡張機能を再読み込みするか、再インストールしてください。',
    },
  },
  ru: {
    [RELAY_ERROR_CODES.ENCRYPTION_UNSUPPORTED]: {
      terminal: 'Приложение не поддерживает зашифрованное соединение. Обновите его до последней версии.',
    },
    [RELAY_ERROR_CODES.SESSION_KEY_FAILED]: {
      retrying: 'Расширению не удалось подготовить зашифрованное соединение. Выполняется повторная попытка.',
      terminal: 'Расширению не удалось подготовить зашифрованное соединение. Ретранслятор отключён. Перезагрузите или переустановите расширение.',
    },
    [RELAY_ERROR_CODES.ENCRYPTION_ACTIVATION_FAILED]: {
      retrying: 'Расширению не удалось включить шифрование. Выполняется повторная попытка.',
      terminal: 'Расширению не удалось включить шифрование. Ретранслятор отключён. Перезагрузите или переустановите расширение.',
    },
    [RELAY_ERROR_CODES.DEBUGGER_LISTENER_FAILED]: {
      retrying: 'Расширению не удалось инициализировать обработчики управления браузером. Выполняется повторная попытка.',
      terminal: 'Расширению не удалось инициализировать обработчики управления браузером. Ретранслятор отключён. Перезагрузите или переустановите расширение.',
    },
  },
}

export function getRelayErrorMessage(code, severity = RELAY_ERROR_SEVERITY.TERMINAL, language = 'en') {
  const locale = String(language).toLowerCase().split(/[-_]/)[0]
  const messages = (LOCALIZED_RELAY_ERROR_MESSAGES[locale] || RELAY_ERROR_MESSAGES)[code]
  return messages?.[severity] || messages?.[RELAY_ERROR_SEVERITY.TERMINAL] || ''
}

export async function setRelayError(
  code,
  { severity = RELAY_ERROR_SEVERITY.TERMINAL } = {},
) {
  if (!ALL_RELAY_ERROR_CODES.has(code)) {
    throw new Error(`Unknown relay error code: ${code}`)
  }
  await chrome.storage.local.set({
    [RELAY_ERROR_STORAGE_KEYS.CODE]: code,
    [RELAY_ERROR_STORAGE_KEYS.SEVERITY]: severity,
  })
}

export async function readRelayError() {
  const stored = await chrome.storage.local.get([
    RELAY_ERROR_STORAGE_KEYS.CODE,
    RELAY_ERROR_STORAGE_KEYS.SEVERITY,
  ])
  return {
    code: stored[RELAY_ERROR_STORAGE_KEYS.CODE],
    severity: stored[RELAY_ERROR_STORAGE_KEYS.SEVERITY],
  }
}

export function matchesRelayErrorChange(changes) {
  return (
    RELAY_ERROR_STORAGE_KEYS.CODE in changes ||
    RELAY_ERROR_STORAGE_KEYS.SEVERITY in changes
  )
}

export async function clearRelayError(reason) {
  if (!ALL_RELAY_ERROR_CLEAR_REASONS.has(reason)) {
    throw new Error(`Unknown relay error clear reason: ${reason}`)
  }

  const { code } = await readRelayError()
  if (!code) return

  const shouldClear =
    reason === RELAY_ERROR_CLEAR_REASON.SUCCESS ||
    reason === RELAY_ERROR_CLEAR_REASON.USER_DISABLE ||
    reason === RELAY_ERROR_CLEAR_REASON.USER_ENABLE ||
    (reason === RELAY_ERROR_CLEAR_REASON.CAUSE_GONE && isLocalRelayError(code))
  if (!shouldClear) return

  await chrome.storage.local.remove([
    RELAY_ERROR_STORAGE_KEYS.CODE,
    RELAY_ERROR_STORAGE_KEYS.SEVERITY,
  ])
}
