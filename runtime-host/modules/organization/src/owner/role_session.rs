use crate::{
    OrganizationStore, RoleSessionCreationOutcome, RoleSessionReceipt, RoleSessionSubmission,
    RuntimeReceiptOutcome, StoreFault,
    application::team_runtime::{RoleSessionCreateError, TeamRuntimeStatus},
};
use runtime_directory::OwnedRuntimeFuture;
use tokio_util::sync::CancellationToken;

use super::actor::OrganizationShared;

pub(super) struct PreparedRoleSession {
    pub(super) key: String,
    pub(super) binding: RoleSessionReceipt,
    readback: bool,
    pub(super) native: OwnedRuntimeFuture<RoleSessionCreationOutcome>,
}

pub(super) fn prepare(
    store: &mut OrganizationStore,
    shared: &OrganizationShared,
    key: String,
    intent: crate::store::RoleSessionIntent,
    cancellation: CancellationToken,
) -> Result<Option<PreparedRoleSession>, RoleSessionCreateError> {
    use RoleSessionCreateError::{Runtime, Store};
    use crate::store::RoleSessionPhase;
    if intent.phase == RoleSessionPhase::Confirmed { return Ok(None); }
    let binding = intent.binding;
    let workspace = store.prepare_run_workspace(binding.team_run()).map_err(Store)?;
    let runtime = shared.team_runtime_for_endpoint(binding.endpoint())
        .ok_or(Runtime(TeamRuntimeStatus::Unavailable))?;
    let readback = intent.phase == RoleSessionPhase::SubmissionUncertain;
    let native_binding = binding.clone();
    let native = if readback {
        Box::pin(async move {
            let (outcome, failure) = runtime.readback_team_role_session_cancellable(native_binding, workspace, cancellation).await;
            RoleSessionCreationOutcome {
                outcome: if outcome == RuntimeReceiptOutcome::Installed { outcome } else { RuntimeReceiptOutcome::OutcomeUnknown },
                failure,
                submission: RoleSessionSubmission::Settled,
            }
        }) as OwnedRuntimeFuture<RoleSessionCreationOutcome>
    } else {
        if cancellation.is_cancelled() { return Err(Runtime(TeamRuntimeStatus::Unavailable)); }
        store.mark_role_session_submission(&key, &binding, true).map_err(Store)?;
        Box::pin(async move {
            runtime.create_team_role_session_cancellable(native_binding, workspace, cancellation).await
        }) as OwnedRuntimeFuture<RoleSessionCreationOutcome>
    };
    Ok(Some(PreparedRoleSession { key, binding, readback, native }))
}

pub(super) fn settle(
    store: &mut OrganizationStore,
    key: &str,
    binding: &RoleSessionReceipt,
    readback: bool,
    result: RoleSessionCreationOutcome,
) -> (Result<(), RoleSessionCreateError>, Option<crate::TeamCreationFailure>) {
    use RoleSessionCreateError::Runtime;
    if !matches!(result.submission, RoleSessionSubmission::Settled)
        || result.outcome == RuntimeReceiptOutcome::OutcomeUnknown
    {
        return (Err(Runtime(TeamRuntimeStatus::OutcomeUnknown)), result.failure);
    }
    if !readback && result.outcome != RuntimeReceiptOutcome::Installed
        && store.mark_role_session_submission(key, binding, false).is_err()
    {
        return (Err(Runtime(TeamRuntimeStatus::OutcomeUnknown)), result.failure);
    }
    let outcome = match result.outcome {
        // The exact transaction rechecks lifecycle and Team tombstone after the native await.
        RuntimeReceiptOutcome::Installed => store.confirm_role_session(key, binding)
            .map_err(|_| Runtime(TeamRuntimeStatus::OutcomeUnknown)),
        RuntimeReceiptOutcome::Rejected => Err(Runtime(TeamRuntimeStatus::Rejected)),
        RuntimeReceiptOutcome::Unavailable => Err(Runtime(TeamRuntimeStatus::Unavailable)),
        RuntimeReceiptOutcome::OutcomeUnknown => Err(Runtime(TeamRuntimeStatus::OutcomeUnknown)),
    };
    (outcome, result.failure)
}

impl PreparedRoleSession {
    pub(super) fn into_parts(self) -> (String, RoleSessionReceipt, bool, OwnedRuntimeFuture<RoleSessionCreationOutcome>) {
        (self.key, self.binding, self.readback, self.native)
    }
}

pub(super) fn store_status(error: StoreFault) -> TeamRuntimeStatus {
    match error {
        StoreFault::InvalidFacts | StoreFault::RuntimeReceipt(_) => TeamRuntimeStatus::Rejected,
        StoreFault::CommitOutcomeUnknown(_) | StoreFault::RecoveryRequired => TeamRuntimeStatus::OutcomeUnknown,
        _ => TeamRuntimeStatus::Unavailable,
    }
}
