mod acceptance;
pub(crate) use acceptance::{
    check as require_evaluations, check_read as require_evaluations_read, select_accepted_evaluations,
};
mod artifact;
mod publication;
pub(crate) use publication::publish;
mod rollback;
pub(crate) use rollback::{
    PreparedRollback, RollbackPins, pin_rollback, release_rollback_pins, release_scope, rollback,
    validate_rollback,
};
mod basis;
mod context;
mod impact;
pub(crate) use context::{
    editing_context_impact, read_compile_context, read_editing_context,
    read_editing_context_in_transaction,
};
pub(crate) use impact::{affected_definitions, model_impact, source_bindings};
mod branch;
mod directory;
mod error;
pub(crate) use directory::{
    definition, directory_impact, list_branches, list_definitions, list_releases,
};
mod merge;
mod persist;
pub(crate) use merge::merge_definitions;
mod read;
mod retention;
pub(crate) use retention::{
    ReleaseRetention, definition_model_retention, definition_resource_retention,
    definition_retention, release_retention,
};
mod snapshot;

pub(crate) use snapshot::{
    read_active_head_snapshot, read_active_release_snapshot, read_branch_revision_snapshot,
    read_branch_snapshot, read_release_snapshot,
};

pub(crate) use branch::{freeze_branch_basis, insert_branch, next_branch_revision, require_branch_model, update_branch};

pub(crate) use persist::bootstrap_release;

pub(crate) use artifact::{
    PreparedArtifact, discard_artifact, prepare_artifact, prepare_artifact_from_compilation,
    refresh_artifact, store_artifact, validate_manifest,
};
pub(crate) use error::Error;
pub(crate) use read::{
    has_activation_references, read_active_head, read_active_model, read_active_release,
    read_artifact, read_branch, read_branch_revision, read_candidate, read_definition_exact,
    read_head, read_release,
};

fn require_writer(tx: &crate::store::WorldTransaction<'_>) -> Result<(), Error> {
    let domain = world_protocol::ids::WriterDomain::try_new("releases")
        .map_err(|_| world_protocol::compiler::CompileFailure::InternalFault)?;
    Ok(tx.require_domain(&domain)?)
}
