#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { patchNsisExtractTemplate } from './patch-nsis-extract.mjs';
import { patchNsisInstallSectionTemplate } from './patch-nsis-install-section.mjs';
import { patchNsisUninstallTemplate } from './patch-nsis-uninstall.mjs';

export function patchWindowsNsisTemplates() {
  const extractOk = patchNsisExtractTemplate();
  const installSectionOk = patchNsisInstallSectionTemplate();
  const uninstallOk = patchNsisUninstallTemplate();
  return extractOk && installSectionOk && uninstallOk;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(patchWindowsNsisTemplates() ? 0 : 1);
}
