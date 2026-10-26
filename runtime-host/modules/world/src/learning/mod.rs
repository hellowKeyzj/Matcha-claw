mod align;
mod error;
mod impact;
pub mod investigation;
pub(crate) use investigation::require_online_oracle_binding;
mod materialize;
mod metadata;
mod proposal;
mod provenance;
mod read;
mod rebase;
mod request;
mod retention;
mod selection;
pub(crate) use retention::{
    abstraction_proposal_retention_roots, archive_retention_roots, candidate_retention_roots, candidate_revision_retention_roots, compile_retention_roots, proposal_retention_roots,
    retain_expression, retain_operations, world_deletion_roots,
};
mod state;
mod tasks;

pub(crate) use align::align;
pub(crate) use impact::{
    candidate_impact, candidate_read_impact, draft_candidate_impact, validate_draft_evidence,
};
pub(crate) use materialize::{Materialized, materialize, materialize_current, materialize_frozen};
pub(crate) use metadata::{read_annotations, read_links};
pub(crate) use proposal::{complete_publication, lock as lock_candidate, next_change_revision, propose};
pub(crate) use provenance::{AttachedModelCall, recheck as recheck_model_calls};
pub(crate) use read::{change, changes, proposer, read_for_change};
pub(crate) use rebase::{preview_rebase, rebase};
pub(crate) use request::{
    abstraction_proposal, base_context, derive_branch, direct_candidate, prepare_branch, propose_request,
};
pub(crate) use selection::{compile_selection, selection_metadata};
pub(crate) use state::{
    affected_source_bindings, begin_testing, conclude_available_evaluations, conclude_evaluation,
    prepare_validation, validate_change,
};
pub(crate) use tasks::{list_tasks, task_summary};

pub(super) fn require_writer(tx: &crate::store::WorldTransaction<'_>) -> Result<(), Error> {
    let domain = world_protocol::ids::WriterDomain::try_new("learning")
        .map_err(|_| LearningFailure::InternalFault)?;
    Ok(tx.require_domain(&domain)?)
}

use world_protocol::{failure::FieldPath, learning::LearningFailure};

#[derive(Debug)]
pub(crate) enum Error {
    Rejected(LearningFailure),
    Store(crate::store::StoreError),
    Authorization(crate::authorization::AuthError),
    Definition(crate::definitions::DefinitionError),
    Fact(crate::facts::assertions::Error),
    Evaluation(crate::evaluation::Error),
    Owner(crate::owner::Error),
    Release(Box<crate::releases::Error>),
    Compile(world_protocol::compiler::CompileFailure),
    DependencyMissing { capability: &'static str },
}

impl From<LearningFailure> for Error {
    fn from(value: LearningFailure) -> Self {
        Self::Rejected(value)
    }
}
impl From<crate::store::StoreError> for Error {
    fn from(value: crate::store::StoreError) -> Self {
        Self::Store(value)
    }
}
impl From<crate::authorization::AuthError> for Error {
    fn from(value: crate::authorization::AuthError) -> Self {
        Self::Authorization(value)
    }
}
impl From<crate::definitions::DefinitionError> for Error {
    fn from(value: crate::definitions::DefinitionError) -> Self {
        Self::Definition(value)
    }
}
impl From<world_protocol::definitions::DefinitionFailure> for Error {
    fn from(failure: world_protocol::definitions::DefinitionFailure) -> Self {
        Self::Rejected(LearningFailure::Definition { failure })
    }
}
impl From<crate::facts::assertions::Error> for Error {
    fn from(value: crate::facts::assertions::Error) -> Self {
        Self::Fact(value)
    }
}
impl From<crate::evaluation::Error> for Error {
    fn from(value: crate::evaluation::Error) -> Self {
        Self::Evaluation(value)
    }
}
impl From<crate::owner::Error> for Error {
    fn from(value: crate::owner::Error) -> Self {
        Self::Owner(value)
    }
}
impl From<world_protocol::releases::ReleaseFailure> for Error {
    fn from(value: world_protocol::releases::ReleaseFailure) -> Self {
        Self::Release(Box::new(value.into()))
    }
}
impl From<crate::releases::Error> for Error {
    fn from(value: crate::releases::Error) -> Self {
        Self::Release(Box::new(value))
    }
}
impl From<world_protocol::compiler::CompileFailure> for Error {
    fn from(value: world_protocol::compiler::CompileFailure) -> Self {
        Self::Compile(value)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(_) => f.write_str("world.learning_rejected"),
            Self::Store(value) => value.fmt(f),
            Self::Authorization(value) => value.fmt(f),
            Self::Definition(value) => value.fmt(f),
            Self::Fact(value) => value.fmt(f),
            Self::Evaluation(value) => value.fmt(f),
            Self::Owner(value) => value.fmt(f),
            Self::Release(value) => value.fmt(f),
            Self::Compile(_) => f.write_str("world.learning_compile_rejected"),
            Self::DependencyMissing { capability } => {
                write!(f, "world.learning_dependency_missing: {capability}")
            }
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Store(value) => Some(value),
            Self::Authorization(value) => Some(value),
            Self::Definition(value) => Some(value),
            Self::Fact(value) => Some(value),
            Self::Evaluation(value) => Some(value),
            Self::Owner(value) => Some(value),
            Self::Release(value) => Some(value.as_ref()),
            _ => None,
        }
    }
}

fn invalid(index: usize, field: &str) -> Error {
    LearningFailure::InvalidOperation {
        index: u32::try_from(index).unwrap_or(u32::MAX),
        field: FieldPath(field.split('.').map(str::to_owned).collect()),
    }
    .into()
}
