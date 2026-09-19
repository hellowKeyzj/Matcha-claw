use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;

pub(crate) const CONTROL_VERSION: u8 = 1;
pub(crate) const MAX_REQUEST_ID_BYTES: usize = 128;
#[cfg(test)]
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
const MAX_CRON_EXECUTION_ID_BYTES: usize = 128;
/// Bounds an untrusted parent's command wait and keeps a stuck child command recoverable.
pub(crate) const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WireError {
    MalformedJson,
    InvalidCommand,
    #[cfg(test)]
    InvalidOutput,
    Encode,
}

fn deserialize_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    match u8::deserialize(deserializer) {
        Ok(CONTROL_VERSION) => Ok(CONTROL_VERSION),
        _ => Err(D::Error::custom("unsupported control version")),
    }
}

#[cfg(test)]
fn deserialize_sequence<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let sequence = Option::<u64>::deserialize(deserializer)?;
    match sequence {
        Some(sequence) if sequence > MAX_SAFE_SEQUENCE => Err(D::Error::custom(
            "control event sequence exceeds the safe integer range",
        )),
        sequence => Ok(sequence),
    }
}

#[cfg(test)]
fn deserialize_safe_millis<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    (value <= MAX_SAFE_SEQUENCE)
        .then_some(value)
        .ok_or_else(|| D::Error::custom("control event timestamp exceeds the safe integer range"))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct RequestId(String);

impl RequestId {
    fn valid(value: &str) -> bool {
        !value.is_empty() && value.len() <= MAX_REQUEST_ID_BYTES
    }

    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for RequestId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::valid(&value)
            .then_some(Self(value))
            .ok_or_else(|| D::Error::custom("invalid control command id"))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct Timeout(u64);

impl Timeout {
    pub(crate) fn milliseconds(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for Timeout {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        (1..=MAX_TIMEOUT_MS)
            .contains(&value)
            .then_some(Self(value))
            .ok_or_else(|| D::Error::custom("invalid control command timeout"))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct CommandInput(pub(crate) Value);

impl CommandInput {
    pub(crate) fn into_value(self) -> Value {
        self.0
    }
}

impl<'de> Deserialize<'de> for CommandInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        value
            .is_object()
            .then_some(Self(value))
            .ok_or_else(|| D::Error::custom("control command input must be an object"))
    }
}

/// The complete private command vocabulary. HTTP methods, routes, and generic payloads do not
/// cross this boundary.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "name", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Command {
    #[serde(rename = "host.health")]
    HostHealth {},
    #[serde(rename = "host.capabilities.list")]
    HostCapabilitiesList {},
    #[serde(rename = "host.capabilities.describe")]
    HostCapabilitiesDescribe { input: CommandInput },
    #[serde(rename = "host.runtime.snapshot")]
    HostRuntimeSnapshot {},
    #[serde(rename = "matcha.lifecycle.status")]
    MatchaStatus {},
    #[serde(rename = "matcha.lifecycle.start")]
    MatchaStart {},
    #[serde(rename = "matcha.lifecycle.stop")]
    MatchaStop {},
    #[serde(rename = "matcha.lifecycle.restart")]
    MatchaRestart {},
    #[serde(rename = "openclaw.lifecycle.status")]
    OpenClawStatus {},
    #[serde(rename = "openclaw.plugins.catalog")]
    OpenClawPluginsCatalog {},
    #[serde(rename = "openclaw.plugins.runtime")]
    OpenClawPluginsRuntime {},
    #[serde(rename = "openclaw.plugins.set-enabled")]
    OpenClawPluginsSetEnabled { input: CommandInput },
    #[serde(rename = "openclaw.plugins.operation")]
    OpenClawPluginsOperation { input: CommandInput },
    #[serde(rename = "openclaw.skills.execute")]
    OpenClawSkillsExecute { input: CommandInput },
    #[serde(rename = "team.runtime.execute")]
    TeamRuntimeExecute { input: CommandInput },
    #[serde(rename = "openclaw.plugins.execute")]
    OpenClawPluginsExecute { input: CommandInput },
    #[serde(rename = "openclaw.environment.status")]
    OpenClawEnvironmentStatus {},
    #[serde(rename = "openclaw.runtime.paths")]
    OpenClawRuntimePaths {},
    #[serde(rename = "openclaw.cli.command")]
    OpenClawCliCommand {},
    #[serde(rename = "openclaw.tool-permission.get")]
    OpenClawToolPermissionGet {},
    #[serde(rename = "openclaw.tool-permission.set")]
    OpenClawToolPermissionSet { input: CommandInput },
    #[serde(rename = "host.toolchain.status")]
    HostToolchainStatus {},
    #[serde(rename = "host.toolchain.prepare")]
    HostToolchainPrepare {},
    #[serde(rename = "openclaw.subagent-templates.list")]
    OpenClawSubagentTemplateCatalog {},
    #[serde(rename = "openclaw.subagent-templates.get")]
    OpenClawSubagentTemplate { input: CommandInput },
    #[serde(rename = "openclaw.lifecycle.start")]
    OpenClawStart {},
    #[serde(rename = "openclaw.lifecycle.stop")]
    OpenClawStop {},
    #[serde(rename = "openclaw.lifecycle.restart")]
    OpenClawRestart {},
    #[serde(rename = "openclaw.logs")]
    OpenClawLogs { input: CommandInput },
    #[serde(rename = "openclaw.control.ready")]
    OpenClawControlReady {},
    #[serde(rename = "openclaw.gateway.health")]
    OpenClawGatewayHealth {},
    #[serde(rename = "openclaw.gateway.status")]
    OpenClawGatewayStatus {},
    #[serde(rename = "openclaw.control-ui.url")]
    OpenClawControlUiUrl {},
    #[serde(rename = "openclaw.browser.request")]
    OpenClawBrowserRequest { input: CommandInput },
    #[serde(rename = "openclaw.mcp-app.request")]
    OpenClawMcpAppRequest { input: CommandInput },
    #[serde(rename = "fleet.credentials.write")]
    FleetCredentialsWrite { input: CommandInput },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CommandType {
    Command,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CommandRequest {
    #[serde(deserialize_with = "deserialize_version")]
    version: u8,
    #[serde(rename = "type")]
    kind: CommandType,
    pub(crate) id: RequestId,
    #[serde(rename = "timeoutMs")]
    pub(crate) timeout: Timeout,
    pub(crate) command: Command,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "lowercase")]
enum ReadyType {
    Ready,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(deny_unknown_fields)]
pub(crate) struct Ready {
    #[serde(deserialize_with = "deserialize_version")]
    version: u8,
    #[serde(rename = "type")]
    kind: ReadyType,
}

impl Ready {
    pub(crate) const fn new() -> Self {
        Self {
            version: CONTROL_VERSION,
            kind: ReadyType::Ready,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum RejectionCode {
    InvalidInput,
    CapacityExhausted,
    Unavailable,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(deny_unknown_fields)]
pub(crate) struct CommandRejection {
    code: RejectionCode,
    message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum CommandOutcome {
    Succeeded { result: CommandResult },
    Unknown { result: CommandResult },
    Rejected { error: CommandRejection },
    TimedOut,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum CommandResult {
    Public(PublicControlJson),
    Private(PrivateControlJson),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(transparent)]
pub(crate) struct PublicControlJson(Value);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(transparent)]
pub(crate) struct PrivateControlJson(Value);

impl CommandOutcome {
    pub(crate) fn succeeded(result: CommandResult) -> Self {
        Self::Succeeded { result }
    }

    pub(crate) fn unknown(result: CommandResult) -> Self {
        Self::Unknown { result }
    }

    pub(crate) fn rejected(code: RejectionCode, message: &'static str) -> Self {
        Self::Rejected {
            error: CommandRejection {
                code,
                message: message.to_owned(),
            },
        }
    }

    pub(crate) const fn timed_out() -> Self {
        Self::TimedOut
    }
}

impl CommandResult {
    pub(crate) fn public(value: impl Into<Value>) -> Self {
        Self::Public(PublicControlJson::new(value))
    }

    pub(crate) fn private(value: impl Into<Value>) -> Self {
        Self::Private(PrivateControlJson::new(value))
    }

    pub(crate) fn as_value(&self) -> &Value {
        match self {
            Self::Public(value) => value.as_value(),
            Self::Private(value) => value.as_value(),
        }
    }

    pub(crate) fn into_value(self) -> Value {
        match self {
            Self::Public(value) => value.into_value(),
            Self::Private(value) => value.into_value(),
        }
    }
}

#[cfg(test)]
impl<'de> Deserialize<'de> for CommandResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Self::private(Value::deserialize(deserializer)?))
    }
}

impl PublicControlJson {
    pub(crate) fn new(value: impl Into<Value>) -> Self {
        Self(value.into())
    }

    fn as_value(&self) -> &Value {
        &self.0
    }

    fn into_value(self) -> Value {
        self.0
    }
}

impl PrivateControlJson {
    pub(crate) fn new(value: impl Into<Value>) -> Self {
        Self(value.into())
    }

    fn as_value(&self) -> &Value {
        &self.0
    }

    fn into_value(self) -> Value {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
enum OutcomeType {
    #[serde(rename = "outcome")]
    Outcome,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(deny_unknown_fields)]
pub(crate) struct Outcome {
    #[serde(deserialize_with = "deserialize_version")]
    version: u8,
    #[serde(rename = "type")]
    kind: OutcomeType,
    id: RequestId,
    outcome: CommandOutcome,
}

impl Outcome {
    pub(crate) fn new(id: RequestId, outcome: CommandOutcome) -> Self {
        Self {
            version: CONTROL_VERSION,
            kind: OutcomeType::Outcome,
            id,
            outcome,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
enum EventType {
    #[serde(rename = "event")]
    Event,
}

/// A deliberately small event projection. It cannot carry gateway payloads or credentials.
/// Projection is one-way: the runtime never decodes what it emits, so `Deserialize` is
/// test-only and exists so tests can assert the emitted shape.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum SafeEvent {
    #[serde(rename = "openclaw.lifecycle", rename_all = "camelCase")]
    OpenClawLifecycle {
        #[serde(deserialize_with = "deserialize_sequence")]
        sequence: Option<u64>,
        has_run: bool,
        has_message: bool,
        has_session_activity: bool,
    },
    // `deny_unknown_fields` is silently ineffective on a unit variant, so this stays an
    // empty struct variant. `OpenClawRuntime {}` serializes byte-identically to `OpenClawRuntime`.
    #[serde(rename = "openclaw.runtime")]
    OpenClawRuntime {},
    #[serde(rename = "matcha.lifecycle", rename_all = "camelCase")]
    MatchaLifecycle {
        lifecycle: SafeRuntimeLifecycle,
        ready: bool,
        #[serde(deserialize_with = "deserialize_safe_millis")]
        observed_at_ms: u64,
    },
    #[serde(rename = "openclaw.cron.execution", rename_all = "camelCase")]
    OpenClawCronExecution {
        job_id: CronExecutionId,
        run_id: CronExecutionId,
        status: SafeCronExecutionStatus,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "camelCase")]
pub(crate) enum SafeRuntimeLifecycle {
    Unavailable,
    Idle,
    Starting,
    Running,
    Stopping,
    WaitingToRestart,
    Failed,
    ShutDown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct CronExecutionId(String);

impl CronExecutionId {
    pub(crate) fn try_new(value: String) -> Option<Self> {
        (!value.is_empty()
            && value.len() <= MAX_CRON_EXECUTION_ID_BYTES
            && value.as_bytes().iter().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-')
            }))
        .then_some(Self(value))
    }
}

#[cfg(test)]
impl<'de> Deserialize<'de> for CronExecutionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_new(value).ok_or_else(|| D::Error::custom("invalid Cron execution identity"))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SafeCronExecutionStatus {
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(deny_unknown_fields)]
pub(crate) struct Event {
    #[serde(deserialize_with = "deserialize_version")]
    version: u8,
    #[serde(rename = "type")]
    kind: EventType,
    event: SafeEvent,
}

impl Event {
    pub(crate) const fn new(event: SafeEvent) -> Self {
        Self {
            version: CONTROL_VERSION,
            kind: EventType::Event,
            event,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(untagged)]
pub(crate) enum Output {
    Ready(Ready),
    Outcome(Outcome),
    Event(Event),
}

pub(crate) fn decode_command_request(input: &[u8]) -> Result<CommandRequest, WireError> {
    let value = serde_json::from_slice(input).map_err(|_| WireError::MalformedJson)?;
    serde_json::from_value(value).map_err(|_| WireError::InvalidCommand)
}

#[cfg(test)]
pub(crate) fn encode_command_request(request: &CommandRequest) -> Result<Vec<u8>, WireError> {
    serde_json::to_vec(request).map_err(|_| WireError::Encode)
}

#[cfg(test)]
pub(crate) fn decode_output(input: &[u8]) -> Result<Output, WireError> {
    let value = serde_json::from_slice(input).map_err(|_| WireError::MalformedJson)?;
    serde_json::from_value(value).map_err(|_| WireError::InvalidOutput)
}

pub(crate) fn encode(output: &Output) -> Result<Vec<u8>, WireError> {
    serde_json::to_vec(output).map_err(|_| WireError::Encode)
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
