use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response},
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

pub(crate) const ROUTE: &str = "/api/team/prompts";

#[derive(Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
enum PromptRequest {
    #[serde(rename = "team.prompts.read")]
    Read {},
    #[serde(rename = "team.prompts.save")]
    Save {
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
        values: BTreeMap<String, String>,
    },
    #[serde(rename = "team.prompts.preview")]
    Preview {
        values: BTreeMap<String, String>,
        group: String,
        variant: String,
    },
}

pub(crate) async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::OrganizationHandle,
) -> Response {
    if request.method() != "POST" || request.path() != ROUTE {
        return Response::not_found();
    }
    let Some(authorization) = request.bearer_authorization() else {
        return Response::error(401, "Team prompt settings authorization is invalid");
    };
    let body = match serde_json::from_slice::<PromptRequest>(&request.body) {
        Ok(body) => body,
        Err(_) => return invalid(None),
    };
    let (scope, operation) = match &body {
        PromptRequest::Read {} => ("team:read", "team.prompts.read"),
        PromptRequest::Save { .. } => ("team:write", "team.prompts.save"),
        PromptRequest::Preview { .. } => ("team:write", "team.prompts.preview"),
    };
    let mut verifier = verifier.lock().await;
    if verifier
        .verify(
            authorization,
            now_millis(),
            ROUTE,
            scope,
            operation,
            "team-prompts",
        )
        .is_err()
    {
        return Response::error(401, "Team prompt settings authorization is invalid");
    }
    drop(verifier);

    match body {
        PromptRequest::Read {} => match owner.team_prompt_settings().await {
            Ok(settings) => Response::json(
                200,
                json!({
                    "revision": settings.revision,
                    "values": settings.values,
                    "defaults": crate::prompts::defaults(),
                }),
            ),
            Err(error) => owner_error(error),
        },
        PromptRequest::Save {
            expected_revision,
            values,
        } => match owner.save_team_prompts(expected_revision, values).await {
            Ok(settings) => Response::json(
                200,
                json!({
                    "revision": settings.revision,
                    "values": settings.values,
                }),
            ),
            Err(error) => owner_error(error),
        },
        PromptRequest::Preview {
            values,
            group,
            variant,
        } => match crate::prompts::preview(values, &group, &variant) {
            Ok(prompt) => Response::json(200, json!({ "prompt": prompt })),
            Err(error) => invalid(Some(error)),
        },
    }
}

fn invalid(error: Option<crate::prompts::PromptValidationError>) -> Response {
    let mut body = json!({
        "success": false,
        "error": "Team prompt settings request is invalid",
        "code": "TEAM_PROMPTS_INVALID",
    });
    if let Some(error) = error {
        body["error"] = json!(error.code);
        if !error.key.is_empty() {
            body["key"] = json!(error.key);
        }
    }
    Response::json(400, body)
}

fn owner_error(error: crate::TeamPromptSettingsError) -> Response {
    use crate::{StoreFault, TeamPromptSettingsError};

    let (status, error, code) = match error {
        TeamPromptSettingsError::Invalid(error) => return invalid(Some(error)),
        TeamPromptSettingsError::Conflict => (
            409,
            "Team prompt settings changed; reload before saving",
            "TEAM_PROMPTS_CONFLICT",
        ),
        TeamPromptSettingsError::Store(
            StoreFault::CommitOutcomeUnknown(_) | StoreFault::RecoveryRequired,
        ) => (
            503,
            "Team prompt settings commit outcome is unknown; reopen before retrying",
            "TEAM_PROMPTS_OUTCOME_UNKNOWN",
        ),
        TeamPromptSettingsError::Store(_) | TeamPromptSettingsError::Unavailable => (
            503,
            "Team prompt settings are unavailable",
            "TEAM_PROMPTS_UNAVAILABLE",
        ),
    };
    Response::json(
        status,
        json!({ "success": false, "error": error, "code": code }),
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
