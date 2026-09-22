use std::{
    fmt,
    sync::atomic::{AtomicU8, Ordering},
};

use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum HostPhase {
    Created,
    Starting,
    Ready,
    ShuttingDown,
    ShutDown,
}

impl fmt::Display for HostPhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Created => "created",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::ShuttingDown => "shutting down",
            Self::ShutDown => "shut down",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestAdmission {
    Accepting,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostState {
    phase: HostPhase,
    request_admission: RequestAdmission,
}

impl HostState {
    const fn from_phase(phase: HostPhase) -> Self {
        let request_admission = match phase {
            HostPhase::Ready => RequestAdmission::Accepting,
            HostPhase::Created
            | HostPhase::Starting
            | HostPhase::ShuttingDown
            | HostPhase::ShutDown => RequestAdmission::Closed,
        };
        Self {
            phase,
            request_admission,
        }
    }

    pub const fn phase(self) -> HostPhase {
        self.phase
    }

    pub const fn request_admission(self) -> RequestAdmission {
        self.request_admission
    }
}

pub struct HostAdmission {
    phase: AtomicU8,
    changes: watch::Sender<HostState>,
}

impl HostAdmission {
    pub fn new() -> Self {
        let (changes, _) = watch::channel(HostState::from_phase(HostPhase::Created));
        Self {
            phase: AtomicU8::new(HostPhase::Created as u8),
            changes,
        }
    }

    pub fn state(&self) -> HostState {
        HostState::from_phase(decode_phase(self.phase.load(Ordering::Acquire)))
    }

    /// Begins the one-way host startup sequence.
    ///
    /// # Errors
    ///
    /// Returns [`HostTransitionError::StartFrom`] unless the host is newly created.
    pub fn begin_start(&self) -> Result<(), HostTransitionError> {
        self.transition(HostPhase::Created, HostPhase::Starting)
            .map_err(HostTransitionError::StartFrom)
    }

    /// Publishes that host-level initialization is complete and opens request admission.
    ///
    /// # Errors
    ///
    /// Returns [`HostTransitionError::ReadyFrom`] unless startup is in progress.
    pub fn publish_ready(&self) -> Result<(), HostTransitionError> {
        self.transition(HostPhase::Starting, HostPhase::Ready)
            .map_err(HostTransitionError::ReadyFrom)
    }

    /// Closes request admission and begins host shutdown.
    ///
    /// Shutdown is valid after owner construction, including before startup begins, so every
    /// constructed owner follows explicit shutdown and join.
    ///
    /// # Errors
    ///
    /// Returns [`HostTransitionError::ShutdownFrom`] unless the host is created, starting, or
    /// ready.
    pub fn begin_shutdown(&self) -> Result<(), HostTransitionError> {
        loop {
            let phase = decode_phase(self.phase.load(Ordering::Acquire));
            if !matches!(
                phase,
                HostPhase::Created | HostPhase::Starting | HostPhase::Ready
            ) {
                return Err(HostTransitionError::ShutdownFrom(phase));
            }
            if self
                .phase
                .compare_exchange(
                    phase as u8,
                    HostPhase::ShuttingDown as u8,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                self.changes
                    .send_replace(HostState::from_phase(HostPhase::ShuttingDown));
                return Ok(());
            }
        }
    }

    /// Publishes that the host shutdown sequence and joins have completed.
    ///
    /// # Errors
    ///
    /// Returns [`HostTransitionError::ShutdownCompleteFrom`] unless shutdown is in progress.
    pub fn complete_shutdown(&self) -> Result<(), HostTransitionError> {
        self.transition(HostPhase::ShuttingDown, HostPhase::ShutDown)
            .map_err(HostTransitionError::ShutdownCompleteFrom)
    }

    /// Checks request admission at the dispatch boundary.
    ///
    /// # Errors
    ///
    /// Returns [`RequestAdmissionClosed`] before readiness and after shutdown begins.
    pub fn admit_request(&self) -> Result<(), RequestAdmissionClosed> {
        let state = self.state();
        match state.request_admission() {
            RequestAdmission::Accepting => Ok(()),
            RequestAdmission::Closed => Err(RequestAdmissionClosed {
                phase: state.phase(),
            }),
        }
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<HostState> {
        self.changes.subscribe()
    }

    fn transition(&self, from: HostPhase, to: HostPhase) -> Result<(), HostPhase> {
        self.phase
            .compare_exchange(from as u8, to as u8, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| {
                self.changes.send_replace(HostState::from_phase(to));
            })
            .map_err(decode_phase)
    }
}

impl ::cron::CronRequestAdmission for HostAdmission {
    fn admit_cron_request(&self) -> Result<(), ::cron::CronRequestAdmissionClosed> {
        self.admit_request()
            .map_err(|_| ::cron::CronRequestAdmissionClosed)
    }
}

impl usage::UsageRequestAdmission for HostAdmission {
    fn admit_usage_request(&self) -> Result<(), usage::UsageRequestAdmissionClosed> {
        self.admit_request()
            .map_err(|_| usage::UsageRequestAdmissionClosed)
    }
}

impl ::diagnostics::DiagnosticsRequestAdmission for HostAdmission {
    fn admit_diagnostics_request(
        &self,
    ) -> Result<(), ::diagnostics::DiagnosticsRequestAdmissionClosed> {
        self.admit_request()
            .map_err(|_| ::diagnostics::DiagnosticsRequestAdmissionClosed)
    }
}

impl task_manager::TaskRequestAdmission for HostAdmission {
    fn admit_task_request(&self) -> Result<(), task_manager::TaskRequestAdmissionClosed> {
        self.admit_request()
            .map_err(|_| task_manager::TaskRequestAdmissionClosed)
    }
}

impl subagents::SubagentRequestAdmission for HostAdmission {
    fn admit_subagent_request(&self) -> Result<(), subagents::SubagentRequestAdmissionClosed> {
        self.admit_request()
            .map_err(|_| subagents::SubagentRequestAdmissionClosed)
    }
}

impl workspace::WorkspaceRequestAdmission for HostAdmission {
    fn admit_workspace_request(&self) -> Result<(), workspace::WorkspaceRequestAdmissionClosed> {
        self.admit_request()
            .map_err(|_| workspace::WorkspaceRequestAdmissionClosed)
    }
}

impl toolchain::ToolchainRequestAdmission for HostAdmission {
    fn admit_toolchain_request(&self) -> Result<(), toolchain::ToolchainRequestAdmissionClosed> {
        self.admit_request()
            .map_err(|_| toolchain::ToolchainRequestAdmissionClosed)
    }
}

impl platform_tools::PlatformToolsRequestAdmission for HostAdmission {
    fn admit_platform_tools_request(
        &self,
    ) -> Result<(), platform_tools::PlatformToolsRequestAdmissionClosed> {
        self.admit_request()
            .map_err(|_| platform_tools::PlatformToolsRequestAdmissionClosed)
    }
}

impl openclaw::platform_runtime::loopback::OpenClawPlatformAdmissionPort for HostAdmission {
    fn admit_openclaw_platform_request(&self) -> bool {
        self.admit_request().is_ok()
    }
}

impl openclaw::plugins::OpenClawPluginsAdmissionPort for HostAdmission {
    fn admit_openclaw_plugins_request(&self) -> bool {
        self.admit_request().is_ok()
    }
}

impl openclaw::skill::OpenClawSkillsAdmissionPort for HostAdmission {
    fn admit_openclaw_skills_request(&self) -> bool {
        self.admit_request().is_ok()
    }
}

impl Default for HostAdmission {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for HostAdmission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostAdmission")
            .field("state", &self.state())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostTransitionError {
    StartFrom(HostPhase),
    ReadyFrom(HostPhase),
    ShutdownFrom(HostPhase),
    ShutdownCompleteFrom(HostPhase),
}

impl fmt::Display for HostTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StartFrom(phase) => write!(formatter, "host cannot start from {phase}"),
            Self::ReadyFrom(phase) => write!(formatter, "host cannot become ready from {phase}"),
            Self::ShutdownFrom(phase) => {
                write!(formatter, "host cannot begin shutdown from {phase}")
            }
            Self::ShutdownCompleteFrom(phase) => {
                write!(formatter, "host cannot complete shutdown from {phase}")
            }
        }
    }
}

impl std::error::Error for HostTransitionError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RequestAdmissionClosed {
    phase: HostPhase,
}

impl RequestAdmissionClosed {
    pub(crate) const fn new(phase: HostPhase) -> Self {
        Self { phase }
    }

    pub const fn phase(self) -> HostPhase {
        self.phase
    }
}

impl fmt::Display for RequestAdmissionClosed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("host request admission is closed")
    }
}

impl std::error::Error for RequestAdmissionClosed {}

fn decode_phase(encoded: u8) -> HostPhase {
    match encoded {
        value if value == HostPhase::Created as u8 => HostPhase::Created,
        value if value == HostPhase::Starting as u8 => HostPhase::Starting,
        value if value == HostPhase::Ready as u8 => HostPhase::Ready,
        value if value == HostPhase::ShuttingDown as u8 => HostPhase::ShuttingDown,
        value if value == HostPhase::ShutDown as u8 => HostPhase::ShutDown,
        _ => unreachable!("host phase is only written from HostPhase"),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Barrier},
        thread,
    };

    use super::*;

    #[test]
    fn explicit_sequence_opens_then_closes_request_admission() {
        let admission = HostAdmission::new();

        assert_eq!(
            admission.state(),
            HostState {
                phase: HostPhase::Created,
                request_admission: RequestAdmission::Closed,
            }
        );
        assert_eq!(
            admission.admit_request(),
            Err(RequestAdmissionClosed {
                phase: HostPhase::Created,
            })
        );

        admission.begin_start().unwrap();
        assert_eq!(admission.state().phase(), HostPhase::Starting);
        assert_eq!(
            admission.state().request_admission(),
            RequestAdmission::Closed
        );

        admission.publish_ready().unwrap();
        assert_eq!(admission.state().phase(), HostPhase::Ready);
        assert_eq!(admission.admit_request(), Ok(()));

        admission.begin_shutdown().unwrap();
        assert_eq!(admission.state().phase(), HostPhase::ShuttingDown);
        assert_eq!(
            admission.admit_request(),
            Err(RequestAdmissionClosed {
                phase: HostPhase::ShuttingDown,
            })
        );

        admission.complete_shutdown().unwrap();
        assert_eq!(admission.state().phase(), HostPhase::ShutDown);
        assert_eq!(
            admission.state().request_admission(),
            RequestAdmission::Closed
        );
    }

    #[test]
    fn illegal_transitions_are_typed_and_leave_state_unchanged() {
        let admission = HostAdmission::new();

        assert_eq!(
            admission.publish_ready(),
            Err(HostTransitionError::ReadyFrom(HostPhase::Created))
        );
        assert_eq!(
            admission.complete_shutdown(),
            Err(HostTransitionError::ShutdownCompleteFrom(
                HostPhase::Created
            ))
        );
        assert_eq!(admission.state().phase(), HostPhase::Created);

        admission.begin_start().unwrap();
        assert_eq!(
            admission.begin_start(),
            Err(HostTransitionError::StartFrom(HostPhase::Starting))
        );
        assert_eq!(admission.state().phase(), HostPhase::Starting);
    }

    #[test]
    fn created_host_can_be_explicitly_shut_down() {
        let admission = HostAdmission::new();

        admission.begin_shutdown().unwrap();

        assert_eq!(
            admission.state(),
            HostState {
                phase: HostPhase::ShuttingDown,
                request_admission: RequestAdmission::Closed,
            }
        );
        assert_eq!(
            admission.begin_shutdown(),
            Err(HostTransitionError::ShutdownFrom(HostPhase::ShuttingDown))
        );

        admission.complete_shutdown().unwrap();
        assert_eq!(
            admission.begin_shutdown(),
            Err(HostTransitionError::ShutdownFrom(HostPhase::ShutDown))
        );
    }

    #[test]
    fn shutdown_during_startup_closes_admission_without_publishing_ready() {
        let admission = HostAdmission::new();
        admission.begin_start().unwrap();

        admission.begin_shutdown().unwrap();

        assert_eq!(
            admission.publish_ready(),
            Err(HostTransitionError::ReadyFrom(HostPhase::ShuttingDown))
        );
        assert_eq!(
            admission.state(),
            HostState {
                phase: HostPhase::ShuttingDown,
                request_admission: RequestAdmission::Closed,
            }
        );
    }

    #[test]
    fn only_one_concurrent_shutdown_request_owns_the_transition() {
        const CONTENDERS: usize = 8;

        let admission = Arc::new(HostAdmission::new());
        admission.begin_start().unwrap();
        admission.publish_ready().unwrap();
        let barrier = Arc::new(Barrier::new(CONTENDERS));
        let threads = (0..CONTENDERS)
            .map(|_| {
                let admission = Arc::clone(&admission);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    admission.begin_shutdown()
                })
            })
            .collect::<Vec<_>>();

        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(
            results
                .iter()
                .filter(|result| result.is_err())
                .all(|result| {
                    *result == Err(HostTransitionError::ShutdownFrom(HostPhase::ShuttingDown))
                })
        );
        assert_eq!(
            admission.state(),
            HostState {
                phase: HostPhase::ShuttingDown,
                request_admission: RequestAdmission::Closed,
            }
        );
    }

    #[test]
    fn concurrent_readiness_and_shutdown_never_reopen_admission() {
        let admission = Arc::new(HostAdmission::new());
        admission.begin_start().unwrap();
        let barrier = Arc::new(Barrier::new(2));

        let ready_admission = Arc::clone(&admission);
        let ready_barrier = Arc::clone(&barrier);
        let ready = thread::spawn(move || {
            ready_barrier.wait();
            ready_admission.publish_ready()
        });

        barrier.wait();
        let shutdown = admission.begin_shutdown();
        let ready = ready.join().unwrap();

        assert!(shutdown.is_ok());
        assert!(
            ready.is_ok() || ready == Err(HostTransitionError::ReadyFrom(HostPhase::ShuttingDown))
        );
        assert_eq!(admission.state().phase(), HostPhase::ShuttingDown);
        assert_eq!(
            admission.admit_request(),
            Err(RequestAdmissionClosed {
                phase: HostPhase::ShuttingDown,
            })
        );
    }

    #[test]
    fn late_subscribers_observe_the_current_phase_without_prior_receivers() {
        let admission = HostAdmission::new();

        admission.begin_start().unwrap();
        admission.publish_ready().unwrap();
        let late_ready = admission.subscribe();
        assert_eq!(late_ready.borrow().phase(), HostPhase::Ready);
        assert_eq!(
            late_ready.borrow().request_admission(),
            RequestAdmission::Accepting
        );

        admission.begin_shutdown().unwrap();
        let late_shutdown = admission.subscribe();
        assert_eq!(late_shutdown.borrow().phase(), HostPhase::ShuttingDown);
        assert_eq!(
            late_shutdown.borrow().request_admission(),
            RequestAdmission::Closed
        );
    }

    #[test]
    fn diagnostic_text_contains_only_fixed_host_state() {
        let admission = HostAdmission::new();
        admission.begin_start().unwrap();
        let error = admission
            .publish_ready()
            .and_then(|_| admission.begin_start());

        assert_eq!(
            format!("{admission:?}"),
            "HostAdmission { state: HostState { phase: Ready, request_admission: Accepting } }"
        );
        assert_eq!(
            error.unwrap_err().to_string(),
            "host cannot start from ready"
        );
        assert_eq!(
            RequestAdmissionClosed {
                phase: HostPhase::ShutDown,
            }
            .to_string(),
            "host request admission is closed"
        );
    }
}
