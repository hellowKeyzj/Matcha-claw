use std::{
    fmt,
    sync::{Arc, Mutex},
};

use foundation::process::supervision::{
    LaunchFailure, SupervisorFailure, SupervisorPhase, SupervisorSnapshot,
};
use matcha_agent::lifecycle::output::StartupDiagnosticCategory;
use openclaw::lifecycle::logs::LifecycleDiagnosticCategory;
use serde::Serialize;

use crate::composition::HostPhase;

#[allow(dead_code)]
mod archive;
pub(crate) mod event_output;
#[allow(dead_code)]
mod flight_recorder;

pub(crate) use archive::{
    DiagnosticsArchiveCancellation, DiagnosticsArchiveError, DiagnosticsArchiveProducer,
    DiagnosticsArchiveReceipt, DiagnosticsArchiveRoot, DiagnosticsArchiveTerminal,
};
pub(crate) use flight_recorder::{RuntimeFlightRecorder, RuntimeObservationSnapshot};
pub use flight_recorder::{RuntimeObservationConfig, RuntimeObservationMode};

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

#[derive(Clone)]
pub(crate) struct MatchaStartupDiagnostics {
    first: Arc<Mutex<Option<StartupDiagnosticCategory>>>,
}

impl MatchaStartupDiagnostics {
    pub(crate) fn new() -> Self {
        Self {
            first: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn report(&self, category: StartupDiagnosticCategory) {
        let mut first = self
            .first
            .lock()
            .expect("matcha startup diagnostics lock poisoned");
        if first.is_none() {
            *first = Some(category);
        }
    }

    pub(crate) fn category(&self) -> Option<StartupDiagnosticCategory> {
        *self
            .first
            .lock()
            .expect("matcha startup diagnostics lock poisoned")
    }
}

#[derive(Clone)]
pub(crate) struct OpenClawStartupDiagnostics {
    first: Arc<Mutex<Option<LifecycleDiagnosticCategory>>>,
}

impl OpenClawStartupDiagnostics {
    pub(crate) fn new() -> Self {
        Self {
            first: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn report(&self, category: LifecycleDiagnosticCategory) {
        let mut first = self
            .first
            .lock()
            .expect("OpenClaw startup diagnostics lock poisoned");
        if first.is_none() {
            *first = Some(category);
        }
    }

    pub(crate) fn category(&self) -> Option<LifecycleDiagnosticCategory> {
        *self
            .first
            .lock()
            .expect("OpenClaw startup diagnostics lock poisoned")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RuntimeStartupDiagnostic {
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

impl From<StartupDiagnosticCategory> for RuntimeStartupDiagnostic {
    fn from(value: StartupDiagnosticCategory) -> Self {
        match value {
            StartupDiagnosticCategory::PortConflict => Self::PortConflict,
            StartupDiagnosticCategory::ConfigurationRejected => Self::ConfigurationRejected,
            StartupDiagnosticCategory::AppServerReportedError => Self::AppServerReportedError,
            StartupDiagnosticCategory::UnclassifiedStderr => Self::UnclassifiedStderr,
            StartupDiagnosticCategory::InvalidUtf8 => Self::InvalidUtf8,
            StartupDiagnosticCategory::LineTooLong => Self::LineTooLong,
        }
    }
}

impl From<LifecycleDiagnosticCategory> for RuntimeStartupDiagnostic {
    fn from(value: LifecycleDiagnosticCategory) -> Self {
        match value {
            LifecycleDiagnosticCategory::ListenerReported => Self::ListenerReported,
            LifecycleDiagnosticCategory::PortConflict => Self::PortConflict,
            LifecycleDiagnosticCategory::ConfigurationRejected => Self::ConfigurationRejected,
            LifecycleDiagnosticCategory::BindRejected => Self::BindRejected,
            LifecycleDiagnosticCategory::StartupFailed => Self::StartupFailed,
            LifecycleDiagnosticCategory::InvalidEncoding => Self::InvalidEncoding,
            LifecycleDiagnosticCategory::LineTooLong => Self::LineTooLong,
            LifecycleDiagnosticCategory::DiagnosticLimitReached => Self::DiagnosticLimitReached,
        }
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
pub(crate) struct RuntimeStateProjection {
    pub(crate) lifecycle: RuntimeLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) failure: Option<RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) startup_diagnostic: Option<RuntimeStartupDiagnostic>,
}

impl RuntimeState {
    pub(crate) fn projection(&self) -> RuntimeStateProjection {
        RuntimeStateProjection {
            lifecycle: self.lifecycle,
            failure: self.failure,
            startup_diagnostic: self.startup_diagnostic,
        }
    }

    pub(crate) fn from_snapshot(snapshot: &SupervisorSnapshot) -> Self {
        Self::from_snapshot_with_startup_diagnostic(snapshot, None)
    }

    pub(crate) fn from_snapshot_with_startup_diagnostic(
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
    pub(crate) const fn test_only(
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

    pub(crate) const fn startup_diagnostic(&self) -> Option<RuntimeStartupDiagnostic> {
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
    pub(crate) fn from_supervisors(
        phase: HostPhase,
        matcha: &SupervisorSnapshot,
        matcha_startup_diagnostic: Option<StartupDiagnosticCategory>,
        open_claw: &SupervisorSnapshot,
        openclaw_startup_diagnostic: Option<LifecycleDiagnosticCategory>,
    ) -> Self {
        Self {
            ok: phase == HostPhase::Ready,
            lifecycle: project_host_lifecycle(phase),
            matcha: RuntimeState::from_snapshot_with_startup_diagnostic(
                matcha,
                matcha_startup_diagnostic.map(Into::into),
            ),
            open_claw: RuntimeState::from_snapshot_with_startup_diagnostic(
                open_claw,
                openclaw_startup_diagnostic.map(Into::into),
            ),
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

const fn project_host_lifecycle(phase: HostPhase) -> HostLifecycle {
    match phase {
        HostPhase::Created => HostLifecycle::Created,
        HostPhase::Starting => HostLifecycle::Starting,
        HostPhase::Ready => HostLifecycle::Ready,
        HostPhase::ShuttingDown => HostLifecycle::ShuttingDown,
        HostPhase::ShutDown => HostLifecycle::ShutDown,
    }
}

const fn project_lifecycle(phase: SupervisorPhase) -> RuntimeLifecycle {
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

const fn project_failure(failure: &SupervisorFailure) -> RuntimeFailure {
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
    use std::{path::PathBuf, time::Duration};

    use foundation::process::{
        FixedLaunch, LaunchSpec, ProcessContainment, ProcessObservation, ProcessStdio,
        StdioActivationResult, StdioMode, StdioSpec, supervise,
        supervision::{
            GracefulStop, GracefulStopResult, PolicyFuture, ReadinessProbe, ReadinessResult,
            RestartDecision, RestartEpisode, RestartPolicy, StartRecovery, StartRecoveryResult,
            StdioActivation,
        },
    };
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[test]
    fn failure_projection_is_bounded_and_structural() {
        let cases = [
            (
                SupervisorFailure::LaunchFailed(LaunchFailure::ArtifactUnavailable),
                RuntimeFailure::ArtifactUnavailable,
            ),
            (SupervisorFailure::StdioFailed, RuntimeFailure::Stdio),
            (
                SupervisorFailure::ReadinessFailed,
                RuntimeFailure::Readiness,
            ),
            (
                SupervisorFailure::Termination(
                    foundation::process::TerminationFailure::AuthorityLost,
                ),
                RuntimeFailure::AuthorityLost,
            ),
        ];

        for (failure, expected) in cases {
            assert_eq!(project_failure(&failure), expected);
        }
    }

    #[test]
    fn material_cleanup_failure_projection_is_precise_and_camel_case_stable() {
        let failure = SupervisorFailure::Termination(
            foundation::process::TerminationFailure::MaterialCleanupFailed,
        );
        let projected = project_failure(&failure);

        assert_eq!(projected, RuntimeFailure::MaterialCleanupFailed);
        assert_eq!(
            serde_json::to_string(&projected).unwrap(),
            r#""materialCleanupFailed""#
        );
    }

    #[test]
    fn host_lifecycle_projection_covers_every_admission_phase() {
        let cases = [
            (HostPhase::Created, HostLifecycle::Created),
            (HostPhase::Starting, HostLifecycle::Starting),
            (HostPhase::Ready, HostLifecycle::Ready),
            (HostPhase::ShuttingDown, HostLifecycle::ShuttingDown),
            (HostPhase::ShutDown, HostLifecycle::ShutDown),
        ];

        for (phase, expected) in cases {
            assert_eq!(project_host_lifecycle(phase), expected);
        }
    }

    #[test]
    fn lifecycle_projection_covers_every_supervisor_phase() {
        let cases = [
            (SupervisorPhase::Idle, RuntimeLifecycle::Idle),
            (SupervisorPhase::Starting, RuntimeLifecycle::Starting),
            (SupervisorPhase::Running, RuntimeLifecycle::Running),
            (SupervisorPhase::Stopping, RuntimeLifecycle::Stopping),
            (
                SupervisorPhase::WaitingToRestart,
                RuntimeLifecycle::WaitingToRestart,
            ),
            (SupervisorPhase::OperationFailed, RuntimeLifecycle::Failed),
            (SupervisorPhase::ShutDown, RuntimeLifecycle::ShutDown),
        ];

        for (phase, expected) in cases {
            assert_eq!(project_lifecycle(phase), expected);
        }
    }

    #[test]
    fn runtime_state_accessors_expose_only_safe_projection() {
        let state = RuntimeState {
            lifecycle: RuntimeLifecycle::Running,
            pid: Some(42),
            failure: None,
            startup_diagnostic: None,
        };

        assert_eq!(state.lifecycle(), RuntimeLifecycle::Running);
        assert_eq!(state.pid(), Some(42));
        assert_eq!(state.failure(), None);
        assert_eq!(state.startup_diagnostic(), None);
    }

    #[test]
    fn matcha_startup_diagnostics_retains_only_the_first_category() {
        let diagnostics = MatchaStartupDiagnostics::new();
        diagnostics.report(StartupDiagnosticCategory::AppServerReportedError);
        diagnostics.report(StartupDiagnosticCategory::PortConflict);

        assert_eq!(
            diagnostics.category(),
            Some(StartupDiagnosticCategory::AppServerReportedError)
        );
    }

    #[test]
    fn openclaw_startup_diagnostics_retains_only_the_first_category() {
        let diagnostics = OpenClawStartupDiagnostics::new();
        diagnostics.report(LifecycleDiagnosticCategory::ConfigurationRejected);
        diagnostics.report(LifecycleDiagnosticCategory::PortConflict);

        assert_eq!(
            diagnostics.category(),
            Some(LifecycleDiagnosticCategory::ConfigurationRejected)
        );
    }

    #[test]
    fn runtime_state_debug_contains_only_projected_values() {
        let state = RuntimeState {
            lifecycle: RuntimeLifecycle::Failed,
            pid: Some(42),
            failure: Some(RuntimeFailure::UnexpectedExit),
            startup_diagnostic: Some(StartupDiagnosticCategory::AppServerReportedError.into()),
        };

        assert_eq!(
            format!("{state:?}"),
            "RuntimeState { lifecycle: Failed, pid: Some(42), failure: Some(UnexpectedExit), startup_diagnostic: Some(AppServerReportedError) }"
        );
    }

    #[test]
    fn runtime_state_serializes_only_the_startup_diagnostic_category() {
        let state = RuntimeState {
            lifecycle: RuntimeLifecycle::Failed,
            pid: None,
            failure: Some(RuntimeFailure::UnexpectedExit),
            startup_diagnostic: Some(StartupDiagnosticCategory::AppServerReportedError.into()),
        };

        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"lifecycle":"failed","failure":"unexpectedExit","startupDiagnostic":"appServerReportedError"}"#
        );
    }

    #[test]
    fn openclaw_state_serializes_only_a_bounded_diagnostic_category() {
        let state = RuntimeState {
            lifecycle: RuntimeLifecycle::Failed,
            pid: None,
            failure: Some(RuntimeFailure::UnexpectedExit),
            startup_diagnostic: Some(LifecycleDiagnosticCategory::ConfigurationRejected.into()),
        };

        let serialized = serde_json::to_string(&state).unwrap();
        assert_eq!(
            serialized,
            r#"{"lifecycle":"failed","failure":"unexpectedExit","startupDiagnostic":"configurationRejected"}"#
        );
        for private in [
            "credential-canary-must-not-escape",
            r"C:\Users\operator\.openclaw\openclaw.json",
            "config-value-canary-must-not-escape",
            "transcript-canary-must-not-escape",
            "raw-output-canary-must-not-escape",
        ] {
            assert!(!serialized.contains(private));
        }
    }

    #[tokio::test]
    async fn ready_host_is_ok_while_peer_supervisors_are_idle() {
        let matcha = idle_supervisor();
        let open_claw = idle_supervisor();
        let state = HostState::from_supervisors(
            HostPhase::Ready,
            &matcha.handle().snapshot(),
            None,
            &open_claw.handle().snapshot(),
            None,
        );

        assert!(state.ok());
        assert_eq!(state.lifecycle(), HostLifecycle::Ready);
        assert_eq!(state.matcha().lifecycle(), RuntimeLifecycle::Idle);
        assert_eq!(state.open_claw().lifecycle(), RuntimeLifecycle::Idle);
    }

    #[tokio::test]
    async fn host_state_serializes_only_the_safe_diagnostic_shape() {
        let matcha = idle_supervisor();
        let open_claw = idle_supervisor();
        let state = HostState::from_supervisors(
            HostPhase::Ready,
            &matcha.handle().snapshot(),
            Some(StartupDiagnosticCategory::AppServerReportedError),
            &open_claw.handle().snapshot(),
            Some(LifecycleDiagnosticCategory::ConfigurationRejected),
        );

        assert_eq!(
            serde_json::to_value(state).unwrap(),
            json!({
                "ok": true,
                "lifecycle": "ready",
                "matcha": {
                    "lifecycle": "idle",
                    "startupDiagnostic": "appServerReportedError",
                },
                "openClaw": {
                    "lifecycle": "idle",
                    "startupDiagnostic": "configurationRejected",
                },
            })
        );
    }

    fn idle_supervisor() -> foundation::process::supervision::Supervisor {
        let launch = LaunchSpec::try_new(
            absolute_path("runtime-host-diagnostics-peer"),
            absolute_path("runtime-host-diagnostics"),
            [],
            [],
            StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
        )
        .unwrap();

        #[cfg(windows)]
        let containment = ProcessContainment::job();
        #[cfg(unix)]
        let containment =
            ProcessContainment::guardian(absolute_path("runtime-host-guardian")).unwrap();
        supervise(
            containment,
            FixedLaunch::new(launch),
            IdlePolicy,
            IdlePolicy,
            IdlePolicy,
            IdlePolicy,
            IdlePolicy,
        )
    }

    #[derive(Clone, Copy)]
    struct IdlePolicy;

    impl StdioActivation for IdlePolicy {
        fn activate(
            &self,
            _: ProcessObservation,
            _: ProcessStdio,
            _: CancellationToken,
        ) -> PolicyFuture<StdioActivationResult> {
            Box::pin(async { StdioActivationResult::Unavailable })
        }
    }

    impl ReadinessProbe for IdlePolicy {
        fn wait_ready(
            &self,
            _: ProcessObservation,
            _: CancellationToken,
        ) -> PolicyFuture<ReadinessResult> {
            Box::pin(async { ReadinessResult::Unavailable })
        }
    }

    impl GracefulStop for IdlePolicy {
        fn grace_period(&self) -> Duration {
            Duration::ZERO
        }

        fn request_stop(
            &self,
            _: ProcessObservation,
            _: CancellationToken,
        ) -> PolicyFuture<GracefulStopResult> {
            Box::pin(async { GracefulStopResult::Rejected })
        }
    }

    impl StartRecovery for IdlePolicy {
        fn recover(
            &self,
            _: SupervisorFailure,
            _: CancellationToken,
        ) -> PolicyFuture<StartRecoveryResult> {
            Box::pin(async { StartRecoveryResult::Fail })
        }
    }

    impl RestartPolicy for IdlePolicy {
        fn decide(&self, _: &SupervisorFailure, _: RestartEpisode) -> RestartDecision {
            RestartDecision::Halt
        }
    }

    fn absolute_path(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
        } else {
            PathBuf::from(format!("/MatchaClaw/{name}"))
        }
    }
}
