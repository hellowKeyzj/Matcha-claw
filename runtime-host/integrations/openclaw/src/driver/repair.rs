use runtime_directory::{
    RuntimeRepairFailure, RuntimeRepairPhase, RuntimeRepairSnapshot, RuntimeRepairTrigger,
};
use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

use super::OpenClawDriver;
use crate::lifecycle::doctor::DoctorRepairOutcome;

impl OpenClawDriver {
    pub fn try_reserve_lifecycle(&self) -> Option<OwnedMutexGuard<()>> {
        self.lifecycle_gate.clone().try_lock_owned().ok()
    }

    pub fn repair_snapshot(&self) -> RuntimeRepairSnapshot {
        self.repair_state
            .lock()
            .expect("OpenClaw repair state lock poisoned")
            .clone()
    }

    pub fn begin_start_attempt(&self) {
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

    pub fn requires_automatic_repair(&self) -> bool {
        self.diagnostic_state.requires_repair()
    }

    pub fn begin_repair(&self, trigger: RuntimeRepairTrigger) {
        *self
            .repair_state
            .lock()
            .expect("OpenClaw repair state lock poisoned") = RuntimeRepairSnapshot {
            phase: RuntimeRepairPhase::Stopping,
            trigger: Some(trigger),
            failure: None,
        };
    }

    pub fn advance_repair(&self, phase: RuntimeRepairPhase) {
        self.repair_state
            .lock()
            .expect("OpenClaw repair state lock poisoned")
            .phase = phase;
    }

    pub fn fail_repair(&self, failure: RuntimeRepairFailure) {
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

    pub async fn repair_native_state(
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
            DoctorRepairOutcome::Succeeded => Ok(()),
            DoctorRepairOutcome::Failed => Err(RuntimeRepairFailure::DoctorFailed),
            DoctorRepairOutcome::TimedOut => Err(RuntimeRepairFailure::DoctorTimedOut),
            DoctorRepairOutcome::Cancelled => Err(RuntimeRepairFailure::DoctorCancelled),
            DoctorRepairOutcome::SpawnFailed => Err(RuntimeRepairFailure::DoctorSpawnFailed),
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
