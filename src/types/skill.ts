/**
 * Skill Type Definitions
 * Types for skills/plugins
 */

/**
 * Skill data structure
 */
export interface SkillMissingRequirements {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: string[];
}

export type SkillMissingCategory = 'binaries' | 'anyBinaries' | 'environment' | 'configuration' | 'operatingSystem';

export type SkillUnavailableReason = 'disabled' | 'missingRequirements' | 'ineligible';

export interface Skill {
  id: string;
  runtimeId?: string;
  slug?: string;
  name: string;
  description: string;
  enabled: boolean;
  icon?: string;
  version?: string;
  author?: string;
  configurable?: boolean;
  config?: Record<string, unknown>;
  isCore?: boolean;
  isBundled?: boolean;
  uninstallable?: boolean;
  dependencies?: string[];
  selectable?: boolean;
  eligible?: boolean;
  unavailableReason?: SkillUnavailableReason | null;
  missingCategories?: SkillMissingCategory[];
  missing?: SkillMissingRequirements;
  source?: string;
  baseDir?: string;
  filePath?: string;
}

/**
 * Skill bundle (preset skill collection)
 */
export interface SkillBundle {
  id: string;
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  icon: string;
  skills: string[];
  recommended?: boolean;
}


/**
 * Marketplace skill data
 */
export interface MarketplaceSkill {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  downloads?: number;
  stars?: number;
}

export interface SealedSkillMetadata {
  skillKey: string;
  name: string;
  description: string;
  installed?: boolean;
  version?: string;
  source?: string;
  runtimes?: string[];
}

export interface SealedSkillCloudPackage {
  packageId?: string;
  packageVersionId?: string;
  packageType?: string;
  skillKey?: string;
  name?: string;
  description?: string;
  version?: string;
  fileName?: string;
  size?: number;
  uploadedAtMs?: number;
  installed?: boolean;
  downloadable?: boolean;
}

/**
 * Skill configuration schema
 */
export interface SkillConfigSchema {
  type: 'object';
  properties: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'array';
    title?: string;
    description?: string;
    default?: unknown;
    enum?: unknown[];
  }>;
  required?: string[];
}
