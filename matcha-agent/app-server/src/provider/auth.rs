use super::config::{ProviderConfig, ProviderKind, SELECTOR_ENVS, for_agent};
use crate::{cli::command, config::ConfigStore, rpc, session::Sessions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Agent {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeStatus {
    logged_in: bool,
    auth_method: AuthMethod,
    api_provider: ProviderKind,
}

#[derive(Deserialize, Serialize)]
enum AuthMethod {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "third_party")]
    ThirdParty,
    #[serde(rename = "claude.ai")]
    ClaudeAi,
    #[serde(rename = "api_key_helper")]
    ApiKeyHelper,
    #[serde(rename = "oauth_token")]
    OauthToken,
    #[serde(rename = "api_key")]
    ApiKey,
}

pub(super) async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result {
    let input: Agent = rpc::params(params)?;
    match method {
        "auth.status" => {
            let snapshot = config.snapshot().await;
            let provider = for_agent(&snapshot, &input.agent_id)?;
            let output = command::run_observed(
                &snapshot,
                config.paths(),
                &input.agent_id,
                vec!["auth".into(), "status".into(), "--json".into()],
            )
            .await?;
            if !matches!(output.code, Some(0 | 1)) {
                return Err(rpc::Error::new(
                    -32004,
                    "auth_status_exit",
                    "The native auth status command exited unsuccessfully",
                )
                .with_data(json!({"exitCode": output.code})));
            }
            let status: NativeStatus = serde_json::from_str(&output.stdout).map_err(|source| {
                rpc::Error::new(
                    -32004,
                    "auth_status_response",
                    "Native auth status did not return the expected safe JSON fields",
                )
                .with_source(source)
            })?;
            if status.logged_in != (output.code == Some(0)) {
                return Err(rpc::Error::new(
                    -32004,
                    "auth_status_inconsistent",
                    "Native auth status and its exit code disagree",
                ));
            }
            Ok(json!({
                "agentId": input.agent_id,
                "providerId": provider.as_ref().map(|(id, _)| id),
                "configuredProvider": provider.as_ref().map(|(_, provider)| provider.kind),
                "source": "nativeAuthCommand",
                "nativeReportedLoggedIn": status.logged_in,
                "nativeAuthMethod": status.auth_method,
                "nativeApiProvider": status.api_provider,
                "credentialValidation": "notPerformed",
                "nativeExitCode": output.code,
            }))
        }
        "auth.login" | "auth.logout" => {
            let _guard = sessions.agent_guard(&input.agent_id).await;
            let snapshot = config.snapshot().await;
            let provider = for_agent(&snapshot, &input.agent_id)?;
            if sessions.is_agent_active(&input.agent_id).await {
                return Err(rpc::Error::conflict("auth_active_session", "Close the Agent's active CLI sessions before changing native authentication")
                    .with_data(json!({"agentId": input.agent_id, "requiresRestart": true, "commandStarted": false})));
            }
            if method == "auth.login" {
                ensure_headless_login(
                    &snapshot,
                    &input.agent_id,
                    provider.as_ref().map(|(_, provider)| provider),
                )?;
            }
            let action = if method == "auth.login" {
                "login"
            } else {
                "logout"
            };
            command::run(
                &snapshot,
                config.paths(),
                &input.agent_id,
                vec!["auth".into(), action.into()],
            )
            .await
            .map_err(|error| {
                error.with_data(json!({
                    "agentId": input.agent_id,
                    "nativeAuthMayHaveChanged": true,
                    "retryAutomatically": false,
                }))
            })?;
            Ok(json!({
                "agentId": input.agent_id,
                "action": action,
                "source": "nativeAuthCommand",
                "nativeCommandSucceeded": true,
                "application": "futureCliInstances",
                "nativeScope": "anthropicAndChatgpt",
                "clearsNativeSecureStorage": true,
                "externalCredentialSourcesUnchanged": true,
                "credentialValidation": "notPerformed",
            }))
        }
        _ => Err(rpc::Error::method(method)),
    }
}

fn ensure_headless_login(
    config: &crate::config::Config,
    agent_id: &str,
    provider: Option<&ProviderConfig>,
) -> rpc::Result<()> {
    let third_party_settings = provider.is_none()
        && matches!(
            config.agents[agent_id]
                .settings
                .get("modelType")
                .and_then(Value::as_str),
            Some("openai" | "gemini" | "grok")
        );
    let third_party = third_party_settings
        || provider.is_some_and(|provider| provider.kind != ProviderKind::FirstParty);
    if provider.is_none()
        && SELECTOR_ENVS
            .iter()
            .any(|selector| config.cli.env.contains_key(*selector))
    {
        return Err(rpc::Error::unavailable("auth_login_route_unbound", "Bind an explicit firstParty provider before using headless login with CLI provider selectors")
            .with_data(json!({"commandStarted": false})));
    }
    if third_party {
        return Err(rpc::Error::unavailable(
            "auth_login_provider",
            "Native auth login manages Anthropic OAuth, not this provider's credentials",
        )
        .with_data(json!({"commandStarted": false, "nativeCredentialAuthorityUnchanged": true})));
    }
    let source = |name: &str| {
        provider
            .and_then(|provider| provider.env.get(name))
            .or_else(|| config.cli.env.get(name))
    };
    let token = source("CLAUDE_CODE_OAUTH_REFRESH_TOKEN");
    let scopes = source("CLAUDE_CODE_OAUTH_SCOPES");
    let (Some(token), Some(scopes)) = (token, scopes) else {
        return Err(rpc::Error::unavailable("interactive_oauth_required", "Browser OAuth requires an interactive native CLI and a browser callback; this RPC only runs the native refresh-token entry")
            .with_data(json!({
                "commandStarted": false,
                "requiredEnvReferences": ["CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES"],
                "interactiveNativeCommand": ["auth", "login"],
                "interactiveNativeOptions": ["--email <email>", "--sso", "--console", "--claudeai"],
                "optionConstraint": "--console and --claudeai are mutually exclusive; managed forceLoginMethod and forceLoginOrgUUID still apply",
            })));
    };
    source_value(token)?;
    if source_value(scopes)?.split_whitespace().next().is_none() {
        return Err(rpc::Error::invalid(
            "The OAuth scopes source must contain space-separated native scopes",
        ));
    }
    Ok(())
}

fn source_value(source: &str) -> rpc::Result<String> {
    match std::env::var(source) {
        Ok(value) if !value.is_empty() => Ok(value),
        Ok(_) => Err(rpc::Error::unavailable(
            "native_env_source_empty",
            "An authentication environment source is empty",
        )),
        Err(source @ std::env::VarError::NotPresent) => Err(rpc::Error::unavailable(
            "native_env_source_missing",
            "An authentication environment source is not set",
        )
        .with_source(source)),
        Err(source @ std::env::VarError::NotUnicode(_)) => Err(rpc::Error::unavailable(
            "native_env_source_encoding",
            "An authentication environment source is not Unicode",
        )
        .with_source(source)),
    }
}
