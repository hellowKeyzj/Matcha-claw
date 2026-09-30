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

pub(super) async fn start_admitted(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeStartCommandError> {
    apply_prelaunch_projections(shared).await;
    let result = lifecycle.start().await;
    shared.record_open_claw_start(result.clone());
    match super::status::runtime_start_result(result) {
        Ok(()) => {
            apply_ready_projections(shared).await;
            if !recover_ready_receipts(shared, true).await {
                shared.notify_open_claw_runtime();
                return Err(RuntimeStartCommandError::RuntimeStart(
                    crate::RuntimeStartFailure::SupervisorStopped,
                ));
            }
            shared.notify_open_claw_runtime();
            Ok(super::status::open_claw_state(shared))
        }
        Err(error) => {
            shared.notify_open_claw_runtime();
            Err(RuntimeStartCommandError::RuntimeStart(error))
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
        .map_err(RuntimeStopCommandError::RuntimeStop)
}

pub(super) async fn restart_admitted(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    restart_workflow(shared, lifecycle, false).await
}

pub(super) async fn restart_manual(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    restart_workflow(shared, lifecycle, true).await
}

async fn restart_workflow(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
    await_receipt_recovery: bool,
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    apply_prelaunch_projections(shared).await;
    let result = lifecycle.restart().await;
    match super::status::runtime_restart_result(result) {
        Ok(()) => {
            apply_ready_projections(shared).await;
            if !recover_ready_receipts(shared, await_receipt_recovery).await {
                shared.notify_open_claw_runtime();
                return Err(RuntimeRestartCommandError::RuntimeRestart(
                    crate::RuntimeLifecycleFailure::SupervisorStopped,
                ));
            }
            shared.notify_open_claw_runtime();
            Ok(super::status::open_claw_state(shared))
        }
        Err(error) => {
            shared.notify_open_claw_runtime();
            Err(RuntimeRestartCommandError::RuntimeRestart(error))
        }
    }
}

async fn recover_ready_receipts(shared: &PeerShared, await_completion: bool) -> bool {
    if await_completion {
        if shared
            .organization()
            .recover_materialization_receipts()
            .await
            .is_err()
        {
            eprintln!(
                "[runtime-control] OpenClaw ready; materialization receipt recovery unavailable"
            );
            return false;
        }
    } else {
        shared.team_run().recover_materialization_receipts().await;
    }
    true
}

pub(super) async fn apply_prelaunch_projections(shared: &PeerShared) {
    let started = std::time::Instant::now();
    eprintln!("[startup-trace] source=openclaw-prelaunch phase=prepare stage=start");
    let phase_started = std::time::Instant::now();
    if shared
        .open_claw()
        .preseed_matcha_workspace_identity()
        .is_err()
    {
        report_configuration_rejected(shared.openclaw_startup_diagnostics());
    }
    eprintln!(
        "[startup-trace] source=openclaw-prelaunch phase=workspace stage=end duration_ms={}",
        phase_started.elapsed().as_millis()
    );
    let phase_started = std::time::Instant::now();
    eprintln!("[startup-trace] source=openclaw-prelaunch phase=provider stage=start");
    let _ = shared.provider().prepare_private_projection().await;
    eprintln!(
        "[startup-trace] source=openclaw-prelaunch phase=provider stage=end duration_ms={}",
        phase_started.elapsed().as_millis()
    );
    let phase_started = std::time::Instant::now();
    eprintln!("[startup-trace] source=openclaw-prelaunch phase=settings stage=start");
    if shared.settings().apply_saved_projection().await != settings::DesiredOutcome::Confirmed {
        report_configuration_rejected(shared.openclaw_startup_diagnostics());
    }
    eprintln!(
        "[startup-trace] source=openclaw-prelaunch phase=settings stage=end duration_ms={}",
        phase_started.elapsed().as_millis()
    );
    let phase_started = std::time::Instant::now();
    eprintln!("[startup-trace] source=openclaw-prelaunch phase=security stage=start");
    if shared
        .security()
        .apply_saved_policy_projection()
        .await
        .is_err()
    {
        report_configuration_rejected(shared.openclaw_startup_diagnostics());
    }
    eprintln!(
        "[startup-trace] source=openclaw-prelaunch phase=security stage=end duration_ms={}",
        phase_started.elapsed().as_millis()
    );
    eprintln!(
        "[startup-trace] source=openclaw-prelaunch phase=prepare stage=end duration_ms={}",
        started.elapsed().as_millis()
    );
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
