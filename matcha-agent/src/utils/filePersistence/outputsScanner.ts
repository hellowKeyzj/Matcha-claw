/**
 * Outputs directory scanner for file persistence
 *
 * This module provides utilities to:
 * - Detect the session type from environment variables
 * - Capture turn start timestamp
 * - Find modified files by comparing file mtimes against turn start time
 */

import * as path from 'path'
import {
  currentInvestigationScope,
  requireInvestigationEffects,
  rethrowInvestigationAdmission,
} from '../../world/investigation.js'
import { logForDebugging } from '../debug.js'
import { readSourceDirectory, statSourcePath } from '../fsOperations.js'
import type { EnvironmentKind } from '../teleport/environments.js'
import type { TurnStartTime } from './types.js'

/** Shared debug logger for file persistence modules */
export function logDebug(message: string): void {
  logForDebugging(`[file-persistence] ${message}`)
}

/**
 * Get the environment kind from CLAUDE_CODE_ENVIRONMENT_KIND.
 * Returns null if not set or not a recognized value.
 */
export function getEnvironmentKind(): EnvironmentKind | null {
  const kind = process.env.CLAUDE_CODE_ENVIRONMENT_KIND
  if (kind === 'byoc' || kind === 'anthropic_cloud') {
    return kind
  }
  return null
}

/**
 * Find files that have been modified since the turn started.
 * Returns paths of files with mtime >= turnStartTime.
 *
 * Uses recursive directory listing and parallelized stat calls for efficiency.
 *
 * @param turnStartTime - The timestamp when the turn started
 * @param outputsDir - The directory to scan for modified files
 * @param signal - Optional abort signal for cancellation
 */
export async function findModifiedFiles(
  turnStartTime: TurnStartTime,
  outputsDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const filePaths: string[] = []
  try {
    const directories = [outputsDir]
    for (const directory of directories) {
      if (currentInvestigationScope()) signal?.throwIfAborted()
      requireInvestigationEffects([])
      const entries = await readSourceDirectory(directory, signal)
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const filePath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          directories.push(filePath)
        } else if (entry.isFile()) {
          filePaths.push(filePath)
        }
      }
    }
    if (currentInvestigationScope()) signal?.throwIfAborted()
    requireInvestigationEffects([])
  } catch (error) {
    rethrowInvestigationAdmission(error)
    if (currentInvestigationScope()) {
      if (error instanceof Error && error.cause !== undefined) throw error
      signal?.throwIfAborted()
    }
    // Directory doesn't exist or is not accessible
    return []
  }

  if (filePaths.length === 0) {
    logDebug('No files found in outputs directory')
    return []
  }

  // Parallelize stat calls for all files
  const statResults = await Promise.allSettled(
    filePaths.map(async filePath => {
      if (currentInvestigationScope()) signal?.throwIfAborted()
      requireInvestigationEffects([])
      const stat = await statSourcePath(filePath, {
        followSymlinks: false,
        signal,
      })
      // Skip if it became a symlink between readdir and stat (race condition)
      if (stat.isSymbolicLink()) {
        return null
      }
      return { filePath, mtimeMs: stat.mtimeMs }
    }),
  )
  if (currentInvestigationScope()) signal?.throwIfAborted()
  requireInvestigationEffects([])

  // Filter to files modified since turn start
  const modifiedFiles: string[] = []
  for (const result of statResults) {
    if (result.status === 'rejected') {
      rethrowInvestigationAdmission(result.reason)
      if (
        currentInvestigationScope() &&
        result.reason instanceof Error &&
        result.reason.cause !== undefined
      ) {
        throw result.reason
      }
      // File may have been deleted between readdir and stat
      continue
    }
    if (result.value && result.value.mtimeMs >= turnStartTime.turnStartTime) {
      modifiedFiles.push(result.value.filePath)
    }
  }

  logDebug(
    `Found ${modifiedFiles.length} modified files since turn start (scanned ${filePaths.length} total)`,
  )

  return modifiedFiles
}
