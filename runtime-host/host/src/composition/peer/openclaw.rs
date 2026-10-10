use foundation::process::{
    TerminationOutcome,
    supervision::{SupervisorPhase, TerminationCompletion},
};
use runtime_directory::{RuntimeRepairFailure, RuntimeRepairPhase, RuntimeRepairTrigger};
use tokio_util::sync::CancellationToken;

use crate::{RuntimeState, composition::runtime_ports::LifecycleOps};

use super::{
    AutostartOpenClawError, RuntimeRestartCommandError, RuntimeStartCommandError,
    RuntimeStopCommandError, actor::PeerShared,
};

pub(super) async fn autostart(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, AutostartOpenClawError> {
    start_workflow(shared, lifecycle, false)
        .await
        .map_err(|_| AutostartOpenClawError::RuntimeStart)
}

pub(super) async fn start_admitted(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeStartCommandError> {
    start_workflow(shared, lifecycle, true)
        .await
        .map_err(RuntimeStartCommandError::RuntimeStart)
}

async fn start_workflow(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
    await_receipt_recovery: bool,
) -> Result<RuntimeState, crate::RuntimeStartFailure> {
    let starting = lifecycle.snapshot().phase() != SupervisorPhase::Running;
    let result = async {
        if starting {
            confirm_stopped(lifecycle)
                .await
                .map_err(|_| crate::RuntimeStartFailure::CompletionFailed)?;
            shared.open_claw().begin_start_attempt();
            apply_prelaunch_projections(shared).await?;
        }
        let result = lifecycle.start().await;
        shared.record_open_claw_start(result.clone());
        match super::status::runtime_start_result(result) {
            Ok(()) => finish_ready(shared, await_receipt_recovery).await,
            Err(_) if starting && shared.open_claw().requires_automatic_repair() => repair_workflow(
                shared,
                lifecycle,
                RuntimeRepairTrigger::Automatic,
                await_receipt_recovery,
            )
            .await
            .map_err(|_| crate::RuntimeStartFailure::CompletionFailed),
            Err(error) => Err(error),
        }
    }
    .await;
    if let Err(error) = &result {
        let failure = match error {
            crate::RuntimeStartFailure::Busy => runtime_directory::RuntimeStartFailure::Busy,
            crate::RuntimeStartFailure::ShuttingDown => {
                runtime_directory::RuntimeStartFailure::ShuttingDown
            }
            crate::RuntimeStartFailure::SupervisorStopped => {
                runtime_directory::RuntimeStartFailure::SupervisorStopped
            }
            _ => runtime_directory::RuntimeStartFailure::CompletionFailed,
        };
        shared.record_open_claw_start(Err(failure));
    }
    shared.notify_open_claw_runtime();
    result.map(|()| super::status::open_claw_state(shared))
}

pub(super) async fn stop(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeStopCommandError> {
    if shared.admission().admit_request().is_err() {
        return Err(RuntimeStopCommandError::AdmissionClosed);
    }
    let result = confirm_stopped(lifecycle).await;
    shared.notify_open_claw_runtime();
    result
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
    confirm_stopped(lifecycle)
        .await
        .map_err(RuntimeRestartCommandError::RuntimeRestart)?;
    start_workflow(shared, lifecycle, await_receipt_recovery)
        .await
        .map_err(|error| {
            RuntimeRestartCommandError::RuntimeRestart(match error {
                crate::RuntimeStartFailure::CompletionFailed => {
                    crate::RuntimeLifecycleFailure::CompletionFailed
                }
                crate::RuntimeStartFailure::Cancelled => crate::RuntimeLifecycleFailure::Cancelled,
                crate::RuntimeStartFailure::SupervisorStopped => {
                    crate::RuntimeLifecycleFailure::SupervisorStopped
                }
                crate::RuntimeStartFailure::Busy => crate::RuntimeLifecycleFailure::Busy,
                crate::RuntimeStartFailure::Rejected => crate::RuntimeLifecycleFailure::Rejected,
                crate::RuntimeStartFailure::ShuttingDown => {
                    crate::RuntimeLifecycleFailure::ShuttingDown
                }
            })
        })
}

pub(super) async fn repair_manual(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    let result = repair_workflow(shared, lifecycle, RuntimeRepairTrigger::Manual, true).await;
    shared.notify_open_claw_runtime();
    result
        .map(|()| super::status::open_claw_state(shared))
        .map_err(|_| {
            RuntimeRestartCommandError::RuntimeRestart(
                crate::RuntimeLifecycleFailure::CompletionFailed,
            )
        })
}

async fn repair_workflow(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
    trigger: RuntimeRepairTrigger,
    await_receipt_recovery: bool,
) -> Result<(), RuntimeRepairFailure> {
    let driver = shared.open_claw();
    driver.begin_repair(trigger);
    let result = async {
        ensure_not_shutting_down(shared)?;
        confirm_stopped(lifecycle).await.map_err(|_| RuntimeRepairFailure::StopFailed)?;
        ensure_not_shutting_down(shared)?;
        driver.advance_repair(RuntimeRepairPhase::Repairing);
        let cancellation = CancellationToken::new();
        let mut host_state = shared.admission().subscribe();
        let doctor = driver.repair_native_state(cancellation.clone());
        tokio::pin!(doctor);
        tokio::select! {
            result = &mut doctor => result?,
            _ = async {
                loop {
                    if matches!(host_state.borrow_and_update().phase(), crate::HostPhase::ShuttingDown | crate::HostPhase::ShutDown) {
                        break;
                    }
                    if host_state.changed().await.is_err() {
                        break;
                    }
                }
            } => {
                cancellation.cancel();
                doctor.await?;
                return Err(RuntimeRepairFailure::DoctorCancelled);
            }
        }
        ensure_not_shutting_down(shared)?;
        driver.advance_repair(RuntimeRepairPhase::Preparing);
        apply_prelaunch_projections(shared).await.map_err(|_| RuntimeRepairFailure::PreparationFailed)?;
        ensure_not_shutting_down(shared)?;
        driver.advance_repair(RuntimeRepairPhase::Starting);
        let result = lifecycle.start().await;
        shared.record_open_claw_start(result.clone());
        super::status::runtime_start_result(result).map_err(|_| RuntimeRepairFailure::StartFailed)?;
        finish_ready(shared, await_receipt_recovery).await.map_err(|_| RuntimeRepairFailure::PreparationFailed)?;
        Ok(())
    }.await;
    match result {
        Ok(()) => driver.advance_repair(RuntimeRepairPhase::Succeeded),
        Err(failure) => {
            driver.fail_repair(failure);
            shared.record_open_claw_start(Err(
                runtime_directory::RuntimeStartFailure::CompletionFailed,
            ));
        }
    }
    shared.notify_open_claw_runtime();
    result
}

fn ensure_not_shutting_down(shared: &PeerShared) -> Result<(), RuntimeRepairFailure> {
    if matches!(
        shared.admission().state().phase(),
        crate::HostPhase::ShuttingDown | crate::HostPhase::ShutDown
    ) {
        Err(RuntimeRepairFailure::DoctorCancelled)
    } else {
        Ok(())
    }
}

async fn confirm_stopped(
    lifecycle: &dyn LifecycleOps,
) -> Result<(), crate::RuntimeLifecycleFailure> {
    match lifecycle.stop().await {
        Ok(TerminationCompletion::Completed(
            TerminationOutcome::Graceful(_)
            | TerminationOutcome::Forced(_)
            | TerminationOutcome::NoProcess,
        ))
        | Err(runtime_directory::RuntimeLifecycleFailure::AlreadySatisfied) => Ok(()),
        Ok(_) => Err(crate::RuntimeLifecycleFailure::CompletionFailed),
        Err(error) => super::status::runtime_stop_result(Err(error)),
    }
}

async fn finish_ready(
    shared: &PeerShared,
    await_receipt_recovery: bool,
) -> Result<(), crate::RuntimeStartFailure> {
    apply_ready_projections(shared)?;
    if await_receipt_recovery {
        shared
            .organization()
            .recover_materialization_receipts()
            .await
            .map_err(|_| {
                eprintln!(
                    "[runtime-control] OpenClaw ready; materialization receipt recovery unavailable"
                );
                crate::RuntimeStartFailure::SupervisorStopped
            })?;
    } else {
        shared.team_run().recover_materialization_receipts().await;
    }
    Ok(())
}

pub(super) async fn apply_prelaunch_projections(
    shared: &PeerShared,
) -> Result<(), crate::RuntimeStartFailure> {
    if matches!(
        shared.admission().state().phase(),
        crate::HostPhase::ShuttingDown | crate::HostPhase::ShutDown
    ) {
        return Err(crate::RuntimeStartFailure::ShuttingDown);
    }
    let started = std::time::Instant::now();
    let result = async {
        shared.open_claw().prepare_startup_configuration()
            .map_err(|_| crate::RuntimeStartFailure::CompletionFailed)?;
        shared
            .open_claw()
            .preseed_matcha_workspace_identity()
            .map_err(|_| crate::RuntimeStartFailure::CompletionFailed)?;
        let provider = shared.provider().prepare_private_projection().await;
        if matches!(
            provider.providers,
            provider_module::ProviderConfigWriteEffect::Unknown(_)
        ) || provider.restart == provider_module::ProviderRestartPreparation::Unknown
        {
            return Err(crate::RuntimeStartFailure::CompletionFailed);
        }
        if shared.settings().apply_saved_projection().await != settings::DesiredOutcome::Confirmed {
            return Err(crate::RuntimeStartFailure::CompletionFailed);
        }
        shared
            .security()
            .apply_saved_policy_projection()
            .await
            .map_err(|_| crate::RuntimeStartFailure::CompletionFailed)?;
        Ok(())
    }
    .await;
    eprintln!(
        "[startup-trace] source=openclaw-prelaunch phase=prepare stage=end duration_ms={} success={}",
        started.elapsed().as_millis(),
        result.is_ok()
    );
    if result.is_err() {
        report_configuration_rejected(shared.openclaw_startup_diagnostics());
    }
    result
}

fn apply_ready_projections(shared: &PeerShared) -> Result<(), crate::RuntimeStartFailure> {
    shared
        .open_claw()
        .merge_matcha_workspace_context()
        .map(|_| ())
        .map_err(|_| {
            report_configuration_rejected(shared.openclaw_startup_diagnostics());
            crate::RuntimeStartFailure::CompletionFailed
        })
}

pub(super) fn report_configuration_rejected(
    diagnostics: &::diagnostics::RuntimeStartupDiagnostics,
) {
    diagnostics.report(openclaw::diagnostics::configuration_rejected());
}
