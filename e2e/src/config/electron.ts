import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cachedMain = resolve(repositoryRoot, 'e2e/.cache/app/dist-electron/main/index.js');
export const electronMain = resolve(repositoryRoot, process.env.E2E_MAIN?.trim() || cachedMain);
const appBuildRoot = resolve(dirname(electronMain), '../..');
if (electronMain !== resolve(appBuildRoot, 'dist-electron/main/index.js')) {
  throw new Error('E2E_MAIN must use the application dist-electron/main/index.js layout');
}
export const appProjectRoot = electronMain === cachedMain ? resolve(repositoryRoot) : appBuildRoot;
export const electronPreload = resolve(appBuildRoot, 'dist-electron/preload/index.js');
export const rendererIndex = resolve(appBuildRoot, 'dist/index.html');
export const UI_TIMEOUT_MS = 45_000;

const selectedProfile = process.env.E2E_PROFILE ?? (process.env.CI ? 'unlicensed' : 'licensed');
if (selectedProfile !== 'licensed' && selectedProfile !== 'unlicensed') {
  throw new Error('E2E_PROFILE must be licensed or unlicensed');
}
export const profileMode = selectedProfile;
export const licensedProfileRoot = resolve(repositoryRoot, 'e2e/.profiles/licensed');
