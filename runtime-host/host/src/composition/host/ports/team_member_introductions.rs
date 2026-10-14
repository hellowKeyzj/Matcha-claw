use std::time::Instant;

use organization::{
    MemberIntroductionError, MemberIntroductionOutput, MemberIntroductionRequest,
    TeamMemberIntroductions,
};
use platform::trace::{current_session_trace, identifier_hash, session_trace, with_session_trace};
use provider_module::{
    ProviderHandle, ProviderTextGenerationOutcome, ProviderTextGenerationRequest,
    ProviderTextGenerationUnavailableReason,
    llm_client::{LlmFinishReason, LlmGenerationOptions, LlmMessage, LlmRole},
};
use runtime_directory::OwnedRuntimeFuture;
use serde_json::json;
use tokio_util::sync::CancellationToken;

pub(in crate::composition::host) struct ProviderTeamMemberIntroductions {
    provider: ProviderHandle,
}

impl ProviderTeamMemberIntroductions {
    pub(in crate::composition::host) fn new(provider: ProviderHandle) -> Self {
        Self { provider }
    }
}

impl TeamMemberIntroductions for ProviderTeamMemberIntroductions {
    fn generate(
        &self,
        request: MemberIntroductionRequest,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<Result<MemberIntroductionOutput, MemberIntroductionError>> {
        let provider = self.provider.clone();
        Box::pin(async move {
            let cancellation = cancellation.child_token();
            let _cancel_on_drop = cancellation.clone().drop_guard();
            let started = platform::trace::enabled().then(Instant::now);
            let role_hash = platform::trace::enabled().then(|| identifier_hash(request.role_id.as_str()));
            let member_trace = role_hash.as_ref().and_then(|role_hash| {
                current_session_trace().map(|id| {
                    id.replacen(
                        "session-trace:team-call:",
                        &format!("session-trace:team-call.member-{role_hash}:"),
                        1,
                    )
                })
            });
            session_trace(
                "runtime.team.introduction.provider.requested",
                || json!({
                    "roleHash": role_hash,
                    "memberTraceId": member_trace,
                    "inputBytes": request.system_prompt.len() + request.prompt.len(),
                }),
            );
            let generation = with_session_trace(
                member_trace,
                provider.generate_text_cancellable(
                    ProviderTextGenerationRequest {
                        model_ref: None,
                        messages: vec![
                            LlmMessage::text(LlmRole::System, request.system_prompt),
                            LlmMessage::text(LlmRole::User, request.prompt),
                        ],
                        options: LlmGenerationOptions {
                            max_output_tokens: request.max_output_tokens,
                            temperature: request.temperature,
                            ..LlmGenerationOptions::default()
                        },
                    },
                    cancellation.clone(),
                ),
            );
            let outcome = generation.await.map_err(|_| {
                session_trace("runtime.team.introduction.provider.transport-failed", || json!({
                    "roleHash": role_hash, "elapsedMs": started.map(|started| started.elapsed().as_millis() as u64),
                }));
                MemberIntroductionError::Unavailable
            })?;
            session_trace("runtime.team.introduction.provider.completed", || {
                let (category, finish_reason, text_bytes, nonempty) = match &outcome {
                    ProviderTextGenerationOutcome::Generated { response, .. } => (
                        "Generated",
                        match response.finish_reason.as_ref() {
                            Some(LlmFinishReason::Stop) => "Stop",
                            Some(LlmFinishReason::Length) => "Length",
                            Some(LlmFinishReason::ToolUse) => "ToolUse",
                            Some(LlmFinishReason::ContentFilter) => "ContentFilter",
                            Some(LlmFinishReason::Other(_)) => "Other",
                            None => "None",
                        },
                        response.text.len(),
                        !response.text.trim().is_empty(),
                    ),
                    ProviderTextGenerationOutcome::Rejected => ("Rejected", "None", 0, false),
                    ProviderTextGenerationOutcome::Unavailable { .. } => ("Unavailable", "None", 0, false),
                    ProviderTextGenerationOutcome::Cancelled => ("Cancelled", "None", 0, false),
                };
                json!({
                    "roleHash": role_hash, "category": category, "finishReason": finish_reason,
                    "textBytes": text_bytes, "nonempty": nonempty,
                    "elapsedMs": started.map(|started| started.elapsed().as_millis() as u64),
                })
            });
            match outcome {
                ProviderTextGenerationOutcome::Generated { response, .. } => {
                    Ok(MemberIntroductionOutput {
                        text: response.text,
                        complete: matches!(response.finish_reason, Some(LlmFinishReason::Stop)),
                    })
                }
                ProviderTextGenerationOutcome::Rejected => {
                    Err(MemberIntroductionError::Unsupported)
                }
                ProviderTextGenerationOutcome::Unavailable { reason } => Err(match reason {
                    ProviderTextGenerationUnavailableReason::CredentialMissing => {
                        MemberIntroductionError::CredentialMissing
                    }
                    ProviderTextGenerationUnavailableReason::CredentialUnavailable => {
                        MemberIntroductionError::CredentialUnavailable
                    }
                    ProviderTextGenerationUnavailableReason::Authentication => {
                        MemberIntroductionError::ModelAuthentication
                    }
                    ProviderTextGenerationUnavailableReason::PermissionDenied => {
                        MemberIntroductionError::ModelPermissionDenied
                    }
                    ProviderTextGenerationUnavailableReason::RateLimited => {
                        MemberIntroductionError::ModelRateLimited
                    }
                    ProviderTextGenerationUnavailableReason::Deadline => {
                        MemberIntroductionError::ModelDeadline
                    }
                    ProviderTextGenerationUnavailableReason::InvalidResponse => {
                        MemberIntroductionError::ModelInvalidResponse
                    }
                    ProviderTextGenerationUnavailableReason::ProviderUnavailable => {
                        MemberIntroductionError::Unavailable
                    }
                }),
                ProviderTextGenerationOutcome::Cancelled => Err(MemberIntroductionError::Cancelled),
            }
        })
    }
}
