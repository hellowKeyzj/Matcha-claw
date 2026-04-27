import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveRelayPluginStatePath } from './paths.js'

const SELECTION_FILE_NAME = 'relay-selection.json'

export type RelaySelectionRecord = {
  selectedBrowserInstanceId: string
  selectedWindowId: number | null
}

export function getRelaySelectionFilePath(stateDir?: string): string {
  return resolveRelayPluginStatePath(SELECTION_FILE_NAME, stateDir)
}

export async function readRelaySelection(stateDir?: string): Promise<RelaySelectionRecord | null> {
  try {
    const raw = await readFile(getRelaySelectionFilePath(stateDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<RelaySelectionRecord>
    if (
      typeof parsed.selectedBrowserInstanceId !== 'string'
      || !parsed.selectedBrowserInstanceId.trim()
      || (parsed.selectedWindowId !== null && !Number.isInteger(parsed.selectedWindowId))
    ) {
      return null
    }
    return {
      selectedBrowserInstanceId: parsed.selectedBrowserInstanceId.trim(),
      selectedWindowId: parsed.selectedWindowId,
    }
  } catch {
    return null
  }
}

export async function writeRelaySelection(selection: RelaySelectionRecord, stateDir?: string): Promise<void> {
  const filePath = getRelaySelectionFilePath(stateDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(selection, null, 2), 'utf8')
}

export async function clearRelaySelection(stateDir?: string): Promise<void> {
  await rm(getRelaySelectionFilePath(stateDir), { force: true })
}
