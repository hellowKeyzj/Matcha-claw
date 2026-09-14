const MAX_NATIVE_SESSION_ID_BYTES = 240
const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const WINDOWS_RESERVED_SESSION_IDS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

export function isNativeSessionId(value: string): boolean {
  return (
    value.length <= MAX_NATIVE_SESSION_ID_BYTES &&
    NATIVE_SESSION_ID_PATTERN.test(value) &&
    !WINDOWS_RESERVED_SESSION_IDS.has(value.toUpperCase())
  )
}

export function nativeSessionIdErrorMessage(key: string): string {
  return `${key} must be a portable native session id`
}
