use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use world::{
    InvestigationAccepted, InvestigationFuture, InvestigationReceipt, InvestigationRejection,
    InvestigationRequest, InvestigationSentness, InvestigationSettlementFuture, InvestigationState,
    InvestigationTerminal, InvestigationUsage, NativeVerificationError, WorldInvestigation,
};
use world_protocol::{api::InvestigationSelection, budget::BudgetDimension, time::Timestamp};

use super::{WorldRuntimeHost, projection::canonical};
use crate::{
    client::{Client, Delivery, Error},
    driver::MatchaRuntimeDriver,
};

struct Investigation {
    client: Client,
    projection: WorldRuntimeHost,
}

impl MatchaRuntimeDriver {
    pub fn world_investigation(&self, projection: WorldRuntimeHost) -> Arc<dyn WorldInvestigation> {
        Arc::new(Investigation {
            client: self.native_client(),
            projection,
        })
    }
}

impl WorldInvestigation for Investigation {
    fn execute<'a>(&'a self, request: InvestigationRequest) -> InvestigationFuture<'a> {
        Box::pin(async move {
            match request.authority.may_dispatch(&request).await {
                Ok(true) => {}
                _ => return unknown(&request),
            }
            let Some((agent, session)) = target(&request) else {
                return invalid(&request);
            };
            let native = match self
                .client
                .call("sessions.get", json!({"sessionId":session}))
                .await
            {
                Ok(native) => native,
                Err(_) => {
                    return receipt(
                        &request,
                        InvestigationState::Unavailable,
                        InvestigationSentness::NotSent,
                    );
                }
            };
            if native["sessionId"].as_str() != Some(session)
                || native["agentId"].as_str() != Some(agent)
            {
                return rejected(&request, InvestigationRejection::SelectionChanged);
            }
            let Some(mut params) = parameters(&request) else {
                return invalid(&request);
            };
            if self.projection.sign_investigation(&mut params).is_err() {
                return receipt(
                    &request,
                    InvestigationState::Unavailable,
                    InvestigationSentness::NotSent,
                );
            }
            match self.client.call("runs.submit", params).await {
                Ok(run) => self.reconcile(&request, run, true).await,
                Err(error) => transport(&request, &error),
            }
        })
    }

    fn inspect<'a>(&'a self, request: InvestigationRequest) -> InvestigationFuture<'a> {
        Box::pin(async move {
            if request.authority.require_request(&request).is_err() {
                return unknown(&request);
            }
            match self.lookup(&request).await {
                Ok(Some(run)) => self.reconcile(&request, run, true).await,
                Ok(None) => receipt(
                    &request,
                    InvestigationState::Unknown,
                    InvestigationSentness::MayHaveSent,
                ),
                Err(error) => transport_inspect(&request, &error),
            }
        })
    }

    fn cancel<'a>(
        &'a self,
        request: InvestigationRequest,
        _requested_at: Timestamp,
    ) -> InvestigationFuture<'a> {
        Box::pin(async move {
            if request.authority.require_request(&request).is_err() {
                return unknown(&request);
            }
            let run = match self.lookup(&request).await {
                Ok(Some(run)) => run,
                Ok(None) => {
                    return receipt(
                        &request,
                        InvestigationState::Unknown,
                        InvestigationSentness::MayHaveSent,
                    );
                }
                Err(error) => return transport_inspect(&request, &error),
            };
            let Some(checked) = checked(&request, &run) else {
                return unknown(&request);
            };
            if let Some(accepted) = &checked.accepted {
                if request
                    .authority
                    .attach_accepted(accepted, &checked.producer)
                    .is_err()
                {
                    return unknown(&request);
                }
            }
            // An acknowledgement is only cancellation intent. The original Run proves stopping.
            let mut result = match self
                .client
                .call("runs.cancel", json!({"runId":run["runId"]}))
                .await
            {
                Ok(run) => self.reconcile(&request, run, false).await,
                Err(_) => unknown(&request),
            };
            if result.accepted.is_none() {
                result.accepted = checked.accepted;
            }
            result
        })
    }

    fn settle<'a>(
        &'a self,
        request: InvestigationRequest,
        settled_at: Timestamp,
    ) -> InvestigationSettlementFuture<'a> {
        Box::pin(async move {
            request.authority.require_settlement(&request)?;
            let Some(run) = self.lookup(&request).await.map_err(settlement_cause)? else {
                request.authority.require_not_sent_settlement(&request)?;
                return Ok(());
            };
            let verified = checked(&request, &run)
                .ok_or_else(|| settlement_invalid("native Run identity changed"))?;
            let mut params = json!({
                "runId":run["runId"],"requestId":request.identity.native_request_id,
                "requestDigest":verified.request_digest,
                "settledAtMs":u64::try_from(settled_at.unix_millis()).map_err(settlement_cause)?,
            });
            if let Some(accepted) = &verified.accepted {
                request
                    .authority
                    .attach_accepted(accepted, &verified.producer)?;
                params["correlation"] = serde_json::to_value(accepted).map_err(settlement_cause)?;
            }
            let settled = self
                .client
                .call("runs.settleInvestigation", params)
                .await
                .map_err(settlement_cause)?;
            let confirmed = checked(&request, &settled)
                .ok_or_else(|| settlement_invalid("native settled Run identity changed"))?;
            let state = map_run(&request, &settled).state;
            if confirmed.accepted != verified.accepted
                || confirmed.request_digest != verified.request_digest
                || settled
                    .pointer("/worldInvestigation/settledAtMs")
                    .and_then(Value::as_u64)
                    .is_none()
                || !matches!(
                    state,
                    InvestigationState::Terminal { .. }
                        | InvestigationState::Rejected {
                            reason: InvestigationRejection::StartRejected
                        }
                )
            {
                return Err(settlement_invalid(
                    "native Run settlement was not acknowledged",
                ));
            }
            Ok(())
        })
    }
}

impl Investigation {
    async fn lookup(&self, request: &InvestigationRequest) -> Result<Option<Value>, Error> {
        let session = target(request).map(|(_, session)| session).unwrap_or("");
        let value = self
            .client
            .call(
                "runs.getByRequest",
                json!({
                    "sessionId":session,"requestId":request.identity.native_request_id,
                }),
            )
            .await?;
        Ok((!value.is_null()).then_some(value))
    }

    async fn reconcile(
        &self,
        request: &InvestigationRequest,
        mut run: Value,
        release: bool,
    ) -> InvestigationReceipt {
        let Some(checked) = checked(request, &run) else {
            return unknown(request);
        };
        if let Some(accepted) = &checked.accepted {
            if request
                .authority
                .attach_accepted(accepted, &checked.producer)
                .is_err()
            {
                return unknown(request);
            }
            if release
                && run
                    .pointer("/worldInvestigation/dispatchState")
                    .and_then(Value::as_str)
                    == Some("held")
            {
                match request.authority.may_release().await {
                    Ok(true) => {
                        run = match self.client.call("runs.releaseInvestigation", json!({
                            "runId":run["runId"],"requestId":request.identity.native_request_id,
                            "requestDigest":checked.request_digest,"correlation":accepted,
                        })).await {
                            Ok(run) => run,
                            Err(_) => return unknown_accepted(request, checked.accepted.clone()),
                        };
                    }
                    Ok(false) => {}
                    Err(_) => return unknown_accepted(request, checked.accepted.clone()),
                }
            }
        }
        let mut result = map_run(request, &run);
        if result.accepted.is_none() {
            result.accepted = checked.accepted;
        }
        result
    }
}

struct Checked {
    accepted: Option<InvestigationAccepted>,
    producer: String,
    request_digest: String,
}

fn target(request: &InvestigationRequest) -> Option<(&str, &str)> {
    match &request.identity.selection {
        InvestigationSelection::MatchaAgent {
            agent_id,
            native_session_id,
        } => {
            uuid::Uuid::parse_str(native_session_id.as_str()).ok()?;
            Some((agent_id.as_str(), native_session_id.as_str()))
        }
        _ => None,
    }
}

fn deadline(request: &InvestigationRequest) -> Option<u64> {
    let start = u64::try_from(request.created_at.unix_millis()).ok()?;
    let wall = start.checked_add(request.budget.max_wall_time.0)?;
    let deadline = match &request.budget.deadline {
        Some(deadline) => wall.min(u64::try_from(deadline.unix_millis()).ok()?),
        None => wall,
    };
    (deadline > start && deadline <= 9_007_199_254_740_991).then_some(deadline)
}

fn hash(value: Value) -> Option<String> {
    Some(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&canonical(value)).ok()?)
    ))
}

fn parameters(request: &InvestigationRequest) -> Option<Value> {
    let (_, session) = target(request)?;
    if hash(json!({"budget":null,"content":request.execution_prompt}))?.as_str()
        != request.identity.content_budget_digest.as_str()
    {
        return None;
    }
    Some(json!({
        "sessionId":session,"content":request.execution_prompt,
        "requestId":request.identity.native_request_id,"budget":null,
        "worldInvestigation":{
            "version":1,"bindingId":request.identity.binding_id,
            "allowedEffects":request.allowed_effects,"budget":request.budget,
            "issuedAtMs":u64::try_from(request.created_at.unix_millis()).ok()?,
            "expiresAtMs":deadline(request)?,
        },
    }))
}

fn checked(request: &InvestigationRequest, run: &Value) -> Option<Checked> {
    let (_, session) = target(request)?;
    let run_id = run.get("runId")?.as_str()?;
    let input_id = run.get("messageId")?.as_str()?;
    uuid::Uuid::parse_str(run_id).ok()?;
    uuid::Uuid::parse_str(input_id).ok()?;
    if run["sessionId"].as_str() != Some(session)
        || run["requestId"].as_str() != Some(request.identity.native_request_id.as_str())
        || format!("sha256:{}", run["contentBudgetDigest"].as_str()?)
            != request.identity.content_budget_digest.as_str()
    {
        return None;
    }
    let facts = run.get("worldInvestigation")?;
    let accepted_params = facts.get("acceptedParams")?;
    let mut expected = parameters(request)?;
    expected["worldInvestigation"]["producer"] = accepted_params
        .pointer("/worldInvestigation/producer")?
        .clone();
    if &expected != accepted_params || facts["envelope"] != accepted_params["worldInvestigation"] {
        return None;
    }
    let producer = accepted_params
        .pointer("/worldInvestigation/producer/runtimeInstance")?
        .as_str()?;
    if !bounded(producer) {
        return None;
    }
    let mut unsigned = accepted_params.clone();
    unsigned
        .pointer_mut("/worldInvestigation/producer")?
        .as_object_mut()?
        .remove("mac")?;
    let request_digest = hash(unsigned)?;
    if facts["requestDigest"].as_str() != Some(request_digest.as_str())
        || facts["deadlineMs"].as_u64()? > deadline(request)?
    {
        return None;
    }
    let accepted = match (
        facts.get("nativeAttemptId").and_then(Value::as_str),
        facts.get("nativeInstanceId").and_then(Value::as_str),
    ) {
        (Some(attempt), Some(instance)) if bounded(attempt) && bounded(instance) => {
            uuid::Uuid::parse_str(attempt).ok()?;
            uuid::Uuid::parse_str(instance).ok()?;
            Some(InvestigationAccepted {
                binding_id: request.identity.binding_id.clone(),
                accepted_request_id: request.identity.native_request_id.clone(),
                accepted_run_id: run_id.to_owned(),
                accepted_input_id: input_id.to_owned(),
                content_budget_digest: request.identity.content_budget_digest.clone(),
                native_attempt_id: attempt.to_owned(),
                native_instance_id: instance.to_owned(),
            })
        }
        (None, None) => None,
        _ => return None,
    };
    Some(Checked {
        accepted,
        producer: producer.to_owned(),
        request_digest,
    })
}

fn map_run(request: &InvestigationRequest, run: &Value) -> InvestigationReceipt {
    let Some(checked) = checked(request, run) else {
        return unknown(request);
    };
    let mut result = receipt(
        request,
        InvestigationState::Accepted,
        InvestigationSentness::MayHaveSent,
    );
    result.accepted = checked.accepted;
    let status = run["status"].as_str().unwrap_or("");
    if status == "queued" || status == "starting" {
        result.state = InvestigationState::Pending;
    }
    let Some(native) = run.pointer("/worldInvestigation/receipt") else {
        return result;
    };
    if result.accepted.is_none()
        && matches!(status, "succeeded" | "failed" | "cancelled")
        && run
            .pointer("/worldInvestigation/inputDelivery")
            .and_then(Value::as_str)
            == Some("not_started")
        && run
            .pointer("/worldInvestigation/io")
            .and_then(Value::as_object)
            .is_some_and(|io| io.is_empty())
        && native["inputDelivery"] == "not_started"
        && native["correlation"].is_null()
        && native["scope"] == "accepted_input"
        && native["coverage"] == "native_exclusive"
        && native["childrenJoined"] == true
        && native["pendingIo"] == "0"
        && native["nativeStopped"] == true
        && native["ownershipConfirmed"] == true
    {
        let mut unsigned = native.clone();
        let digest = unsigned
            .as_object_mut()
            .and_then(|object| object.remove("receiptDigest"));
        if digest.as_ref().and_then(Value::as_str) == hash(unsigned).as_deref() {
            return rejected(request, InvestigationRejection::StartRejected);
        }
    }
    let Some(accepted) = &result.accepted else {
        return result;
    };
    let exact = serde_json::to_value(accepted).ok().as_ref() == native.get("correlation");
    let mut unsigned = native.clone();
    let digest = unsigned
        .as_object_mut()
        .and_then(|object| object.remove("receiptDigest"));
    if !exact
        || native["scope"] != "accepted_input"
        || native["coverage"] != "native_exclusive"
        || native["childrenJoined"] != true
        || native["pendingIo"] != "0"
        || native["nativeStopped"] != true
        || native["ownershipConfirmed"] != true
        || digest.as_ref().and_then(Value::as_str) != hash(unsigned).as_deref()
    {
        return result;
    }
    let terminal = match status {
        "succeeded" => InvestigationTerminal::Completed,
        "failed" => InvestigationTerminal::Failed,
        "cancelled" => InvestigationTerminal::Cancelled,
        _ => return result,
    };
    result.state = InvestigationState::Terminal { status: terminal };
    if native.pointer("/usage/coverage").and_then(Value::as_str) == Some("complete") {
        if let Some(usage) = native
            .pointer("/usage/actual")
            .cloned()
            .and_then(|value| serde_json::from_value::<world_protocol::budget::Usage>(value).ok())
            .filter(|usage| usage.cost.is_some() || free_usage(request, run).as_ref() == native.pointer("/usage/actual"))
        {
            result.usage = InvestigationUsage::Complete { usage };
        }
    }
    result
}

fn io_proof(kind: &str, proof: &Value) -> Option<(&'static [&'static str], bool)> {
    let (effect, required, free): (&str, &'static [&'static str], bool) = match kind {
        "loop" if proof["producer"] == "query_loop" => return Some((&[], true)),
        "model" if proof["producer"] == "matcha_model_transport" => ("probabilistic", &["probabilistic"], false),
        "tool" => match proof["toolName"].as_str() {
            Some("StructuredOutput") if proof["producer"] == "matcha_structured_output" => ("pure", &["pure"], true),
            Some("Read") if proof["producer"] == "matcha_builtin_read" => ("source_read", &["source_read"], true),
            Some("world_discover" | "world_query" | "world_explain" | "world_action_status") => ("source_read", &["source_read"], false),
            Some("world_observe" | "world_change_propose" | "world_branch_test") => ("pure", &["pure"], false),
            Some("world_action_propose") => ("source_read", &["pure", "source_read"], false),
            Some("world_action_submit") => ("external_write", &["external_write"], false),
            _ => return None,
        },
        "source" => match (proof["producer"].as_str(), proof["operation"].as_str()) {
            (Some("bounded_regular_file"), Some("file_read"))
            | (Some("matcha_local_source"), Some("directory_read" | "stat" | "lstat" | "realpath" | "readlink")) => ("source_read", &["source_read"], true),
            (Some("matcha_model_transport"), Some("input_token_count"))
            | (Some("matcha_sealed_skill"), Some("catalog_read" | "content_read"))
            | (Some("matcha_files_api"), Some("file_download" | "file_list" | "file_stage"))
            | (Some("matcha_inbound_attachment"), Some("attachment_download" | "attachment_stage")) => ("source_read", &["source_read"], false),
            (Some("matcha_files_api"), Some("file_upload"))
            | (Some("matcha_http_hook"), Some("http_post")) => ("external_write", &["external_write", "source_read"], false),
            _ => return None,
        },
        _ => return None,
    };
    (proof["effect"] == effect).then_some((required, free))
}

fn counter(value: &Value, dimension: &str) -> Option<u64> {
    let text = value.get(dimension)?.as_str()?;
    let integer = text.parse::<u64>().ok()?;
    (integer.to_string() == text).then_some(integer)
}

fn free_usage(request: &InvestigationRequest, run: &Value) -> Option<Value> {
    if request.budget.max_cost.is_some() { return None; }
    let world = run.get("worldInvestigation")?;
    let native = world.get("receipt")?;
    let input = run.pointer("/result/native_input_receipt")?;
    if world["inputDelivery"] != "may_have_sent" || native["inputDelivery"] != world["inputDelivery"]
        || input["correlation"] != native["correlation"]
        || input["scope"] != "accepted_input" || input["coverage"] != "native_exclusive"
        || input["childrenJoined"] != true || input["pendingIo"] != "0"
        || !input.get("unavailable").and_then(Value::as_array).is_some_and(Vec::is_empty)
    {
        return None;
    }
    const DIMENSIONS: [&str; 7] = ["steps", "sourceReads", "rows", "bytes", "modelCalls", "inputTokens", "outputTokens"];
    let effects = world.pointer("/envelope/allowedEffects")?.as_array()?;
    let mut totals = [0_u64; DIMENSIONS.len()];
    for io in world.get("io")?.as_object()?.values() {
        let (required, free) = io_proof(io.get("kind")?.as_str()?, io.get("proof")?)?;
        if required.iter().any(|effect| !effects.iter().any(|allowed| allowed.as_str() == Some(*effect))) {
            return None;
        }
        let observation = io.get("observation")?;
        match observation.get("status")?.as_str()? {
            "not_sent" => {},
            "complete" if free => {
                for (index, dimension) in DIMENSIONS.iter().enumerate() {
                    let used = counter(observation.get("usage")?, dimension)?;
                    if used > counter(io.get("reservation")?, dimension)? { return None; }
                    totals[index] = totals[index].checked_add(used)?;
                }
            }
            _ => return None,
        }
    }
    let elapsed = run.get("finishedAtMs")?.as_u64()?.checked_sub(run.get("createdAtMs")?.as_u64()?)?;
    let mut actual = serde_json::Map::new();
    for (dimension, total) in DIMENSIONS.into_iter().zip(totals) {
        actual.insert(dimension.into(), json!(total.to_string()));
    }
    actual.insert("elapsed".into(), json!(elapsed.to_string()));
    actual.insert("cost".into(), Value::Null);
    Some(Value::Object(actual))
}

fn bounded(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn receipt(
    request: &InvestigationRequest,
    state: InvestigationState,
    sentness: InvestigationSentness,
) -> InvestigationReceipt {
    InvestigationReceipt {
        identity: request.identity.clone(),
        state,
        sentness,
        accepted: None,
        usage: InvestigationUsage::Unavailable,
    }
}
fn rejected(
    request: &InvestigationRequest,
    reason: InvestigationRejection,
) -> InvestigationReceipt {
    receipt(
        request,
        InvestigationState::Rejected { reason },
        InvestigationSentness::NotSent,
    )
}
fn invalid(request: &InvestigationRequest) -> InvestigationReceipt {
    rejected(request, InvestigationRejection::InvalidInput)
}
fn unknown(request: &InvestigationRequest) -> InvestigationReceipt {
    receipt(
        request,
        InvestigationState::Unknown,
        InvestigationSentness::MayHaveSent,
    )
}
fn unknown_accepted(
    request: &InvestigationRequest,
    accepted: Option<InvestigationAccepted>,
) -> InvestigationReceipt {
    let mut result = unknown(request);
    result.accepted = accepted;
    result
}
fn settlement_cause(
    cause: impl std::error::Error + Send + Sync + 'static,
) -> NativeVerificationError {
    NativeVerificationError::new(
        world_protocol::authorization::AuthorizationFailure::InternalFault,
        cause,
    )
}
fn settlement_invalid(message: &'static str) -> NativeVerificationError {
    settlement_cause(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        message,
    ))
}
fn transport_inspect(request: &InvestigationRequest, _error: &Error) -> InvestigationReceipt {
    unknown(request)
}
fn transport(request: &InvestigationRequest, error: &Error) -> InvestigationReceipt {
    let not_sent = error.delivery() == Delivery::NotSent
        || error
            .data()
            .is_some_and(|data| data["delivery"] == "notSent" || data["sentness"] == "notSent");
    if !not_sent {
        return unknown(request);
    }
    let reason = match error.kind() {
        "request_payload_conflict" => InvestigationRejection::RequestConflict,
        "investigation_exact_cost_basis_unavailable" => InvestigationRejection::UnsupportedBudget {
            dimensions: vec![BudgetDimension::Cost],
        },
        _ => InvestigationRejection::RuntimeRejected,
    };
    rejected(request, reason)
}
