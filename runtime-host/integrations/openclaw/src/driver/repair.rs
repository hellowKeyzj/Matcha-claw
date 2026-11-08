use std::future::Future;

use foundation::process::{
    ShutdownOutcome, TerminationOutcome,
    supervision::{StartOutcome, SupervisorPhase, TerminationCompletion},
};
use runtime_directory::{
    LifecycleOps, RuntimeLifecycleFailure, RuntimeRepairFailure, RuntimeRepairPhase,
    RuntimeRepairSnapshot, RuntimeRepairTrigger, RuntimeStartFailure,
};
use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

use super::OpenClawDriver;
use crate::lifecycle::{doctor::DoctorRepairOutcome, logs::LogStream};

pub trait StartupEffects: Sync {
    fn prepare(&self) -> impl Future<Output = Result<(), RuntimeStartFailure>> + Send;
    fn ready(&self) -> impl Future<Output = Result<(), RuntimeStartFailure>> + Send;
    fn is_shutting_down(&self) -> bool;
    fn wait_for_shutdown(&self) -> impl Future<Output = ()> + Send;
    fn notify(&self);
}

impl OpenClawDriver {
    pub async fn start_with_effects(
        &self,
        effects: &impl StartupEffects,
    ) -> Result<StartOutcome, RuntimeStartFailure> {
        if effects.is_shutting_down() {
            return Err(RuntimeStartFailure::ShuttingDown);
        }
        let starting = self.snapshot().phase() != SupervisorPhase::Running;
        if starting {
            self.confirm_stopped()
                .await
                .map_err(|_| RuntimeStartFailure::CompletionFailed)?;
            if effects.is_shutting_down() {
                return Err(RuntimeStartFailure::ShuttingDown);
            }
            self.begin_start_attempt();
            self.lifecycle_logs
                .append(LogStream::Stdout, b"[gateway] startup preparation started");
            self.lifecycle_logs.flush().await;
            let prepared = effects.prepare().await;
            self.lifecycle_logs.append(
                LogStream::Stdout,
                format!("[gateway] startup preparation result={prepared:?}").as_bytes(),
            );
            self.lifecycle_logs.flush().await;
            prepared?;
        }
        let result = self.start_with_shutdown(effects).await;
        if effects.is_shutting_down() {
            return result;
        }
        match result {
            Ok(StartOutcome::Started) => effects.ready().await.map(|()| StartOutcome::Started),
            _ if starting && self.requires_automatic_repair() => self
                .repair(RuntimeRepairTrigger::Automatic, effects)
                .await
                .map(|()| StartOutcome::Started)
                .map_err(|_| RuntimeStartFailure::CompletionFailed),
            _ => result,
        }
    }

    pub async fn repair(
        &self,
        trigger: RuntimeRepairTrigger,
        effects: &impl StartupEffects,
    ) -> Result<(), RuntimeRepairFailure> {
        self.begin_repair(trigger);
        self.lifecycle_logs.flush().await;
        let result = async {
            ensure_not_shutting_down(effects)?;
            self.confirm_stopped()
                .await
                .map_err(|_| RuntimeRepairFailure::StopFailed)?;
            ensure_not_shutting_down(effects)?;
            self.advance_repair(RuntimeRepairPhase::Repairing);
            self.lifecycle_logs.flush().await;
            let cancellation = CancellationToken::new();
            let shutdown = effects.wait_for_shutdown();
            let doctor = self.repair_native_state(cancellation.clone());
            tokio::pin!(doctor);
            tokio::select! {
                result = &mut doctor => result?,
                _ = shutdown => {
                    cancellation.cancel();
                    doctor.await?;
                    return Err(RuntimeRepairFailure::DoctorCancelled);
                }
            }
            ensure_not_shutting_down(effects)?;
            self.advance_repair(RuntimeRepairPhase::Preparing);
            self.lifecycle_logs.flush().await;
            effects
                .prepare()
                .await
                .map_err(|_| RuntimeRepairFailure::PreparationFailed)?;
            ensure_not_shutting_down(effects)?;
            self.advance_repair(RuntimeRepairPhase::Starting);
            self.lifecycle_logs.flush().await;
            let result = self.start_with_shutdown(effects).await;
            match result {
                Ok(StartOutcome::Started) => {}
                _ => return Err(RuntimeRepairFailure::StartFailed),
            }
            ensure_not_shutting_down(effects)?;
            effects
                .ready()
                .await
                .map_err(|_| RuntimeRepairFailure::PreparationFailed)?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => self.advance_repair(RuntimeRepairPhase::Succeeded),
            Err(failure) => {
                self.fail_repair(failure);
            }
        }
        self.lifecycle_logs.flush().await;
        effects.notify();
        result
    }

    async fn start_with_shutdown(
        &self,
        effects: &impl StartupEffects,
    ) -> Result<StartOutcome, RuntimeStartFailure> {
        if effects.is_shutting_down() {
            return Err(RuntimeStartFailure::ShuttingDown);
        }
        let lifecycle = self.owner();
        let start = self.start();
        tokio::pin!(start);
        tokio::select! {
            biased;
            _ = effects.wait_for_shutdown() => {
                let (shutdown, result) = tokio::join!(lifecycle.confirm_shutdown(), &mut start);
                return match shutdown {
                    Ok(ShutdownOutcome::Detached | ShutdownOutcome::Terminated(
                        TerminationOutcome::Graceful(_)
                        | TerminationOutcome::Forced(_)
                        | TerminationOutcome::NoProcess,
                    )) => result,
                    _ => Err(RuntimeStartFailure::CompletionFailed),
                };
            }
            result = &mut start => result,
        }
    }

    pub async fn confirm_stopped(&self) -> Result<(), RuntimeLifecycleFailure> {
        match self.stop().await {
            Ok(TerminationCompletion::Completed(
                TerminationOutcome::Graceful(_)
                | TerminationOutcome::Forced(_)
                | TerminationOutcome::NoProcess,
            ))
            | Err(RuntimeLifecycleFailure::AlreadySatisfied) => Ok(()),
            Ok(_) => Err(RuntimeLifecycleFailure::CompletionFailed),
            Err(error) => Err(error),
        }
    }

    pub fn try_reserve_lifecycle(&self) -> Option<OwnedMutexGuard<()>> {
        self.lifecycle_gate.clone().try_lock_owned().ok()
    }

    pub fn repair_snapshot(&self) -> RuntimeRepairSnapshot {
        self.repair_state
            .lock()
            .expect("OpenClaw repair state lock poisoned")
            .clone()
    }

    fn begin_start_attempt(&self) {
        self.diagnostic_state.clear();
        *self
            .repair_state
            .lock()
            .expect("OpenClaw repair state lock poisoned") = RuntimeRepairSnapshot {
            phase: RuntimeRepairPhase::Idle,
            trigger: None,
            failure: None,
        };
    }

    fn requires_automatic_repair(&self) -> bool {
        self.diagnostic_state.requires_repair()
    }

    fn begin_repair(&self, trigger: RuntimeRepairTrigger) {
        self.lifecycle_logs.append(
            LogStream::Stdout,
            format!("[repair] phase=Stopping trigger={trigger:?}").as_bytes(),
        );
        *self
            .repair_state
            .lock()
            .expect("OpenClaw repair state lock poisoned") = RuntimeRepairSnapshot {
            phase: RuntimeRepairPhase::Stopping,
            trigger: Some(trigger),
            failure: None,
        };
    }

    fn advance_repair(&self, phase: RuntimeRepairPhase) {
        self.lifecycle_logs.append(
            LogStream::Stdout,
            format!("[repair] phase={phase:?}").as_bytes(),
        );
        self.repair_state
            .lock()
            .expect("OpenClaw repair state lock poisoned")
            .phase = phase;
    }

    fn fail_repair(&self, failure: RuntimeRepairFailure) {
        self.lifecycle_logs.append(
            LogStream::Stderr,
            format!("[repair] phase=Failed failure={failure:?}").as_bytes(),
        );
        let mut state = self
            .repair_state
            .lock()
            .expect("OpenClaw repair state lock poisoned");
        state.phase = RuntimeRepairPhase::Failed;
        state.failure = Some(failure);
        eprintln!(
            "[openclaw-repair] phase=failed failure={failure:?}; inspect runtime diagnostics before retrying repair"
        );
    }

    async fn repair_native_state(
        &self,
        cancellation: CancellationToken,
    ) -> Result<(), RuntimeRepairFailure> {
        tokio::select! {
            _ = cancellation.cancelled() => return Err(RuntimeRepairFailure::DoctorCancelled),
            result = crate::lifecycle::port_guard::ensure_gateway_port_available(self.gateway_port) => {
                result.map_err(|_| RuntimeRepairFailure::StopFailed)?;
            }
        }
        match self
            .doctor_repair
            .run(cancellation, self.lifecycle_logs.clone())
            .await
        {
            DoctorRepairOutcome::Succeeded
            | DoctorRepairOutcome::Failed
            | DoctorRepairOutcome::TimedOut
            | DoctorRepairOutcome::SpawnFailed => Ok(()),
            DoctorRepairOutcome::Cancelled => Err(RuntimeRepairFailure::DoctorCancelled),
            DoctorRepairOutcome::CleanupUnconfirmed => Err(RuntimeRepairFailure::DoctorFailed),
        }
    }

    pub fn prepare_startup_configuration(&self) -> Result<(), runtime_directory::RuntimeStartFailure> {
        let prepare = || {
            crate::native_config::settings::ensure_default_session_idle(self.state_dir.clone())
                .map_err(|_| ())?;
            crate::native_config::control_ui::ensure_matcha_operator_device_auth_policy(
                self.state_dir.clone(),
            )
            .map_err(|_| ())?;
            if !matches!(
                crate::native_config::connector::preset::project_preset_mcp_server(
                    self.state_dir.clone(),
                    &self.runtime_host_mcp_executable,
                    &self.runtime_host_mcp_state_dir,
                ),
                crate::native_config::connector::external::ConnectorProjectionEffect::Written { .. }
            ) {
                return Err(());
            }
            Ok(())
        };
        prepare().map_err(|()| runtime_directory::RuntimeStartFailure::CompletionFailed)
    }
}

fn ensure_not_shutting_down(effects: &impl StartupEffects) -> Result<(), RuntimeRepairFailure> {
    if effects.is_shutting_down() {
        Err(RuntimeRepairFailure::DoctorCancelled)
    } else {
        Ok(())
    }
}
