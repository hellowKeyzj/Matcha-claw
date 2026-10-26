//! Source input custody. PostgreSQL remains the only durable owner and commit boundary.
mod branch_capture;
mod branch_sources;
pub(in crate::sources) use branch_sources::same_model as same_branch_model;
pub(crate) use branch_sources::{
    CandidateSources, VerifiedCandidateSources, branch_capture_impact, branch_snapshot_materials,
    candidate_promotion_impact, read_branch_sources, read_branch_sources_snapshot,
    require_basis_after, require_candidate_ready, require_candidate_ready_snapshot,
    require_capture_after,
    selected_branch_capture, selected_branch_capture_snapshot, verify_candidate_sources,
};
mod branch_observation;
mod branch_producer;
mod branch_promotion;
pub(crate) use branch_capture::{BranchCapture, read_branch_capture, read_branch_capture_snapshot};
pub(crate) use branch_observation::BranchObservation;
pub(crate) use branch_producer::{capture_branch, verify_branch_capture};
pub(crate) use branch_promotion::promote_candidate_sources;
mod changes;
mod claims;
mod coverage;
pub(crate) use coverage::reconcile_subject_coverage;
mod error;
mod frontier;
mod identity;
mod inbox;
mod lifecycle;
mod model;
mod owner;
mod partition;
mod record_state;
mod retention;
pub(crate) use retention::{archive_source_roots, retained_source_materials, world_deletion_roots};
mod snapshot;
mod status;
mod trusted;
pub(crate) use owner::{FencedSourceSegment, SyncOwner};
pub(in crate::sources) use status::recheck_assignment;
pub(crate) use status::{
    command_impact, require_segment_parent, require_segment_recovery, segment_parent, segment_parents, status, status_impact,
    stop_run_basis,
};

pub(crate) use claims::{SourceRetraction, assertion_id as source_claim_id};
pub(crate) use error::SyncError;
pub(crate) use frontier::{
    AppliedAck, Frontier, bindings_projection_basis, bindings_projection_ready, frontier, mark_projected,
    prepare_ack, projection_basis, publish_projection, recheck_basis, require_after,
    require_after_transaction, require_bindings_ready, require_projected_transaction,
    require_release_ready,
};
pub(crate) use identity::{SourceIdentityDeletion, SourceIdentityPrefix, SourceIdentityRow};
pub(crate) use inbox::{acknowledge, capture, pending};
pub(crate) use lifecycle::{SourceCarriers, StoppedCarriers};
pub(crate) use model::{
    Assignment, CaptureKind, CapturedInput, Checkpoint, SourceParent, SourceSegment, SyncIdentity,
};
pub(crate) use partition::{activate, begin_quiesce, initialize, load, seal};
pub(crate) use record_state::read_record_states;
pub(crate) use snapshot::{
    SnapshotOutcome, SnapshotRun, snapshot_materials, validate_snapshot_outcome,
};
pub(crate) use trusted::{PreparedCapture, TrustedRecords};

use crate::{
    authorization::{self, Admission},
    store::{StoreError, WorldTransaction},
};
use serde::{Serialize, de::DeserializeOwned};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    commit::CommitFailure,
    failure::FailureStage,
    ids::*,
    time::Timestamp,
};

fn encode(value: &impl Serialize) -> Result<serde_json::Value, SyncError> {
    serde_json::to_value(value).map_err(|cause| SyncError::codec(FailureStage::Validate, cause))
}
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, SyncError> {
    serde_json::from_value(value).map_err(|cause| SyncError::codec(FailureStage::Decode, cause))
}
fn number(value: u64) -> Result<i64, SyncError> {
    i64::try_from(value).map_err(|cause| {
        SyncError::caused(
            world_protocol::sources::SourceFailure::ProtocolViolation,
            FailureStage::Validate,
            cause,
        )
    })
}
fn require_writer(tx: &WorldTransaction<'_>) -> Result<(), SyncError> {
    tx.require_domain(&WriterDomain::try_new("sources").map_err(|_| SyncError::protocol())?)?;
    Ok(())
}
async fn authorize(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    assignment: &Assignment,
    mode: AccessMode,
) -> Result<Timestamp, SyncError> {
    if tx.world() != &assignment.world {
        return Err(SyncError::protocol());
    }
    require_writer(tx)?;
    let now = tx.now().await?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::Source {
                id: assignment.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![mode],
            scope: assignment.scope.clone(),
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![assignment.source_id.clone()],
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &now).await?;
    Ok(now)
}
fn source_failure(
    failure: world_protocol::sources::SourceFailure,
    stage: FailureStage,
) -> SyncError {
    SyncError::Source(crate::sources::connectors::SourceError::new(failure, stage))
}
fn changed(changed: u64, assignment: &Assignment) -> Result<(), SyncError> {
    if changed == 1 {
        return Ok(());
    }
    Err(StoreError::new(
        CommitFailure::ReadDependencyChanged {
            resource: ResourceRef::Source {
                id: assignment.source_id.clone(),
            },
        },
        FailureStage::Validate,
    )
    .into())
}
