use std::{
    fmt,
    sync::{Arc, Mutex},
};

use foundation::process::supervision::{
    LaunchFailure, SupervisorFailure, SupervisorPhase, SupervisorSnapshot,
};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostLifecycle {
    Created,
    Starting,
    Ready,
    ShuttingDown,
    ShutDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeLifecycle {
    Unavailable,
    Idle,
    Starting,
    Running,
    Stopping,
    WaitingToRestart,
    Failed,
    ShutDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeFailure {
    ArtifactUnavailable,
    PermissionDenied,
    ResourceUnavailable,
    PlatformRejected,
    Stdio,
    Readiness,
    UnexpectedExit,
    AuthorityLost,
    CleanupUnconfirmed,
    MaterialCleanupFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeStartupDiagnostic {
    PortConflict,
    ConfigurationRejected,
    AppServerReportedError,
    UnclassifiedStderr,
    InvalidUtf8,
    LineTooLong,
    ListenerReported,
    BindRejected,
    StartupFailed,
    InvalidEncoding,
    DiagnosticLimitReached,
}

#[derive(Clone)]
pub struct RuntimeStartupDiagnostics {
    first: Arc<Mutex<Option<RuntimeStartupDiagnostic>>>,
}

impl RuntimeStartupDiagnostics {
    pub fn new() -> Self {
        Self {
            first: Arc::new(Mutex::new(None)),
        }
    }

    pub fn report(&self, diagnostic: RuntimeStartupDiagnostic) {
        let mut first = self
            .first
            .lock()
            .expect("runtime startup diagnostics lock poisoned");
        if first.is_none() {
            *first = Some(diagnostic);
        }
    }

    pub fn category(&self) -> Option<RuntimeStartupDiagnostic> {
        *self
            .first
            .lock()
            .expect("runtime startup diagnostics lock poisoned")
    }
}

impl Default for RuntimeStartupDiagnostics {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    lifecycle: RuntimeLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    startup_diagnostic: Option<RuntimeStartupDiagnostic>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStateProjection {
    lifecycle: RuntimeLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    startup_diagnostic: Option<RuntimeStartupDiagnostic>,
}

impl RuntimeState {
    pub fn projection(&self) -> RuntimeStateProjection {
        RuntimeStateProjection {
            lifecycle: self.lifecycle,
            failure: self.failure,
            startup_diagnostic: self.startup_diagnostic,
        }
    }

    pub fn from_snapshot(snapshot: &SupervisorSnapshot) -> Self {
        Self::from_snapshot_with_startup_diagnostic(snapshot, None)
    }

    pub fn from_snapshot_with_startup_diagnostic(
        snapshot: &SupervisorSnapshot,
        startup_diagnostic: Option<RuntimeStartupDiagnostic>,
    ) -> Self {
        Self {
            lifecycle: project_lifecycle(snapshot.phase()),
            pid: snapshot.process().map(|process| process.identity().pid()),
            failure: snapshot.failure().map(project_failure),
            startup_diagnostic,
        }
    }

    #[cfg(test)]
    pub const fn test_only(
        lifecycle: RuntimeLifecycle,
        pid: Option<u32>,
        failure: Option<RuntimeFailure>,
        startup_diagnostic: Option<RuntimeStartupDiagnostic>,
    ) -> Self {
        Self {
            lifecycle,
            pid,
            failure,
            startup_diagnostic,
        }
    }

    pub const fn lifecycle(&self) -> RuntimeLifecycle {
        self.lifecycle
    }

    pub const fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub const fn failure(&self) -> Option<RuntimeFailure> {
        self.failure
    }

    pub const fn startup_diagnostic(&self) -> Option<RuntimeStartupDiagnostic> {
        self.startup_diagnostic
    }
}

impl fmt::Debug for RuntimeState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeState")
            .field("lifecycle", &self.lifecycle)
            .field("pid", &self.pid)
            .field("failure", &self.failure)
            .field("startup_diagnostic", &self.startup_diagnostic)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostState {
    ok: bool,
    lifecycle: HostLifecycle,
    matcha: RuntimeState,
    open_claw: RuntimeState,
}

impl Serialize for HostState {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PublicHostState {
            ok: bool,
            lifecycle: HostLifecycle,
            matcha: RuntimeStateProjection,
            open_claw: RuntimeStateProjection,
        }

        PublicHostState {
            ok: self.ok,
            lifecycle: self.lifecycle,
            matcha: self.matcha.projection(),
            open_claw: self.open_claw.projection(),
        }
        .serialize(serializer)
    }
}

impl HostState {
    pub fn from_runtime_states(
        ok: bool,
        lifecycle: HostLifecycle,
        matcha: RuntimeState,
        open_claw: RuntimeState,
    ) -> Self {
        Self {
            ok,
            lifecycle,
            matcha,
            open_claw,
        }
    }

    #[cfg(test)]
    pub const fn test_only(
        ok: bool,
        lifecycle: HostLifecycle,
        matcha: RuntimeState,
        open_claw: RuntimeState,
    ) -> Self {
        Self {
            ok,
            lifecycle,
            matcha,
            open_claw,
        }
    }

    pub const fn ok(&self) -> bool {
        self.ok
    }

    pub const fn lifecycle(&self) -> HostLifecycle {
        self.lifecycle
    }

    pub const fn matcha(&self) -> &RuntimeState {
        &self.matcha
    }

    pub const fn open_claw(&self) -> &RuntimeState {
        &self.open_claw
    }
}

pub const fn project_lifecycle(phase: SupervisorPhase) -> RuntimeLifecycle {
    match phase {
        SupervisorPhase::Idle => RuntimeLifecycle::Idle,
        SupervisorPhase::Starting => RuntimeLifecycle::Starting,
        SupervisorPhase::Running => RuntimeLifecycle::Running,
        SupervisorPhase::Stopping => RuntimeLifecycle::Stopping,
        SupervisorPhase::WaitingToRestart => RuntimeLifecycle::WaitingToRestart,
        SupervisorPhase::OperationFailed => RuntimeLifecycle::Failed,
        SupervisorPhase::ShutDown => RuntimeLifecycle::ShutDown,
    }
}

pub const fn project_failure(failure: &SupervisorFailure) -> RuntimeFailure {
    match failure {
        SupervisorFailure::LaunchFailed(launch) => match launch {
            LaunchFailure::ArtifactUnavailable => RuntimeFailure::ArtifactUnavailable,
            LaunchFailure::PermissionDenied => RuntimeFailure::PermissionDenied,
            LaunchFailure::ResourceUnavailable => RuntimeFailure::ResourceUnavailable,
            LaunchFailure::PlatformRejected => RuntimeFailure::PlatformRejected,
        },
        SupervisorFailure::StdioFailed => RuntimeFailure::Stdio,
        SupervisorFailure::ReadinessFailed => RuntimeFailure::Readiness,
        SupervisorFailure::Exited(_) => RuntimeFailure::UnexpectedExit,
        SupervisorFailure::Termination(failure) => match failure {
            foundation::process::TerminationFailure::AuthorityLost => RuntimeFailure::AuthorityLost,
            foundation::process::TerminationFailure::CleanupUnconfirmed => {
                RuntimeFailure::CleanupUnconfirmed
            }
            foundation::process::TerminationFailure::MaterialCleanupFailed => {
                RuntimeFailure::MaterialCleanupFailed
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_diagnostics_retains_only_the_first_category() {
        let diagnostics = RuntimeStartupDiagnostics::new();
        diagnostics.report(RuntimeStartupDiagnostic::AppServerReportedError);
        diagnostics.report(RuntimeStartupDiagnostic::PortConflict);

        assert_eq!(
            diagnostics.category(),
            Some(RuntimeStartupDiagnostic::AppServerReportedError)
        );
    }
}
