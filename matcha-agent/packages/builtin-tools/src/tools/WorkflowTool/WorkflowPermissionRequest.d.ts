import React from 'react'
import type { PermissionRequestProps } from 'src/components/permissions/PermissionRequest.js'
/**
 * Permission request UI for the WorkflowTool. Asks the user to confirm
 * executing a workflow script.
 * Follows the MonitorPermissionRequest / FallbackPermissionRequest pattern.
 */
export declare function WorkflowPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode
