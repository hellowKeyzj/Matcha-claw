use world_protocol::{ids::*, operation::OperationFailure, provenance::ReadDependency};
use crate::store::RetentionRoots;
use super::Error;

/// Diagnostic references are historical facts, never authority or a reason to retain another world.
pub(crate) fn operation_failure_roots(
    world: &WorldRef, failure: &OperationFailure, output: &mut RetentionRoots,
) -> Result<(), Error> {
    use world_protocol::{
        actions::ActionFailure as A, compiler::CompileFailure as C,
        definitions::DefinitionFailure as D, evaluation::EvaluationFailure as E,
        facts::FactFailure as F, generation::GenerationFailureKind as G,
        identity::IdentityFailure as I, learning::LearningFailure as L,
        process::HostFailure as H, query::QueryFailure as Q,
        releases::ReleaseFailure as R, slots::SlotFailure as S,
        sources::{MappingFailure as M, SourceFailure as V},
    };
    let mut roots = RetentionRoots::default();
    let mut pending = vec![failure.clone()];
    while let Some(failure) = pending.pop() {
        match failure {
            OperationFailure::Commit(failure) => match failure {
                world_protocol::commit::CommitFailure::ReadDependencyChanged { resource }
                | world_protocol::commit::CommitFailure::RevisionConflict { resource, .. } => roots.resources.push(resource),
                _ => {},
            },
            OperationFailure::Definition(failure) => match failure {
                D::HeadConflict { definition_id, .. } => roots.resources.push(ResourceRef::Definition { id: definition_id }),
                D::MissingReference { reference } | D::WrongKind { reference, .. }
                | D::CrossWorldReference { reference } | D::DeprecatedReference { reference }
                | D::ImmutableRevision { reference } => roots.definitions.push(reference),
                D::ScopeConflict { definitions } | D::ValidTimeConflict { definitions }
                | D::CyclicDependency { definitions } => roots.definitions.extend(definitions),
                D::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                _ => {},
            },
            OperationFailure::Compile(failure) => match failure {
                C::ReferenceMissing { reference, .. } => roots.definitions.push(reference),
                C::ReferenceAmbiguous { id, .. } => roots.resources.push(ResourceRef::Definition { id }),
                C::DependencyCycle { path } => roots.definitions.extend(path),
                C::TypeMismatch { definition, .. } | C::UnitMismatch { definition, .. }
                | C::CurrencyMismatch { definition, .. } | C::TimeMismatch { definition, .. }
                | C::ScopeMismatch { definition, .. } | C::EffectViolation { definition, .. }
                | C::InvalidExpression { definition, .. } => roots.definitions.push(definition),
                C::SourceCapabilityMissing { binding, .. } => roots.definitions.push(binding),
                C::CompatibilityBreak { definition, callers } => { roots.definitions.push(definition); roots.definitions.extend(callers); },
                C::Definition { failure } => pending.push(OperationFailure::Definition(failure)),
                _ => {},
            },
            OperationFailure::Upload(world_protocol::api::UploadFailure::Storage { failure }) => pending.push(OperationFailure::Material(failure)),
            OperationFailure::Material(failure) => match failure {
                world_protocol::materials::MaterialFailure::VersionContentUnavailable { reference }
                | world_protocol::materials::MaterialFailure::SourceVersionMissing { reference } => roots.source_versions.push(reference),
                _ => {},
            },
            OperationFailure::Source(failure) => match failure {
                V::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                V::Compile { failure } => pending.push(OperationFailure::Compile(failure)),
                V::Mapping { failure } => pending.push(OperationFailure::Mapping(failure)),
                V::Release { failure } => pending.push(OperationFailure::Release(*failure)),
                V::Package { failure } => pending.push(OperationFailure::Package(failure)),
                V::Lifecycle { failure } => pending.push(OperationFailure::Lifecycle(failure)),
                V::Binding { failure } => pending.push(OperationFailure::Binding(failure)),
                V::PluginInvocation { failure } => pending.push(match *failure {
                    H::Process(failure) => OperationFailure::Process(failure),
                    H::Operation(failure) => failure,
                    H::Input(failure) => OperationFailure::Input(failure),
                    H::Authorization(failure) => OperationFailure::Authorization(failure),
                    H::Binding(failure) => OperationFailure::Binding(failure),
                    H::Source(failure) => OperationFailure::Source(failure),
                    H::Slot(failure) => OperationFailure::Slot(failure),
                    H::Query(failure) => OperationFailure::Query(failure),
                    H::Generation(failure) => OperationFailure::Generation(failure),
                    H::State(failure) => OperationFailure::State(failure),
                    H::BudgetExceeded { dimension } => OperationFailure::BudgetExceeded { dimension },
                    H::Cancelled => OperationFailure::Cancelled,
                    H::InternalFault => OperationFailure::InternalFault,
                }),
                V::Cleanup { primary: Some(failure), .. } => pending.push(OperationFailure::Source(*failure)),
                _ => {},
            },
            OperationFailure::Mapping(failure) => match failure {
                M::SchemaMissing { reference } => roots.schemas.push(reference),
                M::MappingChanged { reference } => roots.mappings.push(reference),
                M::TypeMismatch { property } | M::UnitMismatch { property } | M::NullNotAllowed { property } => roots.definitions.push(property),
                _ => {},
            },
            OperationFailure::Release(failure) => match failure {
                R::BranchMissing { branch_id } => roots.resources.push(ResourceRef::Branch { id: branch_id }),
                R::BranchConflict { branch_id, expected, actual, .. } => {
                    roots.resources.push(ResourceRef::Branch { id: branch_id.clone() });
                    roots.branches.extend([expected, actual].map(|revision| world_protocol::releases::BranchRef { world: world.clone(), id: branch_id.clone(), revision }));
                },
                R::ReleaseMissing { release_id } | R::BackfillNotReady { release_id, .. } => roots.releases.push(release_id),
                R::HeadConflict { expected, actual, .. } => roots.releases.extend(expected.into_iter().chain(actual).filter(|head| head.world == *world).map(|head| head.release_id)),
                R::MergeConflicts { conflicts } => roots.resources.extend(conflicts.into_iter().map(|conflict| ResourceRef::Definition { id: conflict.definition_id })),
                R::BasisChanged { resources } => roots.resources.extend(resources),
                R::EvaluationRequired { suites } => roots.resources.extend(suites.into_iter().map(|id| ResourceRef::Suite { id })),
                R::EvaluationMissing { evaluation_id } | R::EvaluationRejected { evaluation_id } => roots.resources.push(ResourceRef::Evaluation { id: evaluation_id }),
                R::BackfillFailed { release_id, failure, .. } => { roots.releases.push(release_id); pending.push(OperationFailure::Source(failure)); },
                R::Compile { failure } => pending.push(OperationFailure::Compile(failure)),
                R::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                _ => {},
            },
            OperationFailure::Query(failure) => match failure {
                Q::Compile { failure } => pending.push(OperationFailure::Compile(failure)),
                Q::Source { source_id, failure } => { roots.resources.push(ResourceRef::Source { id: source_id }); pending.push(OperationFailure::Source(failure)); },
                Q::GuaranteeUnsatisfied { source_id, .. } => roots.resources.extend(source_id.into_iter().map(|id| ResourceRef::Source { id })),
                Q::ProjectionLag { source_id, .. } | Q::Gap { source_id } | Q::HistoryUnavailable { source_id } => roots.resources.push(ResourceRef::Source { id: source_id }),
                Q::Dirty { watches } => roots.resources.extend(watches.into_iter().map(|id| ResourceRef::Watch { id })),
                _ => {},
            },
            OperationFailure::Identity(failure) => match failure {
                I::Ambiguous { candidates } => roots.resources.extend(candidates.iter().map(subject)),
                I::AliasConflict { key } if key.world == *world => roots.resources.push(ResourceRef::Source { id: key.source_id }),
                I::OverlappingIncarnation { source_id } => roots.resources.push(ResourceRef::Source { id: source_id }),
                I::UnresolvedIdentity { subject: reference } => roots.resources.push(subject(&reference)),
                I::UnresolvedType { reference } | I::TypeKindMismatch { reference } => roots.definitions.push(reference),
                I::BasisChanged { resource } => roots.resources.push(resource),
                I::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                _ => {},
            },
            OperationFailure::Fact(failure) => match failure {
                F::Compilation { failure } => pending.push(OperationFailure::Compile(failure)),
                F::SourceMapping { failure } => pending.push(OperationFailure::Mapping(failure)),
                F::Provenance { failure } => provenance(failure, &mut roots, &mut pending),
                F::MissingDefinition { reference } => roots.definitions.push(reference),
                F::MissingSubject { subject: reference } => roots.resources.push(subject(&reference)),
                F::NullNotAllowed { property } => roots.definitions.push(property),
                F::InvalidRoleGroup { relation_type } => roots.definitions.push(relation_type),
                F::SourceAuthorityDenied { binding } => roots.definitions.push(binding),
                F::EvidenceMissing { reference } | F::EvidenceIncomplete { reference }
                | F::InvalidEvidenceLocator { reference } | F::EvidenceUnavailable { reference }
                | F::EvidenceDeleted { reference } => roots.evidence.push(reference),
                F::EvidenceCycle { references } => roots.evidence.extend(references),
                F::SupersedesMismatch { expected } => roots.dependencies.push(ReadDependency::Assertion { reference: expected }),
                F::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                _ => {},
            },
            OperationFailure::Learning(failure) => match failure {
                L::MissingEvidence { reference } => roots.evidence.push(reference),
                L::Definition { failure } => pending.push(OperationFailure::Definition(failure)),
                L::Model { failure } => pending.push(OperationFailure::Generation(failure)),
                L::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                L::EvaluationRequired { suites } => roots.resources.extend(suites.into_iter().map(|id| ResourceRef::Suite { id })),
                L::CounterexampleProtected { test_case_id } => roots.resources.push(ResourceRef::TestCase { id: test_case_id }),
                _ => {},
            },
            OperationFailure::Generation(failure) => {
                if let Some(value) = failure.receipt.and_then(|receipt| receipt.value) { crate::definitions::value_resources(&value, &mut roots.resources); }
                match failure.kind {
                    G::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                    G::Material { failure } => pending.push(OperationFailure::Material(failure)),
                    _ => {},
                }
            },
            OperationFailure::Evaluation(failure) => match failure {
                E::BadCase { test_case_id } => roots.resources.push(ResourceRef::TestCase { id: test_case_id }),
                E::SourceMissing { source_id } => roots.resources.push(ResourceRef::Source { id: source_id }),
                E::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                _ => {},
            },
            OperationFailure::Action(failure) => match failure {
                A::ContractMissing { reference } => roots.definitions.push(reference),
                A::Compilation { failure } => pending.push(OperationFailure::Compile(failure)),
                A::Evaluation { failure } => pending.push(OperationFailure::Query(failure)),
                A::Definition { failure } => pending.push(OperationFailure::Definition(failure)),
                A::Source { failure } => pending.push(OperationFailure::Source(failure)),
                A::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                _ => {},
            },
            OperationFailure::Slot(failure) => match failure {
                S::Connector(failure) => pending.push(OperationFailure::Source(failure)),
                S::Identity(failure) => pending.push(OperationFailure::Identity(failure)),
                S::Schema(failure) => pending.push(OperationFailure::Compile(failure)),
                S::Resolver(failure) => pending.push(OperationFailure::Query(failure)),
                S::Provenance(failure) => provenance(failure, &mut roots, &mut pending),
                S::Compiler(failure) => pending.push(OperationFailure::Compile(failure)),
                S::Action(failure) => pending.push(OperationFailure::Action(failure)),
                S::Storage(failure) => pending.push(OperationFailure::Commit(failure)),
                _ => {},
            },
            OperationFailure::State(failure) => match failure {
                world_protocol::state::StateFailure::RootConflict { expected, actual } => roots.resources.extend([expected, actual].into_iter().filter(|reference| reference.world == *world).map(|reference| ResourceRef::State { id: reference.id })),
                world_protocol::state::StateFailure::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
                _ => {},
            },
            OperationFailure::Package(world_protocol::package::PackageFailure::Commit { failure })
            | OperationFailure::Lifecycle(world_protocol::lifecycle::LifecycleFailure::Commit { failure }) => pending.push(OperationFailure::Commit(failure)),
            _ => {},
        }
    }
    output.resources.extend(roots.resources);
    output.definitions.extend(roots.definitions.into_iter().filter(|reference| reference.world == *world));
    output.evidence.extend(roots.evidence.into_iter().filter(|reference| reference.world == *world));
    output.dependencies.extend(roots.dependencies.into_iter().filter(|dependency| match dependency { ReadDependency::Assertion { reference } => reference.world == *world, _ => true }));
    output.source_versions.extend(roots.source_versions.into_iter().filter(|reference| reference.world == *world));
    output.schemas.extend(roots.schemas.into_iter().filter(|reference| reference.world == *world));
    output.mappings.extend(roots.mappings.into_iter().filter(|reference| reference.world == *world));
    output.releases.extend(roots.releases);
    output.branches.extend(roots.branches);
    Ok(())
}

fn provenance(failure: world_protocol::provenance::ProvenanceFailure, roots: &mut RetentionRoots, pending: &mut Vec<OperationFailure>) {
    use world_protocol::provenance::ProvenanceFailure as P;
    match failure {
        P::Dirty { watches } => roots.resources.extend(watches.into_iter().map(|id| ResourceRef::Watch { id })),
        P::UnclosedRange { watch_id } | P::BasisChanged { watch_id, .. } => roots.resources.push(ResourceRef::Watch { id: watch_id }),
        P::CyclicSupport { assertions } => roots.dependencies.extend(assertions.into_iter().map(|reference| ReadDependency::Assertion { reference })),
        P::Commit { failure } => pending.push(OperationFailure::Commit(failure)),
        _ => {},
    }
}

pub(super) fn subject(reference: &world_protocol::identity::SubjectRef) -> ResourceRef {
    match reference {
        world_protocol::identity::SubjectRef::Object { id } => ResourceRef::Object { id: id.clone() },
        world_protocol::identity::SubjectRef::Relation { id } => ResourceRef::Relation { id: id.clone() },
    }
}
