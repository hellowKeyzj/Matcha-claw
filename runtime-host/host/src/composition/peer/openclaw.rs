use foundation::process::supervision::StartOutcome;

use crate::{RuntimeState, composition::runtime_ports::LifecycleOps};

use super::{RestartOpenClawError, StartOpenClawError, StopOpenClawError, actor::PeerShared};

pub(super) async fn autostart(shared: &PeerShared, lifecycle: &dyn LifecycleOps) {
    apply_prelaunch_projections(shared).await;
    let result = lifecycle.start().await;
    let start_succeeded = matches!(&result, Ok(StartOutcome::Started));
    shared.record_open_claw_start(result);
    if start_succeeded {
        apply_ready_projections(shared).await;
        shared.team_run().recover_materialization_receipts().await;
    }
    shared.notify_open_claw_runtime();
}

pub(super) async fn start(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, StartOpenClawError> {
    if shared.admission().admit_request().is_err() {
        return Err(StartOpenClawError::AdmissionClosed);
    }
    apply_prelaunch_projections(shared).await;
    let result = lifecycle.start().await;
    shared.record_open_claw_start(result.clone());
    match super::status::runtime_start_result(result) {
        Ok(()) => {
            apply_ready_projections(shared).await;
            shared.team_run().recover_materialization_receipts().await;
            shared.notify_open_claw_runtime();
            Ok(super::status::open_claw_state(shared))
        }
        Err(_) => {
            shared.notify_open_claw_runtime();
            Err(StartOpenClawError::RuntimeStart)
        }
    }
}

pub(super) async fn stop(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, StopOpenClawError> {
    if shared.admission().admit_request().is_err() {
        return Err(StopOpenClawError::AdmissionClosed);
    }
    let result = lifecycle.stop().await;
    shared.notify_open_claw_runtime();
    super::status::runtime_stop_result(result)
        .map(|()| super::status::open_claw_state(shared))
        .map_err(|_| StopOpenClawError::RuntimeStop)
}

pub(super) async fn restart(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RestartOpenClawError> {
    if shared.admission().admit_request().is_err() {
        return Err(RestartOpenClawError::AdmissionClosed);
    }
    apply_prelaunch_projections(shared).await;
    let result = lifecycle.restart().await;
    match super::status::runtime_restart_result(result) {
        Ok(()) => {
            apply_ready_projections(shared).await;
            shared.team_run().recover_materialization_receipts().await;
            shared.notify_open_claw_runtime();
            Ok(super::status::open_claw_state(shared))
        }
        Err(_) => {
            shared.notify_open_claw_runtime();
            Err(RestartOpenClawError::RuntimeRestart)
        }
    }
}

pub(super) async fn apply_prelaunch_projections(shared: &PeerShared) {
    if shared
        .open_claw()
        .preseed_matcha_workspace_identity()
        .is_err()
    {
        report_configuration_rejected(shared.openclaw_startup_diagnostics());
    }
    let _ = shared.provider().prepare_private_projection().await;
    if shared.settings().apply_saved_projection().await != settings::DesiredOutcome::Confirmed {
        report_configuration_rejected(shared.openclaw_startup_diagnostics());
    }
    if shared
        .security()
        .apply_saved_policy_projection()
        .await
        .is_err()
    {
        report_configuration_rejected(shared.openclaw_startup_diagnostics());
    }
}

pub(super) async fn apply_ready_projections(shared: &PeerShared) {
    if shared.open_claw().merge_matcha_workspace_context().is_err() {
        report_configuration_rejected(shared.openclaw_startup_diagnostics());
    }
}

pub(super) fn report_configuration_rejected(
    diagnostics: &::diagnostics::RuntimeStartupDiagnostics,
) {
    diagnostics.report(openclaw::diagnostics::configuration_rejected());
}
