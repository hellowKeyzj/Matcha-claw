import type { AppPluginBuild, AppPluginInspection, AppPluginManifest } from '../../../src/types/desktop/app-plugin';
import type { AppPluginError } from './package';

export type StoredPackageRequest =
  | { operation: 'read' }
  | { operation: 'html'; entry: string; expectedManifest: AppPluginManifest }
  | { operation: 'files' }
  | { operation: 'verify' };

export type PackageRequest =
  | { operation: 'inspect'; packageBase64: string }
  | { operation: 'import'; packageBase64: string }
  | { operation: 'validate'; bytes: Uint8Array }
  | { operation: 'build'; input: { manifest: AppPluginManifest; files: Record<string, string> } }
  | (StoredPackageRequest & { bytes: Uint8Array; expectedDigest: string });

export interface PackageResults {
  inspect: AppPluginInspection;
  import: AppPluginInspection & { bytes: Uint8Array };
  build: AppPluginBuild;
  read: AppPluginInspection;
  files: AppPluginInspection & { files: ReadonlyMap<string, Uint8Array> };
  validate: AppPluginInspection & { files: ReadonlyMap<string, Uint8Array>; bytes: Uint8Array };
  html: { manifest: AppPluginManifest; html: string };
  verify: Uint8Array;
}

export type PackageReply = {
  [O in PackageRequest['operation']]: { ok: true; operation: O; result: PackageResults[O] }
}[PackageRequest['operation']] | { ok: false; code?: AppPluginError['code']; message: string };

export type PackageWorkerRequest = PackageRequest | { operation: 'close' };
