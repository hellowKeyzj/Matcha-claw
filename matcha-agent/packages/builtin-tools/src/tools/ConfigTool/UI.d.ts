import React from 'react'
import type { Input, Output } from './ConfigTool.js'
export declare function renderToolUseMessage(
  input: Partial<Input>,
): React.ReactNode
export declare function renderToolResultMessage(
  content: Output,
): React.ReactNode
export declare function renderToolUseRejectedMessage(): React.ReactNode
