//! Native configuration/control facts, separate from OpenClaw SecurityOps.
mod hooks;
mod permissions;
mod sandbox;

pub use hooks::*;
pub use permissions::*;
pub use sandbox::*;

use platform::endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity};
use serde::{Deserialize, Serialize};

use crate::ports::SecurityFuture;

#[derive(Clone)]
pub struct PolicyTarget {
    pub endpoint: RuntimeEndpoint,
    pub agent_id: String,
    pub session_identity: Option<SessionIdentity>,
}

impl PolicyTarget {
    pub fn is_valid(&self) -> bool {
        !self.agent_id.is_empty()
            && !self.agent_id.chars().any(char::is_control)
            && self.session_identity.as_ref().is_none_or(|session| {
                session.endpoint() == &self.endpoint && session.agent_id() == self.agent_id
            })
    }

    pub(crate) fn receipt_key(&self, principal: &str, call_id: &platform::call::CallId) -> String {
        // Reuse the security receipt owner; bind reads to the complete original subject.
        serde_json::to_string(&(
            "nativePolicy",
            principal,
            &self.endpoint,
            &self.agent_id,
            &self.session_identity,
            call_id,
        ))
        .expect("typed policy identity")
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeObservation {
    NotRequested,
    NotRunning,
    Observed,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum Projection {
    #[serde(rename = "nextLaunchFlagSettings")]
    NextLaunchFlagSettings,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum ConfiguredSource {
    #[serde(rename = "serverAgentSettings")]
    ServerAgentSettings,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum SettingsSource {
    #[serde(rename = "userSettings")]
    UserSettings,
    #[serde(rename = "projectSettings")]
    ProjectSettings,
    #[serde(rename = "localSettings")]
    LocalSettings,
    #[serde(rename = "flagSettings")]
    FlagSettings,
    #[serde(rename = "policySettings")]
    PolicySettings,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot<T> {
    pub agent_id: String,
    pub configured: T,
    pub configured_source: ConfiguredSource,
    pub projection: Projection,
    pub authority: &'static str,
    pub native: Option<NativeSettings<T>>,
    pub native_observation: NativeObservation,
    pub platform: Option<SandboxPlatform>,
    pub isolation: Option<Isolation>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSettings<T> {
    pub status: &'static str,
    pub session_identity: SessionIdentity,
    pub instance_id: String,
    pub effective: T,
    pub sources: Vec<Source<T>>,
}

#[derive(Clone, Serialize)]
pub struct Source<T> {
    pub source: SettingsSource,
    pub settings: T,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SandboxPlatform {
    pub name: Platform,
    pub support: SandboxSupport,
    pub native_dependencies: NativeDependencies,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxSupport {
    UnsupportedWindows,
    UnsupportedWsl1,
    NativeDependencyCheckRequired,
    UnsupportedPlatform,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum NativeDependencies {
    #[serde(rename = "notProbedByServer")]
    NotProbedByServer,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum Isolation {
    #[serde(rename = "notObserved")]
    NotObserved,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveStatus {
    NotRequested,
    NotRunning,
    RestartRequired,
    Acknowledged,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum ControlStep {
    #[serde(rename = "apply_flag_settings")]
    ApplyFlagSettings,
    #[serde(rename = "set_permission_mode")]
    SetPermissionMode,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum OtherSessions {
    #[serde(rename = "notApplied")]
    NotApplied,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    pub agent_id: String,
    pub persisted: bool,
    pub projection: Projection,
    pub live: LiveApplication,
    pub restart_required: bool,
    pub restart_fields: Vec<String>,
    pub other_sessions: OtherSessions,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveApplication {
    pub status: LiveStatus,
    pub session_id: Option<String>,
    pub instance_id: Option<String>,
    pub steps: Vec<ControlStep>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureOutcome {
    Unsupported,
    Rejected,
    Unavailable,
    Unknown,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure {
    pub outcome: FailureOutcome,
    pub code: Option<i64>,
    pub kind: String,
    pub persisted: Option<bool>,
    pub projection: Option<Projection>,
    pub acknowledged_steps: Vec<ControlStep>,
    pub restart_required: Option<bool>,
    pub restart_fields: Vec<String>,
    pub other_sessions: Option<OtherSessions>,
}

impl Failure {
    pub fn unavailable() -> Self {
        Self::new(FailureOutcome::Unavailable, "native_policy_unavailable")
    }
    pub fn unknown() -> Self {
        Self::new(FailureOutcome::Unknown, "native_policy_unknown")
    }
    pub fn rejected() -> Self {
        Self::new(FailureOutcome::Rejected, "native_policy_target_rejected")
    }
    pub fn new(outcome: FailureOutcome, kind: &str) -> Self {
        Self {
            outcome,
            code: None,
            kind: kind.into(),
            persisted: None,
            projection: None,
            acknowledged_steps: Vec::new(),
            restart_required: None,
            restart_fields: Vec::new(),
            other_sessions: None,
        }
    }
}

pub trait NativePolicyOps: Send + Sync {
    fn permissions_get<'a>(
        &'a self,
        target: PolicyTarget,
    ) -> SecurityFuture<'a, Result<Snapshot<Permissions>, Failure>>;
    fn permissions_set<'a>(
        &'a self,
        target: PolicyTarget,
        patch: Permissions,
    ) -> SecurityFuture<'a, Result<Mutation, Failure>>;
    fn hooks_get<'a>(
        &'a self,
        target: PolicyTarget,
    ) -> SecurityFuture<'a, Result<Snapshot<HookCounts>, Failure>>;
    fn hooks_set<'a>(
        &'a self,
        target: PolicyTarget,
        patch: Hooks,
    ) -> SecurityFuture<'a, Result<Mutation, Failure>>;
    fn sandbox_status<'a>(
        &'a self,
        target: PolicyTarget,
    ) -> SecurityFuture<'a, Result<Snapshot<Sandbox>, Failure>>;
    fn sandbox_set<'a>(
        &'a self,
        target: PolicyTarget,
        patch: SandboxPatch,
    ) -> SecurityFuture<'a, Result<Mutation, Failure>>;
}

pub(crate) enum Operation {
    PermissionsGet,
    PermissionsSet(Permissions),
    HooksGet,
    HooksSet(Hooks),
    SandboxStatus,
    SandboxSet(SandboxPatch),
}

impl Operation {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::PermissionsGet => "nativePermissions.get",
            Self::PermissionsSet(_) => "nativePermissions.set",
            Self::HooksGet => "nativeHooks.get",
            Self::HooksSet(_) => "nativeHooks.set",
            Self::SandboxStatus => "nativeSandbox.status",
            Self::SandboxSet(_) => "nativeSandbox.set",
        }
    }
    pub(crate) fn is_mutation(&self) -> bool {
        matches!(
            self,
            Self::PermissionsSet(_) | Self::HooksSet(_) | Self::SandboxSet(_)
        )
    }
}

pub(crate) async fn execute(
    ops: &dyn NativePolicyOps,
    target: PolicyTarget,
    operation: Operation,
) -> serde_json::Value {
    use serde_json::json;
    fn snapshot<T: Serialize>(result: Result<Snapshot<T>, Failure>) -> serde_json::Value {
        match result {
            Ok(snapshot) => json!({"outcome":"available", "snapshot":snapshot}),
            Err(error) => json!(error),
        }
    }
    fn mutation(result: Result<Mutation, Failure>) -> serde_json::Value {
        match result {
            Ok(receipt) => json!({"outcome":"confirmed", "receipt":receipt}),
            Err(error) => json!(error),
        }
    }
    match operation {
        Operation::PermissionsGet => snapshot(ops.permissions_get(target).await),
        Operation::PermissionsSet(patch) => mutation(ops.permissions_set(target, patch).await),
        Operation::HooksGet => snapshot(ops.hooks_get(target).await),
        Operation::HooksSet(patch) => mutation(ops.hooks_set(target, patch).await),
        Operation::SandboxStatus => snapshot(ops.sandbox_status(target).await),
        Operation::SandboxSet(patch) => mutation(ops.sandbox_set(target, patch).await),
    }
}
