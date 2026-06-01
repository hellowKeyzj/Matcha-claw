import * as React from 'react'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { ThemeName } from 'src/utils/theme.js'
import type { Output } from './ExitPlanModeV2Tool.js'
export declare function renderToolUseMessage(): React.ReactNode
export declare function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    theme: _theme,
  }: {
    theme: ThemeName
  },
): React.ReactNode
export declare function renderToolUseRejectedMessage(
  {
    plan,
  }: {
    plan?: string
  },
  {
    theme: _theme,
  }: {
    theme: ThemeName
  },
): React.ReactNode
