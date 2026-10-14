use std::{sync::{Arc, OnceLock}, time::Instant};

use foundation::pipeline::map_concurrent;
use platform::trace::{identifier_hash, session_trace};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::{
    MemberIntroductionError, OrganizationRuntimeDirectory,
    OrganizationFacts, RoleMaterializationAgent, TeamMaterialization, TeamMemberIntroductions,
    TeamCreationFailure, TeamCreationFailureReason, TeamCreationStage,
    TeamProvisionMemberStatus, TeamProvisionObserver, TeamProvisionProgress, TeamProvisionStage,
    TeamProvisionUpdate, team::LEADER_ROLE_ID,
};

const INTRODUCTION_CONCURRENCY: usize = 4;
const MAX_LEADER_MARKDOWN_BYTES: usize = 16 * 1024;
const TEAMRUN_MARKER_PREFIX: &str = "<!-- matchaclaw-teamrun:";
const TEAMRUN_MARKER_SUFFIX: &str = " -->";

pub(super) enum PreparationError {
    Rejected(TeamCreationFailure),
    Unavailable(TeamCreationFailure),
}

pub(super) async fn prepare_manual_team(
    materialization: TeamMaterialization,
    facts: &OrganizationFacts,
    runtimes: &dyn OrganizationRuntimeDirectory,
    introductions: Option<&Arc<dyn TeamMemberIntroductions>>,
    observer: Option<&TeamProvisionObserver>,
    cancellation: CancellationToken,
) -> Result<TeamMaterialization, PreparationError> {
    let started = platform::trace::enabled().then(Instant::now);
    let definition = materialization.definition();
    let team_id = definition.team_id();
    session_trace(
        "runtime.team.prepare.start",
        || json!({"roleCount": definition.roles().len()}),
    );
    if let Some(existing) = facts.team(team_id) {
        if existing.tombstoned() || existing.definition() != definition {
            preparation_end(
                started,
                if existing.tombstoned() {
                    "tombstoned"
                } else {
                    "definition_mismatch"
                },
            );
            return Err(PreparationError::Unavailable(TeamCreationFailure::new(
                TeamCreationStage::Submitting, TeamCreationFailureReason::StoreConflict,
            )));
        }
        let saved = facts
            .materialization_recovery_request(team_id)
            .ok_or_else(|| {
                preparation_end(started, "saved_request_missing");
                PreparationError::Unavailable(TeamCreationFailure::new(
                    TeamCreationStage::Submitting, TeamCreationFailureReason::StoreInvalid,
                ))
            })?;
        let saved_markdown = saved
            .intent()
            .agents()
            .iter()
            .find(|agent| agent.role().as_str() == LEADER_ROLE_ID)
            .and_then(|agent| agent.agents_markdown());
        let materialization = match saved_markdown {
            Some(markdown) => materialization
                .with_leader_agents_markdown(markdown)
                .map_err(|_| {
                    preparation_end(started, "saved_markdown_assembly_failed");
                    PreparationError::Unavailable(TeamCreationFailure::new(
                        TeamCreationStage::Submitting, TeamCreationFailureReason::StoreInvalid,
                    ))
                })?,
            None => materialization,
        };
        return if materialization.request() == &saved {
            if let Some(observer) = observer {
                observer
                    .report(TeamProvisionUpdate::Started(TeamProvisionProgress {
                        stage: TeamProvisionStage::ConfiguringTeam,
                        members: saved
                            .intent()
                            .agents()
                            .iter()
                            .filter(|agent| agent.role().as_str() != LEADER_ROLE_ID)
                            .map(|_| TeamProvisionMemberStatus::Completed)
                            .collect(),
                        member_errors: Default::default(),
                    }))
                    .await;
            }
            preparation_end(started, "replayed");
            Ok(materialization)
        } else {
            preparation_end(started, "saved_request_mismatch");
            Err(PreparationError::Unavailable(TeamCreationFailure::new(
                TeamCreationStage::Submitting, TeamCreationFailureReason::StoreConflict,
            )))
        };
    }

    if !safe_line(team_id.as_str())
        || team_id.as_str().contains(TEAMRUN_MARKER_SUFFIX)
        || definition.roles().iter().any(|role| {
            !safe_line(role.name())
                || !safe_line(role.role_id().as_str())
                || role.role_id().as_str().contains(TEAMRUN_MARKER_SUFFIX)
        })
    {
        preparation_end(started, "unsafe_definition");
        return Err(PreparationError::Rejected(TeamCreationFailure::new(
            TeamCreationStage::Submitting, TeamCreationFailureReason::InvalidInput,
        )));
    }

    let mut members = Vec::new();
    let mut agents = Vec::new();
    for intent in materialization.request().intent().agents() {
        if intent.role().as_str() == LEADER_ROLE_ID {
            continue;
        }
        let role = definition
            .roles()
            .iter()
            .find(|role| role.role_id() == intent.role())
            .ok_or_else(|| {
                preparation_end(started, "role_binding_missing");
                PreparationError::Rejected(TeamCreationFailure::new(
                    TeamCreationStage::Submitting, TeamCreationFailureReason::InvalidInput,
                ))
            })?;
        let RoleMaterializationAgent::External { agent } = intent.agent() else {
            preparation_end(started, "invalid_agent_binding");
            return Err(PreparationError::Rejected(TeamCreationFailure::new(
                TeamCreationStage::Submitting, TeamCreationFailureReason::InvalidInput,
            )));
        };
        members.push((role.name().to_owned(), role.role_id().clone()));
        agents.push(agent.clone());
    }

    if let Some(observer) = observer {
        observer
            .report(TeamProvisionUpdate::Started(TeamProvisionProgress {
                stage: if members.is_empty() {
                    TeamProvisionStage::ConfiguringTeam
                } else {
                    TeamProvisionStage::ReadingProfiles
                },
                members: vec![TeamProvisionMemberStatus::Queued; members.len()],
                member_errors: Default::default(),
            }))
            .await;
    }
    let mut markdown = String::from("## 团队成员");
    if !members.is_empty() {
        let introductions = introductions.ok_or_else(|| {
            preparation_end(started, "introduction_port_missing");
            PreparationError::Unavailable(TeamCreationFailure::new(
                TeamCreationStage::GeneratingIntroductions, TeamCreationFailureReason::Unavailable,
            ))
        })?;
        let runtime = runtimes
            .team_runtime_for_endpoint(materialization.request().intent().endpoint())
            .ok_or_else(|| {
                preparation_end(started, "runtime_missing");
                PreparationError::Unavailable(TeamCreationFailure::new(
                    TeamCreationStage::ReadingProfiles, TeamCreationFailureReason::Unavailable,
                ))
            })?;
        let cancellation = cancellation.child_token();
        let profiles_started = platform::trace::enabled().then(Instant::now);
        session_trace(
            "runtime.team.profiles.start",
            || json!({"memberCount": members.len()}),
        );
        let profiles = runtime
            .read_team_member_profiles_cancellable(agents, cancellation.clone())
            .await
            .map_err(|error| {
                session_trace("runtime.team.profiles.end", || json!({"failure": error, "elapsedMs": profiles_started.map(|started| started.elapsed().as_millis())}));
                preparation_end(started, "read_profiles_failed");
                PreparationError::Unavailable(error)
            })?;
        session_trace(
            "runtime.team.profiles.end",
            || json!({"reason": "read", "profileCount": profiles.len(), "elapsedMs": profiles_started.map(|started| started.elapsed().as_millis())}),
        );
        if profiles.len() != members.len() {
            preparation_end(started, "profile_count_mismatch");
            return Err(PreparationError::Unavailable(TeamCreationFailure::new(
                TeamCreationStage::ReadingProfiles, TeamCreationFailureReason::InvalidResponse,
            )));
        }
        if let Some(observer) = observer {
            observer
                .report(TeamProvisionUpdate::Stage(
                    TeamProvisionStage::GeneratingIntroductions,
                ))
                .await;
        }
        let requests = members
            .into_iter()
            .zip(profiles)
            .enumerate()
            .map(|(index, ((name, role_id), profile))| (index, name, role_id, profile))
            .collect();
        let first_failure = Arc::new(OnceLock::new());
        let sections = map_concurrent(INTRODUCTION_CONCURRENCY, requests, |(index, member_name, member_role_id, profile)| {
            let cancellation = cancellation.clone();
            let introductions = Arc::clone(introductions);
            let observer = observer.cloned();
            let first_failure = Arc::clone(&first_failure);
            async move {
                if let Some(observer) = &observer {
                    observer.report(TeamProvisionUpdate::Member {
                        index,
                        status: TeamProvisionMemberStatus::Running,
                        error: None,
                    }).await;
                }
                let name = markdown_text(&member_name);
                let role_id = markdown_text(member_role_id.as_str());
                let role_hash = platform::trace::enabled().then(|| identifier_hash(member_role_id.as_str()));
                let generated_started = platform::trace::enabled().then(Instant::now);
                session_trace("runtime.team.introduction.start", || json!({"memberIndex": index, "roleIdHash": role_hash}));
                let result = async {
                    if cancellation.is_cancelled() {
                        return Err(MemberIntroductionError::Cancelled);
                    }
                    let request = crate::application::member_introduction::prepare(
                        &member_name,
                        member_role_id,
                        profile,
                    );
                    let output = introductions.generate(request, cancellation.clone()).await?;
                    if !output.complete {
                        return Err(MemberIntroductionError::InvalidOutput);
                    }
                    let output = output.text.trim();
                    if output.is_empty()
                        || output.contains(TEAMRUN_MARKER_PREFIX)
                        || output.len() > MAX_LEADER_MARKDOWN_BYTES
                    {
                        session_trace("runtime.team.introduction.output", || json!({
                            "memberIndex": index,
                            "reason": if output.is_empty() { "empty_output" } else if output.contains(TEAMRUN_MARKER_PREFIX) { "reserved_marker" } else { "output_bytes_exceeded" },
                            "outputBytes": output.len(),
                        }));
                        return Err(MemberIntroductionError::InvalidOutput);
                    }
                    Ok(output.to_owned())
                }
                .await;
                if let Err(error) = &result {
                    if !matches!(error, MemberIntroductionError::Cancelled) {
                        let _ = first_failure.set(generation_failure(index, error));
                    }
                    cancellation.cancel();
                }
                if let Some(observer) = &observer {
                    observer.report(TeamProvisionUpdate::Member {
                        index,
                        status: if result.is_ok() {
                            TeamProvisionMemberStatus::Completed
                        } else {
                            TeamProvisionMemberStatus::Failed
                        },
                        error: result.as_ref().err().copied(),
                    }).await;
                }
                session_trace("runtime.team.introduction.end", || json!({
                    "memberIndex": index, "roleIdHash": role_hash,
                    "reason": result.as_ref().map_or_else(introduction_error, |_| "generated"),
                    "outputBytes": result.as_ref().ok().map(String::len),
                    "elapsedMs": generated_started.map(|started| started.elapsed().as_millis()),
                }));
                match result {
                    Ok(body) => Ok(format!(
                        "\n\n### {name}\n- role_id：{role_id}\n- 专长与职责：{body}"
                    )),
                    Err(error) => Err(generation_failure(index, &error)),
                }
            }
        })
        .await
        .map_err(|mut failure| {
            failure.stage = TeamCreationStage::GeneratingIntroductions;
            let failure = first_failure.get().copied().unwrap_or(failure);
            preparation_end(started, if failure.reason == TeamCreationFailureReason::Cancelled { "cancelled" } else { "generate_failed" });
            PreparationError::Unavailable(failure)
        })?;
        for section in sections {
            markdown.push_str(&section);
        }
    }
    if markdown.len() > MAX_LEADER_MARKDOWN_BYTES {
        preparation_end(started, "total_bytes_exceeded");
        return Err(PreparationError::Rejected(TeamCreationFailure::new(
            TeamCreationStage::GeneratingIntroductions, TeamCreationFailureReason::InvalidOutput,
        )));
    }
    let result = materialization
        .with_leader_agents_markdown(markdown)
        .map_err(|_| PreparationError::Rejected(TeamCreationFailure::new(
            TeamCreationStage::GeneratingIntroductions, TeamCreationFailureReason::InvalidInput,
        )));
    preparation_end(
        started,
        if result.is_ok() {
            "assembled"
        } else {
            "assembly_failed"
        },
    );
    result
}

fn preparation_end(started: Option<Instant>, reason: &'static str) {
    session_trace(
        "runtime.team.prepare.end",
        || json!({"reason": reason, "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
    );
}

fn generation_failure(index: usize, error: &MemberIntroductionError) -> TeamCreationFailure {
    let mut failure = TeamCreationFailure::new(TeamCreationStage::GeneratingIntroductions, match error {
        MemberIntroductionError::CredentialMissing => TeamCreationFailureReason::CredentialMissing,
        MemberIntroductionError::CredentialUnavailable => TeamCreationFailureReason::CredentialUnavailable,
        MemberIntroductionError::ModelAuthentication => TeamCreationFailureReason::ModelAuthentication,
        MemberIntroductionError::ModelPermissionDenied => TeamCreationFailureReason::ModelPermissionDenied,
        MemberIntroductionError::ModelRateLimited => TeamCreationFailureReason::ModelRateLimited,
        MemberIntroductionError::ModelDeadline => TeamCreationFailureReason::ModelDeadline,
        MemberIntroductionError::ModelInvalidResponse => TeamCreationFailureReason::ModelInvalidResponse,
        MemberIntroductionError::Unavailable => TeamCreationFailureReason::Unavailable,
        MemberIntroductionError::Unsupported => TeamCreationFailureReason::Unsupported,
        MemberIntroductionError::InvalidOutput => TeamCreationFailureReason::InvalidOutput,
        MemberIntroductionError::Cancelled => TeamCreationFailureReason::Cancelled,
    });
    failure.member_index = Some(index);
    failure
}

fn introduction_error(error: &MemberIntroductionError) -> &'static str {
    match error {
        MemberIntroductionError::CredentialMissing => "credential_missing",
        MemberIntroductionError::CredentialUnavailable => "credential_unavailable",
        MemberIntroductionError::ModelAuthentication => "model_authentication",
        MemberIntroductionError::ModelPermissionDenied => "model_permission_denied",
        MemberIntroductionError::ModelRateLimited => "model_rate_limited",
        MemberIntroductionError::ModelDeadline => "model_deadline",
        MemberIntroductionError::ModelInvalidResponse => "model_invalid_response",
        MemberIntroductionError::Unavailable => "unavailable",
        MemberIntroductionError::Unsupported => "unsupported",
        MemberIntroductionError::InvalidOutput => "invalid_output",
        MemberIntroductionError::Cancelled => "cancelled",
    }
}

fn safe_line(value: &str) -> bool {
    !value.contains(TEAMRUN_MARKER_PREFIX)
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
}

fn markdown_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '<' | '>' | '#' | '!' | '|'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}
