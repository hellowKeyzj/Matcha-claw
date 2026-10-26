import { notes } from '@serenity-js/core';

type MaterialsSetupNotes = { worldMaterialsSetup: {
  phase: string; enabled: boolean; signatureVerified: boolean; rootFlagsFalse: boolean; retained: boolean;
  custodyPath: string; installId?: string; packageDigest?: string; transportDigest?: string;
} };
export const WorldMaterialsSetupEvidence = () => notes<MaterialsSetupNotes>().get('worldMaterialsSetup');
