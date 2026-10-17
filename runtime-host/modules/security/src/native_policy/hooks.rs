use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    Notification,
    UserPromptSubmit,
    SessionStart,
    SessionEnd,
    Stop,
    StopFailure,
    SubagentStart,
    SubagentStop,
    PreCompact,
    PostCompact,
    PermissionRequest,
    PermissionDenied,
    Setup,
    TeammateIdle,
    TaskCreated,
    TaskCompleted,
    Elicitation,
    ElicitationResult,
    ConfigChange,
    WorktreeCreate,
    WorktreeRemove,
    InstructionsLoaded,
    CwdChanged,
    FileChanged,
}

pub type Hooks = BTreeMap<HookEvent, Vec<HookMatcher>>;
pub type HookCounts = BTreeMap<HookEvent, HookCount>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookCount {
    pub matcher_count: u64,
    pub hook_count: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HookMatcher {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub hooks: Vec<Hook>,
}

// These write-only values must not be projected to CallLog or read responses.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Hook {
    Command {
        command: String,
        #[serde(rename = "if", skip_serializing_if = "Option::is_none")]
        condition: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<f64>,
        #[serde(rename = "statusMessage", skip_serializing_if = "Option::is_none")]
        status_message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        once: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        shell: Option<HookShell>,
        #[serde(rename = "async", skip_serializing_if = "Option::is_none")]
        asynchronous: Option<bool>,
        #[serde(rename = "asyncRewake", skip_serializing_if = "Option::is_none")]
        async_rewake: Option<bool>,
    },
    Prompt {
        prompt: String,
        #[serde(rename = "if", skip_serializing_if = "Option::is_none")]
        condition: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<f64>,
        #[serde(rename = "statusMessage", skip_serializing_if = "Option::is_none")]
        status_message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        once: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    Agent {
        prompt: String,
        #[serde(rename = "if", skip_serializing_if = "Option::is_none")]
        condition: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<f64>,
        #[serde(rename = "statusMessage", skip_serializing_if = "Option::is_none")]
        status_message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        once: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    Http {
        url: String,
        #[serde(rename = "if", skip_serializing_if = "Option::is_none")]
        condition: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<f64>,
        #[serde(rename = "statusMessage", skip_serializing_if = "Option::is_none")]
        status_message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        once: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        headers: Option<BTreeMap<String, String>>,
        #[serde(rename = "allowedEnvVars", skip_serializing_if = "Option::is_none")]
        allowed_env_vars: Option<Vec<String>>,
    },
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HookShell {
    Bash,
    Powershell,
}
