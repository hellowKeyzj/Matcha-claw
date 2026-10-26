import { lazy } from 'react';
import { applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { securityChecks, securitySections } from './extensions';

const SecurityPage = lazyWithPreload(() => import('./index'));
const RuntimeSection = lazy(() => import('./policy-sections').then((module) => ({ default: module.RuntimeSection })));
const MatrixSection = lazy(() => import('./policy-sections').then((module) => ({ default: module.MatrixSection })));
const PolicyGuardsSection = lazy(() => import('./policy-sections').then((module) => ({ default: module.PolicyGuardsSection })));
const RuleCatalogSection = lazy(() => import('./rule-catalog').then((module) => ({ default: module.RuleCatalogSection })));
const AllowlistRegexSection = lazy(() => import('./allowlist-regex').then((module) => ({ default: module.AllowlistRegexSection })));
const ActionCenterSection = lazy(() => import('./action-center').then((module) => ({ default: module.ActionCenterSection })));
const AuditHitsSection = lazy(() => import('./audit-hits').then((module) => ({ default: module.AuditHitsSection })));
const QuickAuditCheck = lazy(() => import('./checks').then((module) => ({ default: module.QuickAuditCheck })));
const EmergencyCheck = lazy(() => import('./checks').then((module) => ({ default: module.EmergencyCheck })));
const IntegrityCheck = lazy(() => import('./checks').then((module) => ({ default: module.IntegrityCheck })));
const RebaselineCheck = lazy(() => import('./checks').then((module) => ({ default: module.RebaselineCheck })));
const SkillScanCheck = lazy(() => import('./checks').then((module) => ({ default: module.SkillScanCheck })));
const AdvisoriesCheck = lazy(() => import('./checks').then((module) => ({ default: module.AdvisoriesCheck })));

export const securityPlugin = definePlugin({
  id: 'security',
  requires: ['app-shell'],
  extensionPoints: [securitySections, securityChecks],
  contributes: [
    contribute(applicationPages, { id: 'security', path: '/security', component: SecurityPage, preload: SecurityPage.preload }),
    contribute(securitySections, { id: 'runtime', label: 'sections.runtime', order: 10, component: RuntimeSection }),
    contribute(securitySections, { id: 'matrix', label: 'sections.matrix', order: 20, component: MatrixSection }),
    contribute(securitySections, { id: 'ruleCatalog', label: 'sections.ruleCatalog', order: 30, component: RuleCatalogSection }),
    contribute(securitySections, { id: 'allowlistRegex', label: 'sections.allowlistRegex', order: 40, component: AllowlistRegexSection }),
    contribute(securitySections, { id: 'policyGuards', label: 'sections.policyGuards', order: 50, component: PolicyGuardsSection }),
    contribute(securitySections, { id: 'actionCenter', label: 'sections.actionCenter', order: 60, component: ActionCenterSection }),
    contribute(securitySections, { id: 'auditHits', label: 'sections.auditHits', order: 70, component: AuditHitsSection }),
    contribute(securityChecks, { id: 'quickAudit', order: 10, component: QuickAuditCheck }),
    contribute(securityChecks, { id: 'emergency', order: 20, component: EmergencyCheck }),
    contribute(securityChecks, { id: 'integrity', order: 30, component: IntegrityCheck }),
    contribute(securityChecks, { id: 'rebaseline', order: 40, component: RebaselineCheck }),
    contribute(securityChecks, { id: 'skillScan', order: 50, component: SkillScanCheck }),
    contribute(securityChecks, { id: 'advisories', order: 60, component: AdvisoriesCheck }),
  ],
});
