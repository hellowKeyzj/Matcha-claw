export type GraphicsSettingsState = Readonly<{
  supported: boolean;
  enabled: boolean;
  automaticallyDisabled: boolean;
  hardwareAccelerationEnabled: boolean;
}>;

export type GraphicsChangeResult =
  | Readonly<{ status: 'restarting' | 'unchanged' }>
  | Readonly<{
      status: 'blocked';
      reason: 'unsupported' | 'busy' | 'save-failed' | 'quit-cancelled';
    }>;
