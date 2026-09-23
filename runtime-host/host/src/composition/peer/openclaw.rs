use crate::{RuntimeState, composition::runtime_ports::LifecycleOps};

use super::{
    AutostartOpenClawError, RuntimeRestartCommandError, RuntimeStartCommandError,
    RuntimeStopCommandError, actor::PeerShared,
};

pub(super) async fn autostart(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, AutostartOpenClawError> {
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
            Err(AutostartOpenClawError::RuntimeStart)
        }
    }
}

pub(super) async fn start(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeStartCommandError> {
    if shared.admission().admit_request().is_err() {
        return Err(RuntimeStartCommandError::AdmissionClosed);
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
            Err(RuntimeStartCommandError::RuntimeStart)
        }
    }
}

pub(super) async fn stop(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeStopCommandError> {
    if shared.admission().admit_request().is_err() {
        return Err(RuntimeStopCommandError::AdmissionClosed);
    }
    let result = lifecycle.stop().await;
    shared.notify_open_claw_runtime();
    super::status::runtime_stop_result(result)
        .map(|()| super::status::open_claw_state(shared))
        .map_err(|_| RuntimeStopCommandError::RuntimeStop)
}

pub(super) async fn restart(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    if shared.admission().admit_request().is_err() {
        return Err(RuntimeRestartCommandError::AdmissionClosed);
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
            Err(RuntimeRestartCommandError::RuntimeRestart)
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
