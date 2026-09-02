#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveNsisTemplatePath } from './nsis-template-paths.mjs';

export const EXTRACT_APP_PACKAGE_NSH = resolveNsisTemplatePath('include', 'extractAppPackage.nsh');

const PATCH_MARKER = 'MatchaClaw-patched-v2: extract directly to $INSTDIR and fail closed';
const LEGACY_PATCH_MARKER = 'MatchaClaw-patched: extract directly to $INSTDIR';
const CLAWX_LEGACY_PATCH_MARKER = 'ClawX-patched: extract directly to $INSTDIR';
const LEGACY_CONTINUE_ON_EXTRACT_FAILURE = 'continuing overwrite install anyway';
const FATAL_EXTRACT_FAILURE_DETAIL = 'Failed to extract MatchaClaw files after multiple attempts.';
const ROLLBACK_EXTRACT_FAILURE_DETAIL = 'Restoring previous MatchaClaw installation after failed update';

const PATCHED_EXTRACT_MACRO = [
  '!macro extractUsing7za FILE',
  `  ; ${PATCH_MARKER}.`,
  '  StrCpy $R9 0',
  '  matchaclaw_extract_attempt:',
  '    IntOp $R9 $R9 + 1',
  '    ClearErrors',
  '    SetOutPath "$INSTDIR"',
  '    Nsis7z::Extract "${FILE}"',
  '    IfErrors 0 matchaclaw_extract_done',
  '    ${if} $R9 < 5',
  '      DetailPrint "Releasing file locks before retry..."',
  '      nsExec::ExecToStack \'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"\'',
  '      Pop $0',
  '      Pop $1',
  '      nsExec::ExecToStack \'taskkill /F /IM openclaw-gateway.exe\'',
  '      Pop $0',
  '      Pop $1',
  '      Sleep 3000',
  '      Goto matchaclaw_extract_attempt',
  '    ${endIf}',
  `    DetailPrint "${FATAL_EXTRACT_FAILURE_DETAIL}"`,
  '    ${if} $matchaclawRollbackDir != ""',
  '      IfFileExists "$matchaclawRollbackDir\\" 0 matchaclaw_extract_show_error',
  `      DetailPrint "${ROLLBACK_EXTRACT_FAILURE_DETAIL}..."`,
  '      SetOutPath $TEMP',
  '      RMDir /r "$INSTDIR"',
  '      Rename "$matchaclawRollbackDir" "$INSTDIR"',
  '    ${endIf}',
  '  matchaclaw_extract_show_error:',
  '    MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK',
  '    SetErrorLevel 2',
  '    Quit',
  '  matchaclaw_extract_done:',
  '!macroend',
].join('\n');

const DECOMPRESS_MACRO = [
  '!macro decompress',
  '  !ifdef ZIP_COMPRESSION',
  '    nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"',
  '    Pop $R0',
  '    StrCmp $R0 "success" +3',
  '      MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)$\\n$R0"',
  '      Quit',
  '  !else',
  '    !insertmacro extractUsing7za "$PLUGINSDIR\\app-$packageArch.7z"',
  '  !endif',
  '!macroend',
  '',
].join('\n');

const EXTRACT_MACRO_PATTERN = /!macro extractUsing7za FILE[\s\S]*?!macroend/;

function countExtractMacros(content) {
  return (content.match(/!macro extractUsing7za FILE/g) || []).length;
}

function isTemplateHealthy(content) {
  return content.includes(PATCH_MARKER)
    && countExtractMacros(content) === 1
    && content.includes(FATAL_EXTRACT_FAILURE_DETAIL)
    && content.includes(ROLLBACK_EXTRACT_FAILURE_DETAIL)
    && content.includes('$(decompressionFailed)')
    && content.includes('SetErrorLevel 2')
    && content.includes('Quit')
    && !content.includes('$(appCannotBeClosed)')
    && !content.includes(LEGACY_CONTINUE_ON_EXTRACT_FAILURE);
}

function hasStaleExtractPatch(content) {
  return content.includes(PATCH_MARKER)
    || content.includes(LEGACY_PATCH_MARKER)
    || content.includes(CLAWX_LEGACY_PATCH_MARKER)
    || content.includes(LEGACY_CONTINUE_ON_EXTRACT_FAILURE)
    || content.includes('$(appCannotBeClosed)');
}

export function restoreExtractAppPackageTemplate(content) {
  const extractIdx = content.indexOf('!macro extractUsing7za FILE');
  const decompressIdx = content.indexOf('!macro decompress');
  const cutIdx = Math.min(
    extractIdx === -1 ? Number.POSITIVE_INFINITY : extractIdx,
    decompressIdx === -1 ? Number.POSITIVE_INFINITY : decompressIdx,
  );
  if (!Number.isFinite(cutIdx)) {
    return content;
  }
  return `${content.slice(0, cutIdx)}${PATCHED_EXTRACT_MACRO}\n\n${DECOMPRESS_MACRO}`;
}

export function patchNsisExtractTemplate(targetPath = EXTRACT_APP_PACKAGE_NSH) {
  if (!existsSync(targetPath)) {
    console.warn('[patch-nsis-extract] extractAppPackage.nsh not found, skipping.');
    return false;
  }

  let original = readFileSync(targetPath, 'utf8');
  if (isTemplateHealthy(original)) {
    return true;
  }

  if (countExtractMacros(original) !== 1) {
    console.warn('[patch-nsis-extract] Corrupted template detected; restoring tail section.');
    original = restoreExtractAppPackageTemplate(original);
    writeFileSync(targetPath, original, 'utf8');
    if (isTemplateHealthy(original)) {
      console.log('[patch-nsis-extract] Restored extractAppPackage.nsh (overwrite upgrade extract).');
      return true;
    }
  }

  if (hasStaleExtractPatch(original)) {
    console.warn('[patch-nsis-extract] Stale MatchaClaw extract patch detected; replacing with fail-closed patch.');
  } else if (!original.includes('CopyFiles')) {
    console.warn('[patch-nsis-extract] CopyFiles not found — NSIS template may have changed.');
    return false;
  }

  const patched = original.replace(EXTRACT_MACRO_PATTERN, () => PATCHED_EXTRACT_MACRO);
  if (patched === original) {
    console.warn('[patch-nsis-extract] No changes applied.');
    return false;
  }

  writeFileSync(targetPath, patched, 'utf8');
  console.log('[patch-nsis-extract] Patched extractAppPackage.nsh (direct extract, fail closed).');
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ok = patchNsisExtractTemplate();
  process.exit(ok ? 0 : 1);
}
