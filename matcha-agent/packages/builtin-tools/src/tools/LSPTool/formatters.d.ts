import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
} from 'vscode-languageserver-types'
/**
 * Formats goToDefinition result
 * Can return Location, LocationLink, or arrays of either
 */
export declare function formatGoToDefinitionResult(
  result: Location | Location[] | LocationLink | LocationLink[] | null,
  cwd?: string,
): string
/**
 * Formats findReferences result
 */
export declare function formatFindReferencesResult(
  result: Location[] | null,
  cwd?: string,
): string
/**
 * Formats hover result
 */
export declare function formatHoverResult(
  result: Hover | null,
  _cwd?: string,
): string
/**
 * Formats documentSymbol result (hierarchical outline)
 * Handles both DocumentSymbol[] (hierarchical, with range) and SymbolInformation[] (flat, with location.range)
 * per LSP spec which allows textDocument/documentSymbol to return either format
 */
export declare function formatDocumentSymbolResult(
  result: DocumentSymbol[] | SymbolInformation[] | null,
  cwd?: string,
): string
/**
 * Formats workspaceSymbol result (flat list of symbols)
 */
export declare function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  cwd?: string,
): string
/**
 * Formats prepareCallHierarchy result
 * Returns the call hierarchy item(s) at the given position
 */
export declare function formatPrepareCallHierarchyResult(
  result: CallHierarchyItem[] | null,
  cwd?: string,
): string
/**
 * Formats incomingCalls result
 * Shows all functions/methods that call the target
 */
export declare function formatIncomingCallsResult(
  result: CallHierarchyIncomingCall[] | null,
  cwd?: string,
): string
/**
 * Formats outgoingCalls result
 * Shows all functions/methods called by the target
 */
export declare function formatOutgoingCallsResult(
  result: CallHierarchyOutgoingCall[] | null,
  cwd?: string,
): string
