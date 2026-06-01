import React from 'react'
import type { Out as BashOut } from './BashTool.js'
type Props = {
  content: Omit<BashOut, 'interrupted'>
  verbose: boolean
  timeoutMs?: number
}
export default function BashToolResultMessage({
  content: {
    stdout,
    stderr: stdErrWithViolations,
    isImage,
    returnCodeInterpretation,
    noOutputExpected,
    backgroundTaskId,
  },
  verbose,
  timeoutMs,
}: Props): React.ReactNode
export {}
