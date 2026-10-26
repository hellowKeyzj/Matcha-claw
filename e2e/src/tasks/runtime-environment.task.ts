import { Task } from '@serenity-js/core';
import {
  ComparePublicPackageReadiness, ReadNativeTemplateCatalogBoundary,
  ReadPublicRuntimeEnvironment, RequestUnknownNativeTemplate,
} from '../interactions/runtime-environment.interaction.js';

export const InspectRuntimeEnvironment = () => Task.where('#actor inspects the public runtime environment',
  ReadPublicRuntimeEnvironment(),
);

export const InspectNativeTemplateCatalogBoundary = () => Task.where('#actor inspects the native template catalog boundary',
  ReadNativeTemplateCatalogBoundary(),
);

export const InspectUnknownNativeTemplateRejection = () => Task.where('#actor inspects the rejection of an unknown native template',
  RequestUnknownNativeTemplate(),
);

export const InspectPackageReadiness = () => Task.where('#actor inspects package readiness against the current environment',
  ComparePublicPackageReadiness(),
);
