use crate::{
    config::{Config, ConfigStore, validate_id},
    rpc,
    session::Sessions,
};
use axum::http::Uri;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const SELECTOR_ENVS: [&str; 7] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_OPENAI",
    "CLAUDE_CODE_USE_OPENAI_RESPONSES",
    "CLAUDE_CODE_USE_GEMINI",
    "CLAUDE_CODE_USE_GROK",
];

const MODEL_ENVS: [&str; 4] = [
    "ANTHROPIC_MODEL",
    "OPENAI_MODEL",
    "GEMINI_MODEL",
    "GROK_MODEL",
];

const SHARED_ENVS: &[&str] = &[
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    FirstParty,
    Bedrock,
    Vertex,
    Foundry,
    Openai,
    OpenaiResponses,
    Gemini,
    Grok,
}

impl ProviderKind {
    const ALL: [Self; 8] = [
        Self::FirstParty,
        Self::Bedrock,
        Self::Vertex,
        Self::Foundry,
        Self::Openai,
        Self::OpenaiResponses,
        Self::Gemini,
        Self::Grok,
    ];

    pub fn selector(self) -> Option<&'static str> {
        match self {
            Self::FirstParty => None,
            Self::Bedrock => Some(SELECTOR_ENVS[0]),
            Self::Vertex => Some(SELECTOR_ENVS[1]),
            Self::Foundry => Some(SELECTOR_ENVS[2]),
            Self::Openai => Some(SELECTOR_ENVS[3]),
            Self::OpenaiResponses => Some(SELECTOR_ENVS[4]),
            Self::Gemini => Some(SELECTOR_ENVS[5]),
            Self::Grok => Some(SELECTOR_ENVS[6]),
        }
    }

    pub fn base_url_env(self) -> &'static str {
        match self {
            Self::FirstParty => "ANTHROPIC_BASE_URL",
            Self::Bedrock => "ANTHROPIC_BEDROCK_BASE_URL",
            Self::Vertex => "ANTHROPIC_VERTEX_BASE_URL",
            Self::Foundry => "ANTHROPIC_FOUNDRY_BASE_URL",
            Self::Openai | Self::OpenaiResponses => "OPENAI_BASE_URL",
            Self::Gemini => "GEMINI_BASE_URL",
            Self::Grok => "GROK_BASE_URL",
        }
    }

    pub fn env_names(self) -> Vec<&'static str> {
        let native: &[&str] = match self {
            Self::FirstParty => &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
                "CLAUDE_CODE_OAUTH_SCOPES",
            ],
            Self::Bedrock => &[
                "AWS_BEARER_TOKEN_BEDROCK",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
                "AWS_PROFILE",
                "AWS_REGION",
                "AWS_DEFAULT_REGION",
                "AWS_SHARED_CREDENTIALS_FILE",
                "AWS_CONFIG_FILE",
                "AWS_ROLE_ARN",
                "AWS_ROLE_SESSION_NAME",
                "AWS_WEB_IDENTITY_TOKEN_FILE",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                "AWS_EC2_METADATA_DISABLED",
                "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
                "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
            ],
            Self::Vertex => &[
                "ANTHROPIC_VERTEX_PROJECT_ID",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "google_application_credentials",
                "GOOGLE_CLOUD_PROJECT",
                "google_cloud_project",
                "GCLOUD_PROJECT",
                "gcloud_project",
                "CLOUD_ML_REGION",
                "VERTEX_REGION_CLAUDE_HAIKU_4_5",
                "VERTEX_REGION_CLAUDE_3_5_HAIKU",
                "VERTEX_REGION_CLAUDE_3_5_SONNET",
                "VERTEX_REGION_CLAUDE_3_7_SONNET",
                "VERTEX_REGION_CLAUDE_4_1_OPUS",
                "VERTEX_REGION_CLAUDE_4_0_OPUS",
                "VERTEX_REGION_CLAUDE_4_6_SONNET",
                "VERTEX_REGION_CLAUDE_4_5_SONNET",
                "VERTEX_REGION_CLAUDE_4_0_SONNET",
                "CLAUDE_CODE_SKIP_VERTEX_AUTH",
            ],
            Self::Foundry => &[
                "ANTHROPIC_FOUNDRY_RESOURCE",
                "ANTHROPIC_FOUNDRY_API_KEY",
                "AZURE_TENANT_ID",
                "AZURE_CLIENT_ID",
                "AZURE_CLIENT_SECRET",
                "AZURE_CLIENT_CERTIFICATE_PATH",
                "AZURE_CLIENT_CERTIFICATE_PASSWORD",
                "AZURE_AUTHORITY_HOST",
                "AZURE_FEDERATED_TOKEN_FILE",
                "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
            ],
            Self::Openai | Self::OpenaiResponses => &[
                "OPENAI_API_KEY",
                "OPENAI_ORG_ID",
                "OPENAI_PROJECT_ID",
                "OPENAI_AUTH_MODE",
                "OPENAI_DEFAULT_HAIKU_MODEL",
                "OPENAI_DEFAULT_HAIKU_MODEL_DESCRIPTION",
                "OPENAI_DEFAULT_HAIKU_MODEL_NAME",
                "OPENAI_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
                "OPENAI_DEFAULT_OPUS_MODEL",
                "OPENAI_DEFAULT_OPUS_MODEL_DESCRIPTION",
                "OPENAI_DEFAULT_OPUS_MODEL_NAME",
                "OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
                "OPENAI_DEFAULT_SONNET_MODEL",
                "OPENAI_DEFAULT_SONNET_MODEL_DESCRIPTION",
                "OPENAI_DEFAULT_SONNET_MODEL_NAME",
                "OPENAI_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
                "OPENAI_SMALL_FAST_MODEL",
                "OPENAI_ENABLE_THINKING",
                "OPENAI_MAX_TOKENS",
            ],
            Self::Gemini => &[
                "GEMINI_API_KEY",
                "GEMINI_SMALL_FAST_MODEL",
                "GEMINI_DEFAULT_HAIKU_MODEL",
                "GEMINI_DEFAULT_HAIKU_MODEL_DESCRIPTION",
                "GEMINI_DEFAULT_HAIKU_MODEL_NAME",
                "GEMINI_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
                "GEMINI_DEFAULT_OPUS_MODEL",
                "GEMINI_DEFAULT_OPUS_MODEL_DESCRIPTION",
                "GEMINI_DEFAULT_OPUS_MODEL_NAME",
                "GEMINI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
                "GEMINI_DEFAULT_SONNET_MODEL",
                "GEMINI_DEFAULT_SONNET_MODEL_DESCRIPTION",
                "GEMINI_DEFAULT_SONNET_MODEL_NAME",
                "GEMINI_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
            ],
            Self::Grok => &[
                "GROK_API_KEY",
                "XAI_API_KEY",
                "GROK_MODEL_MAP",
                "GROK_DEFAULT_HAIKU_MODEL",
                "GROK_DEFAULT_OPUS_MODEL",
                "GROK_DEFAULT_SONNET_MODEL",
            ],
        };
        SHARED_ENVS.iter().chain(native).copied().collect()
    }
}

/// Names removed from inherited process environments before explicit projection.
pub fn managed_env_names() -> Vec<&'static str> {
    let mut names = vec!["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"];
    names.extend(SELECTOR_ENVS);
    names.extend(MODEL_ENVS);
    for kind in ProviderKind::ALL {
        names.push(kind.base_url_env());
        names.extend(kind.env_names());
    }
    names.sort_unstable();
    names.dedup();
    names
}

/// Public configuration contains environment references, never resolved credentials.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl ProviderConfig {
    pub fn parse(value: &Value) -> rpc::Result<Self> {
        let provider: Self = rpc::params(value.clone())?;
        if provider.model.as_ref().is_some_and(|model| {
            model.is_empty()
                || model
                    .chars()
                    .any(|ch| ch.is_control() || ch.is_whitespace())
        }) {
            return Err(rpc::Error::invalid(
                "Provider model must be a nonempty model identifier",
            ));
        }
        if let Some(base_url) = &provider.base_url {
            let uri: Uri = base_url.parse().map_err(|source| {
                rpc::Error::invalid(
                    "Provider baseUrl must be an absolute HTTP(S) URL without credentials",
                )
                .with_source(source)
            })?;
            if !matches!(uri.scheme_str(), Some("http" | "https"))
                || uri.host().is_none_or(str::is_empty)
                || uri
                    .authority()
                    .is_some_and(|authority| authority.as_str().contains(['@', '%']))
                || uri.query().is_some()
                || base_url.contains(['#', '\\'])
                || base_url
                    .chars()
                    .any(|ch| ch.is_control() || ch.is_whitespace())
            {
                return Err(rpc::Error::invalid(
                    "Provider baseUrl must not contain userinfo, query, fragment, or whitespace",
                ));
            }
        }
        let allowed = provider.kind.env_names();
        if provider.env.iter().any(|(native_name, source_name)| {
            !allowed.contains(&native_name.as_str()) || !environment_name(source_name)
        }) {
            return Err(rpc::Error::invalid(
                "Provider env must map allowed native names to source environment variable names; routing belongs in kind, model, and baseUrl",
            ));
        }
        Ok(provider)
    }
}

pub(super) fn environment_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(byte) if byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

pub(super) fn for_agent(
    config: &Config,
    agent_id: &str,
) -> rpc::Result<Option<(String, ProviderConfig)>> {
    validate_id(agent_id)?;
    let agent = config
        .agents
        .get(agent_id)
        .ok_or_else(|| rpc::Error::not_found("agent"))?;
    agent
        .provider
        .as_ref()
        .map(|id| {
            let value = config
                .providers
                .get(id)
                .ok_or_else(|| rpc::Error::not_found("provider"))?;
            Ok((id.clone(), ProviderConfig::parse(value)?))
        })
        .transpose()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Set {
    id: String,
    provider: Value,
}

pub(super) async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result {
    match method {
        "providers.list" => {
            let _: Empty = rpc::params(params)?;
            let config = config.snapshot().await;
            let providers = config
                .providers
                .iter()
                .map(|(id, provider)| {
                    Ok(json!({"id": id, "provider": ProviderConfig::parse(provider)?}))
                })
                .collect::<rpc::Result<Vec<_>>>()?;
            Ok(json!({"providers": providers}))
        }
        "providers.get" => {
            let input: Id = rpc::params(params)?;
            validate_id(&input.id)?;
            let config = config.snapshot().await;
            let provider = config
                .providers
                .get(&input.id)
                .ok_or_else(|| rpc::Error::not_found("provider"))?;
            Ok(json!({"id": input.id, "provider": ProviderConfig::parse(provider)?}))
        }
        "providers.set" => {
            let input: Set = rpc::params(params)?;
            validate_id(&input.id)?;
            let provider = ProviderConfig::parse(&input.provider)?;
            let stored = rpc::value(&provider)?;
            let (changed, affected) = config
                .update(|config| {
                    let previous = config
                        .providers
                        .get(&input.id)
                        .map(ProviderConfig::parse)
                        .transpose()?;
                    let changed = previous.as_ref() != Some(&provider);
                    let affected = config
                        .agents
                        .iter()
                        .filter(|(_, agent)| agent.provider.as_deref() == Some(&input.id))
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>();
                    config.providers.insert(input.id.clone(), stored);
                    Ok((changed, affected))
                })
                .await?;
            let mut active = Vec::new();
            if changed {
                for agent_id in &affected {
                    if sessions.is_agent_active(agent_id).await {
                        active.push(agent_id.clone());
                    }
                }
            }
            Ok(json!({
                "id": input.id, "provider": provider, "changed": changed,
                "application": "futureCliInstances", "requiresRestart": !active.is_empty(),
                "affectedAgentIds": affected, "activeAgentIds": active,
            }))
        }
        "providers.remove" => {
            let input: Id = rpc::params(params)?;
            validate_id(&input.id)?;
            config
                .update(|config| {
                    if !config.providers.contains_key(&input.id) {
                        return Err(rpc::Error::not_found("provider"));
                    }
                    let affected = config
                        .agents
                        .iter()
                        .filter(|(_, agent)| agent.provider.as_deref() == Some(&input.id))
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>();
                    if !affected.is_empty() {
                        return Err(rpc::Error::conflict(
                            "provider_in_use",
                            "Unbind the provider from its agents before removing it",
                        )
                        .with_data(json!({"affectedAgentIds": affected})));
                    }
                    config.providers.remove(&input.id);
                    Ok(())
                })
                .await?;
            Ok(json!({"id": input.id, "removed": true}))
        }
        _ => Err(rpc::Error::method(method)),
    }
}
