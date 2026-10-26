import { notes } from '@serenity-js/core';

type UploadNotes = { worldPackageUpload: {
  phase: string; attempts: number; filename: string; digest: string;
  submission: { world: { tenantId: string; worldId: string }; requestId: string; kind: string };
  transferId: string; upload: { received: string; state: { kind: string; blob: { byteSize: string; digest: string } } };
  operationKey: { operationId: string }; receipt: { phase: string; disclosure: { kind: string }; failure: { code: string; stage: string; details: unknown } };
  unchanged: { inventory: boolean; activeRelease: boolean }; refreshed: boolean;
} };
export const WorldPackageUpload = () => notes<UploadNotes>().get('worldPackageUpload');
export const OriginalWorldPackageUpload = () => notes<{ worldPackageUploadOriginal: {
  identity: { operationId: string; requestId: string; transferId: string; digest: string };
  sameIdentity: boolean; full: boolean; statusResultEqual: boolean; attempts: number; refreshed: boolean;
  actualPhase: string; failure: unknown;
} }>().get('worldPackageUploadOriginal');
export const OriginalWorldPackageRecovery = () => notes<{ worldPackageUploadRecovery: {
  assemble: string; sourceSeal: string; resumeAttempts: number; phase: string;
} }>().get('worldPackageUploadRecovery');
