#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveNsisTemplatePath } from './nsis-template-paths.mjs';

export const INSTALL_UTIL_NSH = resolveNsisTemplatePath('include', 'installUtil.nsh');

const PATCH_MARKER = 'MatchaClaw-patched: skip legacy uninstaller';

const SKIP_LEGACY_UNINSTALLER = [
  `  ; ${PATCH_MARKER} on upgrades.`,
  '  ; customCheckAppRunning already killed processes and moved $INSTDIR aside.',
  '  DetailPrint "Skipping legacy uninstaller; continuing with overwrite install..."',
  '  ClearErrors',
  '  Return',
].join('\n');

const LEGACY_UNINSTALL_BLOCK =
  /  StrCpy \$uninstallerFileNameTemp "\$PLUGINSDIR\\old-uninstaller\.exe"[\s\S]*?  DoesNotExist:\r?\n    SetErrors\r?\nFunctionEnd/;

export function patchNsisUninstallTemplate(targetPath = INSTALL_UTIL_NSH) {
  if (!existsSync(targetPath)) {
    console.warn('[patch-nsis-uninstall] installUtil.nsh not found, skipping.');
    return false;
  }

  const original = readFileSync(targetPath, 'utf8');
  if (original.includes(PATCH_MARKER)) {
    return true;
  }

  if (!original.includes('Function uninstallOldVersion')) {
    console.warn('[patch-nsis-uninstall] uninstallOldVersion not found — template may have changed.');
    return false;
  }

  if (!LEGACY_UNINSTALL_BLOCK.test(original)) {
    console.warn('[patch-nsis-uninstall] Legacy uninstall block regex did not match.');
    return false;
  }

  const patched = original.replace(LEGACY_UNINSTALL_BLOCK, `${SKIP_LEGACY_UNINSTALLER}\nFunctionEnd`);
  if (patched === original) {
    console.warn('[patch-nsis-uninstall] No changes applied.');
    return false;
  }

  writeFileSync(targetPath, patched, 'utf8');
  console.log('[patch-nsis-uninstall] Patched installUtil.nsh (skip legacy uninstaller on upgrade).');
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ok = patchNsisUninstallTemplate();
  process.exit(ok ? 0 : 1);
}
