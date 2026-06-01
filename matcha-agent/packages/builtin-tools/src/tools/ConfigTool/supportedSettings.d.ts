/** AppState keys that can be synced for immediate UI effect */
type SyncableAppStateKey = 'verbose' | 'mainLoopModel' | 'thinkingEnabled'
type SettingConfig = {
  source: 'global' | 'settings'
  type: 'boolean' | 'string'
  description: string
  path?: string[]
  options?: readonly string[]
  getOptions?: () => string[]
  appStateKey?: SyncableAppStateKey
  /** Async validation called when writing/setting a value */
  validateOnWrite?: (v: unknown) => Promise<{
    valid: boolean
    error?: string
  }>
  /** Format value when reading/getting for display */
  formatOnRead?: (v: unknown) => unknown
}
export declare const SUPPORTED_SETTINGS: Record<string, SettingConfig>
export declare function isSupported(key: string): boolean
export declare function getConfig(key: string): SettingConfig | undefined
export declare function getAllKeys(): string[]
export declare function getOptionsForSetting(key: string): string[] | undefined
export declare function getPath(key: string): string[]
export {}
