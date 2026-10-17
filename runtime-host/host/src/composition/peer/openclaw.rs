use std::{future::Future, sync::Mutex};

use foundation::process::supervision::StartOutcome;
use openclaw::driver::{OpenClawDriver, StartupEffects};
use organization::{OrganizationHandle, TeamRunCoordinatorHandle};
use provider_module::ProviderHandle;
use runtime_directory::RuntimeRepairTrigger;

use crate::{RuntimeState, composition::admission::HostAdmission};

use super::{
    AutostartOpenClawError, RuntimeRestartCommandError, RuntimeStartCommandError,
    RuntimeStopCommandError, actor::PeerShared,
};

pub(super) async fn autostart(
    shared: &PeerShared,
) -> Result<RuntimeState, AutostartOpenClawError> {
    start_workflow(shared, false)
        .await
        .map_err(|_| AutostartOpenClawError::RuntimeStart)
}

pub(super) async fn start_admitted(
    shared: &PeerShared,
) -> Result<RuntimeState, RuntimeStartCommandError> {
    start_workflow(shared, true)
        .await
        .map_err(RuntimeStartCommandError::RuntimeStart)
}

async fn start_workflow(
    shared: &PeerShared,
    await_receipt_recovery: bool,
) -> Result<RuntimeState, crate::RuntimeStartFailure> {
    let effects = OpenClawStartupEffects::new(shared, await_receipt_recovery);
    let result = super::status::runtime_start_result(
        shared.open_claw().start_with_effects(&effects).await,
    );
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
    result.map(|()| {
        super::status::open_claw_state(
            shared.runtime_directory(),
            shared.openclaw_startup_diagnostics(),
        )
    })
}

pub(super) async fn stop(
    shared: &PeerShared,
) -> Result<RuntimeState, RuntimeStopCommandError> {
    if shared.admission().admit_request().is_err() {
        return Err(RuntimeStopCommandError::AdmissionClosed);
    }
    let result = confirm_stopped(shared.open_claw()).await;
    shared.notify_open_claw_runtime();
    result
        .map(|()| {
            super::status::open_claw_state(
                shared.runtime_directory(),
                shared.openclaw_startup_diagnostics(),
            )
        })
        .map_err(RuntimeStopCommandError::RuntimeStop)
}

pub(super) async fn restart_admitted(
    shared: &PeerShared,
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    restart_workflow(shared, false).await
}

pub(super) async fn restart_manual(
    shared: &PeerShared,
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    restart_workflow(shared, true).await
}

async fn restart_workflow(
    shared: &PeerShared,
    await_receipt_recovery: bool,
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    confirm_stopped(shared.open_claw())
        .await
        .map_err(RuntimeRestartCommandError::RuntimeRestart)?;
    start_workflow(shared, await_receipt_recovery)
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
) -> Result<RuntimeState, RuntimeRestartCommandError> {
    let effects = OpenClawStartupEffects::new(shared, true);
    let result = shared
        .open_claw()
        .repair(RuntimeRepairTrigger::Manual, &effects)
        .await;
    shared.notify_open_claw_runtime();
    result
        .map(|()| {
            super::status::open_claw_state(
                shared.runtime_directory(),
                shared.openclaw_startup_diagnostics(),
            )
        })
        .map_err(|_| {
            RuntimeRestartCommandError::RuntimeRestart(
                crate::RuntimeLifecycleFailure::CompletionFailed,
            )
        })
}

struct OpenClawStartupEffects<'a> {
    admission: &'a HostAdmission,
    driver: &'a OpenClawDriver,
    startup_diagnostics: &'a ::diagnostics::RuntimeStartupDiagnostics,
    provider: &'a ProviderHandle,
    settings: &'a settings::SettingsModule,
    security: &'a security::SecurityModule,
    organization: &'a OrganizationHandle,
    team_run: &'a TeamRunCoordinatorHandle,
    start_result: &'a Mutex<Option<Result<StartOutcome, runtime_directory::RuntimeStartFailure>>>,
    runtime_events: Option<&'a tokio::sync::mpsc::Sender<()>>,
    await_receipt_recovery: bool,
}

impl<'a> OpenClawStartupEffects<'a> {
    fn new(shared: &'a PeerShared, await_receipt_recovery: bool) -> Self {
        Self {
            admission: shared.admission(),
            driver: shared.open_claw(),
            startup_diagnostics: shared.openclaw_startup_diagnostics(),
            provider: shared.provider(),
            settings: shared.settings(),
            security: shared.security(),
            organization: shared.organization(),
            team_run: shared.team_run(),
            start_result: shared.open_claw_start_result(),
            runtime_events: shared.open_claw_runtime_events(),
            await_receipt_recovery,
        }
    }
}

impl StartupEffects for OpenClawStartupEffects<'_> {
    async fn prepare(&self) -> Result<(), runtime_directory::RuntimeStartFailure> {
        apply_prelaunch_projections(
            self.admission,
            self.driver,
            self.startup_diagnostics,
            self.provider,
            self.settings,
            self.security,
        )
        .await
    }

    async fn ready(&self) -> Result<(), runtime_directory::RuntimeStartFailure> {
        finish_ready(
            self.driver,
            self.startup_diagnostics,
            self.organization,
            self.team_run,
            self.await_receipt_recovery,
        )
        .await
    }

    fn is_shutting_down(&self) -> bool {
        matches!(
            self.admission.state().phase(),
            crate::HostPhase::ShuttingDown | crate::HostPhase::ShutDown
        )
    }

    fn wait_for_shutdown(&self) -> impl Future<Output = ()> + Send {
        let mut host_state = self.admission.subscribe();
        async move {
            loop {
                if matches!(
                    host_state.borrow_and_update().phase(),
                    crate::HostPhase::ShuttingDown | crate::HostPhase::ShutDown
                ) {
                    break;
                }
                if host_state.changed().await.is_err() {
                    break;
                }
            }
        }
    }

    fn record_start(&self, result: Result<StartOutcome, runtime_directory::RuntimeStartFailure>) {
        *self
            .start_result
            .lock()
            .expect("OpenClaw peer start result lock poisoned") = Some(result);
    }

    fn notify(&self) {
        if let Some(events) = self.runtime_events {
            let _ = events.try_send(());
        }
    }
}

async fn confirm_stopped(driver: &OpenClawDriver) -> Result<(), crate::RuntimeLifecycleFailure> {
    match driver.confirm_stopped().await {
        Ok(()) => Ok(()),
        Err(error) => super::status::runtime_stop_result(Err(error)),
    }
}

async fn finish_ready(
    driver: &OpenClawDriver,
    startup_diagnostics: &::diagnostics::RuntimeStartupDiagnostics,
    organization: &OrganizationHandle,
    team_run: &TeamRunCoordinatorHandle,
    await_receipt_recovery: bool,
) -> Result<(), runtime_directory::RuntimeStartFailure> {
    apply_ready_projections(driver, startup_diagnostics)?;
    if await_receipt_recovery {
        organization
            .recover_materialization_receipts()
            .await
            .map_err(|_| {
                eprintln!(
                    "[runtime-control] OpenClaw ready; materialization receipt recovery unavailable"
                );
                runtime_directory::RuntimeStartFailure::SupervisorStopped
            })?;
    } else {
        team_run.recover_materialization_receipts().await;
    }
    Ok(())
}

pub(super) async fn apply_prelaunch_projections(
    admission: &HostAdmission,
    driver: &OpenClawDriver,
    startup_diagnostics: &::diagnostics::RuntimeStartupDiagnostics,
    provider: &ProviderHandle,
    settings: &settings::SettingsModule,
    security: &security::SecurityModule,
) -> Result<(), runtime_directory::RuntimeStartFailure> {
    if matches!(
        admission.state().phase(),
        crate::HostPhase::ShuttingDown | crate::HostPhase::ShutDown
    ) {
        return Err(runtime_directory::RuntimeStartFailure::ShuttingDown);
    }
    let started = platform::trace::enabled().then(std::time::Instant::now);
    let result = async {
        driver.prepare_startup_configuration()
            .map_err(|_| runtime_directory::RuntimeStartFailure::CompletionFailed)?;
        driver
            .preseed_matcha_workspace_identity()
            .map_err(|_| runtime_directory::RuntimeStartFailure::CompletionFailed)?;
        let provider = provider.prepare_private_projection(
            runtime_directory::RuntimeDriverIdentity::open_claw().endpoint(),
        ).await;
        if matches!(
            provider.providers,
            provider_module::ProviderConfigWriteEffect::Unknown(_)
        ) || provider.restart == provider_module::ProviderRestartPreparation::Unknown
        {
            return Err(runtime_directory::RuntimeStartFailure::CompletionFailed);
        }
        if settings.apply_saved_projection().await != settings::DesiredOutcome::Confirmed {
            return Err(runtime_directory::RuntimeStartFailure::CompletionFailed);
        }
        security
            .apply_saved_policy_projection()
            .await
            .map_err(|_| runtime_directory::RuntimeStartFailure::CompletionFailed)?;
        Ok(())
    }
    .await;
    if let Some(started) = started {
        eprintln!(
            "[startup-trace] source=openclaw-prelaunch phase=prepare stage=end duration_ms={} success={}",
            started.elapsed().as_millis(),
            result.is_ok()
        );
    }
    if result.is_err() {
        report_configuration_rejected(startup_diagnostics);
    }
    result
}

fn apply_ready_projections(
    driver: &OpenClawDriver,
    startup_diagnostics: &::diagnostics::RuntimeStartupDiagnostics,
) -> Result<(), runtime_directory::RuntimeStartFailure> {
    driver
        .merge_matcha_workspace_context()
        .map(|_| ())
        .map_err(|_| {
            report_configuration_rejected(startup_diagnostics);
            runtime_directory::RuntimeStartFailure::CompletionFailed
        })
}

pub(super) fn report_configuration_rejected(
    diagnostics: &::diagnostics::RuntimeStartupDiagnostics,
) {
    diagnostics.report(openclaw::diagnostics::configuration_rejected());
}
