use super::*;

variant!(world_protocol::compiler::ExternalContractUse, ExternalContractUse; units [CompilerPass]; tuples []; records [DefinitionKind { name } => ExternalContractUseDefinitionKind, Function { reference } => ExternalContractUseFunction, Source { binding } => ExternalContractUseSource, Policy { policy_id, revision } => ExternalContractUsePolicy]);
record!(world_protocol::compiler::ExternalContractSelection, ExternalContractSelection; node_id, contract_id, kind);
record!(world_protocol::compiler::CompileSelection, CompileSelection; activation_lock_id, external_contracts);

variant!(world_protocol::compiler::ExternalContractKind, ExternalContractKind; units []; tuples []; records [DefinitionKind { name } => ExternalContractKindDefinitionKind, Function { reference } => ExternalContractKindFunction, Source { binding, capabilities } => ExternalContractKindSource, Policy { policy } => ExternalContractKindPolicy, CompilerPass { pass_id } => ExternalContractKindCompilerPass]);
record!(world_protocol::compiler::ExternalContract, ExternalContract; contract, implementation, kind);
record!(world_protocol::compiler::CompileRequest, CompileRequest; world, base_release, activation_lock, definitions, scopes, targets, external_contracts, config_digest);

record!(world_protocol::compiler::ExpressionAnnotation, ExpressionAnnotation; field, result_type, nullable, optional, effects);
record!(world_protocol::compiler::SourceRequirement, SourceRequirement; binding, required);
record!(world_protocol::compiler::DefinitionIr, DefinitionIr; reference, body_hash, body, scope, valid_time, annotations, policy_refs, source_requirements);
variant!(world_protocol::compiler::DependencyTarget, DependencyTarget; units []; tuples [Definition, Contract, Implementation, Config, Unit, Schema, Policy]; records []);
unit_enum!(world_protocol::compiler::DependencyUse, DependencyUse; Type, Body, Interface, Schema, SourceCapability, Policy, Unit, Provider, CompilerPass, Config);
unit_enum!(world_protocol::compiler::CompileTarget, CompileTarget; QueryPlan, Validator, ActionManifest, ToolCatalog, TypeScriptSdk, RustSdk);
record!(world_protocol::compiler::CompileDependency, CompileDependency; dependent, target, usage, selector, invalidates);
record!(world_protocol::compiler::DependencyGraph, DependencyGraph; edges);
record!(world_protocol::compiler::TypedIr, TypedIr; ir_version, world, definitions, dependencies);
record!(world_protocol::compiler::CompilerPassRequest, CompilerPassRequest; ir, declared_reads, allowed_rewrites, invariants, contract);
record!(world_protocol::compiler::CompilerPassResult, CompilerPassResult; ir, observed_dependencies, diagnostics);
variant!(world_protocol::compiler::CompileFailure, CompileFailure; units [Cancelled, InternalFault]; tuples []; records [ReferenceMissing { reference, field } => CompileFailureReferenceMissing, ReferenceAmbiguous { id, field } => CompileFailureReferenceAmbiguous, DependencyCycle { path } => CompileFailureDependencyCycle, TypeMismatch { definition, field, expected, actual } => CompileFailureTypeMismatch, UnitMismatch { definition, field, expected, actual } => CompileFailureUnitMismatch, CurrencyMismatch { definition, field, expected, actual } => CompileFailureCurrencyMismatch, TimeMismatch { definition, field } => CompileFailureTimeMismatch, ScopeMismatch { definition, field } => CompileFailureScopeMismatch, EffectViolation { definition, field, effect } => CompileFailureEffectViolation, SourceCapabilityMissing { binding, capability } => CompileFailureSourceCapabilityMissing, PolicyContractMissing { policy_id } => CompileFailurePolicyContractMissing, PolicyContractMismatch { contract } => CompileFailurePolicyContractMismatch, RequiredProviderMissing { contract } => CompileFailureRequiredProviderMissing, PassContractInvalid { provider_id } => CompileFailurePassContractInvalid, PassOutputInvalid { provider_id, field } => CompileFailurePassOutputInvalid, ArtifactInvalid { field } => CompileFailureArtifactInvalid, GeneratedSdkInvalid { target, field } => CompileFailureGeneratedSdkInvalid, CompatibilityBreak { definition, callers } => CompileFailureCompatibilityBreak, Definition { failure } => CompileFailureDefinition, InvalidExpression { definition, field } => CompileFailureInvalidExpression, LimitExceeded { field } => CompileFailureLimitExceeded]);
