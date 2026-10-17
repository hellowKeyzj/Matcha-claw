use std::{collections::BTreeMap, fmt};

use serde::Deserialize;
use serde_json::{Value, json};
use sessions_module::model_selection::{
    MatchaProviderRuntimeConfig, ResolvedSessionModelSelection, SessionModelSelectionBinding,
};

use crate::client::{Client, Delivery};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionRemoteKind {
    Rejected,
    Unavailable,
    Conflict,
    CommitUnknown,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionFailureKind {
    InvalidBinding,
    CredentialMissing,
    CredentialUnavailable,
    NotSent,
    Remote {
        code: i64,
        kind: ProjectionRemoteKind,
    },
    Unknown,
    InvalidReadback,
}

pub struct ProjectionFailure {
    kind: ProjectionFailureKind,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl ProjectionFailure {
    pub fn kind(&self) -> ProjectionFailureKind {
        self.kind
    }

    pub(super) fn new(kind: ProjectionFailureKind) -> Self {
        Self { kind, source: None }
    }

    pub(super) fn caused(
        kind: ProjectionFailureKind,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            kind,
            source: Some(Box::new(source)),
        }
    }
}

impl fmt::Debug for ProjectionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectionFailure")
            .field("kind", &self.kind)
            .field("has_private_source", &self.source.is_some())
            .finish()
    }
}

impl fmt::Display for ProjectionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.kind {
            ProjectionFailureKind::InvalidBinding => "Provider binding is unsupported or invalid",
            ProjectionFailureKind::CredentialMissing => "Provider credential is missing",
            ProjectionFailureKind::CredentialUnavailable => {
                "Provider credential resolver is unavailable"
            }
            ProjectionFailureKind::NotSent => "Provider projection was not sent",
            ProjectionFailureKind::Remote { .. } => {
                "Provider projection was rejected by the server"
            }
            ProjectionFailureKind::Unknown => "Provider projection delivery is unknown",
            ProjectionFailureKind::InvalidReadback => "Provider projection readback did not match",
        })
    }
}
impl std::error::Error for ProjectionFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectionReceipt {
    pub providers: BTreeMap<String, Value>,
    pub changed: bool,
    pub application: String,
    pub requires_restart: bool,
    pub active_agent_ids: Vec<String>,
    pub private_sources_ready: bool,
    pub cleanup: ProjectionCleanup,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectionCleanup {
    pub removed_provider_ids: Vec<String>,
    pub blocked_provider_ids: Vec<String>,
}

// Private payload: do not derive Debug or return it from any public owner API.
pub(super) struct Projection {
    pub providers: BTreeMap<String, Value>,
    pub sources: BTreeMap<String, String>,
    pub retired: Vec<String>,
}

pub(super) async fn project(
    client: &Client,
    projection: Projection,
) -> Result<ProjectionReceipt, ProjectionFailure> {
    let expected = projection.providers.clone();
    let retired = projection.retired.clone();
    let response = client
        .call(
            "providers.project",
            json!({
                "providers": projection.providers, "privateSources": projection.sources,
                "retiredProviderIds": projection.retired,
            }),
        )
        .await
        .map_err(transport_failure)?;
    let receipt: ProjectionReceipt = serde_json::from_value(response).map_err(|error| {
        ProjectionFailure::caused(ProjectionFailureKind::InvalidReadback, error)
    })?;
    if receipt.application != "futureCliInstances"
        || !receipt.private_sources_ready
        || receipt.requires_restart != !receipt.active_agent_ids.is_empty()
        || expected
            .iter()
            .any(|(id, value)| receipt.providers.get(id) != Some(value))
        || retired.iter().any(|id| {
            let removed = receipt.cleanup.removed_provider_ids.contains(id);
            let blocked = receipt.cleanup.blocked_provider_ids.contains(id);
            removed == blocked || removed == receipt.providers.contains_key(id)
        })
        || receipt
            .cleanup
            .removed_provider_ids
            .iter()
            .chain(&receipt.cleanup.blocked_provider_ids)
            .any(|id| !retired.contains(id))
    {
        return Err(ProjectionFailure::new(
            ProjectionFailureKind::InvalidReadback,
        ));
    }
    Ok(receipt)
}

pub(super) fn transport_failure(error: crate::client::Error) -> ProjectionFailure {
    let kind = match error.delivery() {
        Delivery::NotSent => ProjectionFailureKind::NotSent,
        Delivery::Unknown => ProjectionFailureKind::Unknown,
        Delivery::ResponseReceived if error.code().is_none() => {
            ProjectionFailureKind::InvalidReadback
        }
        Delivery::ResponseReceived => {
            let code = error.code().expect("remote response has an error code");
            let kind = match code {
                -32602 | -32001 => ProjectionRemoteKind::Rejected,
                -32002 => ProjectionRemoteKind::Conflict,
                -32003 | -32004 | -32005 => ProjectionRemoteKind::Unavailable,
                -32006 => ProjectionRemoteKind::CommitUnknown,
                _ => ProjectionRemoteKind::Other,
            };
            ProjectionFailureKind::Remote { code, kind }
        }
    };
    ProjectionFailure::caused(kind, error)
}

pub async fn project_session_runtime(
    client: &Client,
    command: &ResolvedSessionModelSelection,
) -> Result<String, ProjectionFailure> {
    let SessionModelSelectionBinding::Matcha {
        provider_fingerprint,
        provider_runtime,
        ..
    } = &command.binding
    else {
        return Err(ProjectionFailure::new(
            ProjectionFailureKind::InvalidBinding,
        ));
    };
    let digest = provider_fingerprint
        .strip_prefix("matcha-provider:v1:")
        .filter(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
        .ok_or(ProjectionFailure::new(
            ProjectionFailureKind::InvalidBinding,
        ))?;
    let id = format!("host-session-{digest}");
    let (kind, target, base_url, secret) = match provider_runtime {
        MatchaProviderRuntimeConfig::AnthropicMessages { base_url, api_key } => {
            ("firstParty", "ANTHROPIC_API_KEY", base_url, api_key)
        }
        MatchaProviderRuntimeConfig::GoogleGenerativeAi { base_url, api_key } => {
            ("gemini", "GEMINI_API_KEY", base_url, api_key)
        }
        MatchaProviderRuntimeConfig::OpenAiChatCompletions { base_url, api_key } => {
            ("openai", "OPENAI_API_KEY", base_url, api_key)
        }
        MatchaProviderRuntimeConfig::OpenAiResponses { base_url, api_key } => {
            ("openaiResponses", "OPENAI_API_KEY", base_url, api_key)
        }
    };
    let source = format!("MATCHA_PROVIDER_SESSION_{}", digest.to_ascii_uppercase());
    let mut sources = BTreeMap::new();
    let mut env = BTreeMap::new();
    if let Some(secret) = secret {
        env.insert(target, source.clone());
        sources.insert(source, secret.clone().into_private_string());
    }
    let provider = provider_config(kind, base_url.as_deref(), env);
    let receipt = project(
        client,
        Projection {
            providers: BTreeMap::from([(id.clone(), provider)]),
            sources,
            retired: Vec::new(),
        },
    )
    .await?;
    // A byte-identical session projection is reusable; the Server rejects changes while live.
    if receipt.requires_restart && receipt.changed {
        return Err(ProjectionFailure::new(ProjectionFailureKind::Remote {
            code: -32002,
            kind: ProjectionRemoteKind::Conflict,
        }));
    }
    Ok(id)
}

pub(super) fn provider_config(
    kind: &str,
    base_url: Option<&str>,
    env: BTreeMap<&str, String>,
) -> Value {
    let mut provider = json!({"kind": kind, "env": env});
    if let Some(base_url) = base_url {
        provider["baseUrl"] = json!(base_url);
    }
    provider
}
