import { notes } from '@serenity-js/core';

type PublicReceipt = { ipcOk: boolean; status: number | null; httpOk: boolean; hasPrivateRuntimeFields: boolean };
type RuntimeEnvironmentNotes = {
  runtimeEnvironmentStatus: PublicReceipt & { hasPackageExistsBoolean: boolean; hasIsBuiltBoolean: boolean };
  runtimeEnvironmentTemplates: PublicReceipt & { hasCategoriesArray: boolean; hasTemplatesArray: boolean; missingTemplateIsAbsent: boolean };
  runtimeEnvironmentMissingTemplate: PublicReceipt & { successIsFalse: boolean; hasFixedPublicError: boolean; hasTemplate: boolean };
  runtimeEnvironmentReadiness: PublicReceipt & { environmentIsAvailable: boolean; hasBooleanValue: boolean; matchesPackageExists: boolean };
};

export const RuntimeEnvironmentProjection = () => notes<RuntimeEnvironmentNotes>().get('runtimeEnvironmentStatus');
export const NativeTemplateCatalogBoundary = () => notes<RuntimeEnvironmentNotes>().get('runtimeEnvironmentTemplates');
export const UnknownNativeTemplateRejection = () => notes<RuntimeEnvironmentNotes>().get('runtimeEnvironmentMissingTemplate');
export const PackageReadinessConsistency = () => notes<RuntimeEnvironmentNotes>().get('runtimeEnvironmentReadiness');
