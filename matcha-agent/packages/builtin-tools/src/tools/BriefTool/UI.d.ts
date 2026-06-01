import React from 'react'
import type { ProgressMessage } from 'src/types/message.js'
import type { Output } from './BriefTool.js'
export declare function renderToolUseMessage(): React.ReactNode
export declare function renderToolResultMessage(
  output: Output,
  _progressMessages: ProgressMessage[],
  options?: {
    isTranscriptMode?: boolean
    isBriefOnly?: boolean
  },
): React.ReactNode
type AttachmentListProps = {
  attachments: Output['attachments']
}
export declare function AttachmentList({
  attachments,
}: AttachmentListProps): React.ReactNode
export {}
