use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use world::{
    InvestigationAccepted, InvestigationFuture, InvestigationReceipt, InvestigationRejection,
    InvestigationRequest, InvestigationSentness, InvestigationSettlementFuture, InvestigationState,
    InvestigationTerminal, InvestigationUsage, NativeVerificationError, WorldInvestigation,
};
use world_protocol::{api::InvestigationSelection, time::Timestamp};

use super::{WorldRuntimeHost, projection::canonical};
use crate::{
    driver::OpenClawDriver,
    gateway::{
        client::GatewayClient,
        delivery::MutationDelivery,
        wire::{self, GatewayResponse},
    },
    session::protocol::AgentScopedSessionKey,
};

struct Investigation {
    client: Arc<GatewayClient>,
    projection: WorldRuntimeHost,
}

impl OpenClawDriver {
    pub fn world_investigation(&self, projection: WorldRuntimeHost) -> Arc<dyn WorldInvestigation> {
        Arc::new(Investigation {
            client: self.gateway.client(),
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
            match self.mutate("chat.send", params).await {
                Delivery::Value(response) => self.reconcile(&request, response, true).await,
                Delivery::Rejected => rejected(&request, InvestigationRejection::RuntimeRejected),
                Delivery::NotSent => receipt(
                    &request,
                    InvestigationState::Unavailable,
                    InvestigationSentness::NotSent,
                ),
                Delivery::Unknown => unknown(&request),
            }
        })
    }

    fn inspect<'a>(&'a self, request: InvestigationRequest) -> InvestigationFuture<'a> {
        Box::pin(async move {
            if request.authority.require_request(&request).is_err() {
                return unknown(&request);
            }
            match self.lookup(&request).await {
                Some(response) => self.reconcile(&request, response, true).await,
                None => unknown(&request),
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
            let Some(response) = self.lookup(&request).await else {
                return unknown(&request);
            };
            let Some(checked) = checked(&request, &response) else {
                return unknown(&request);
            };
            if let Some(accepted) = &checked.accepted {
                if request.authority.attach_accepted(accepted, &checked.producer).is_err() {
                    return unknown(&request);
                }
            }
            let Some(mut params) = exact_target(&request) else {
                return invalid(&request);
            };
            params["runId"] = Value::String(checked.accepted.as_ref()
                .map(|accepted| accepted.accepted_run_id.clone())
                .unwrap_or_else(|| request.identity.native_request_id.clone()));
            params["requestId"] = Value::String(request.identity.native_request_id.clone());
            params["requestDigest"] = Value::String(checked.request_digest);
            let result = match self.mutate("chat.abort", params).await {
                Delivery::Value(response) => self.reconcile(&request, response, false).await,
                _ => unknown(&request),
            };
            if checked.accepted.is_some() && result.accepted != checked.accepted {
                return unknown_accepted(&request, checked.accepted);
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
            let mut params = exact_target(&request)
                .ok_or_else(|| settlement_invalid("native settlement target is invalid"))?;
            params["requestId"] = Value::String(request.identity.native_request_id.clone());
            let rpc = wire::rpc_request(
                crate::gateway::operation::next_request_id("world-investigation-settlement-lookup"),
                "chat.run.getByRequest",
                Some(params.clone()),
            )
            .map_err(settlement_cause)?;
            let response = match self.client.rpc_query(rpc).await.map_err(settlement_cause)? {
                GatewayResponse::Success {
                    payload: Some(payload),
                    ..
                } => payload,
                GatewayResponse::Failure { error, .. } => return Err(native_failure(error)),
                _ => return Err(settlement_invalid("native lookup response was missing")),
            };
            if response
                .get("worldInvestigation")
                .is_some_and(Value::is_null)
            {
                request.authority.require_not_sent_settlement(&request)?;
                return Ok(());
            }
            let verified = checked(&request, &response)
                .ok_or_else(|| settlement_invalid("native settlement identity changed"))?;
            if let Some(accepted) = &verified.accepted {
                request.authority.attach_accepted(accepted, &verified.producer)?;
                params["correlation"] = serde_json::to_value(accepted).map_err(settlement_cause)?;
            } else {
                request.authority.require_not_sent_settlement(&request)?;
                if !matches!(map_response(&request, &response).state,
                    InvestigationState::Rejected { reason: InvestigationRejection::StartRejected })
                {
                    return Err(settlement_invalid("native input was not proven never sent"));
                }
            }
            params["requestDigest"] = Value::String(verified.request_digest.clone());
            params["settledAtMs"] =
                json!(u64::try_from(settled_at.unix_millis()).map_err(settlement_cause)?);
            let rpc = wire::rpc_request(
                crate::gateway::operation::next_request_id("world-investigation-settle"),
                "chat.run.settleInvestigation",
                Some(params),
            )
            .map_err(settlement_cause)?;
            let response = match self.client.rpc_mutation(rpc).await {
                MutationDelivery::Response(GatewayResponse::Success {
                    payload: Some(payload),
                    ..
                }) => payload,
                MutationDelivery::Response(GatewayResponse::Failure { error, .. }) => {
                    return Err(native_failure(error));
                }
                MutationDelivery::NotWritten(error) | MutationDelivery::MayHaveReached(error) => {
                    return Err(settlement_cause(error));
                }
                _ => return Err(settlement_invalid("native settlement response was missing")),
            };
            let confirmed = checked(&request, &response)
                .ok_or_else(|| settlement_invalid("native settled identity changed"))?;
            if confirmed.accepted != verified.accepted
                || confirmed.request_digest != verified.request_digest
                || response
                    .pointer("/worldInvestigation/settledAtMs")
                    .and_then(Value::as_u64)
                    .is_none()
                || !matches!(
                    map_response(&request, &response).state,
                    InvestigationState::Terminal { .. }
                        | InvestigationState::Rejected { reason: InvestigationRejection::StartRejected }
                )
            {
                return Err(settlement_invalid("native settlement was not acknowledged"));
            }
            Ok(())
        })
    }
}

enum Delivery {
    Value(Value),
    Rejected,
    NotSent,
    Unknown,
}

impl Investigation {
    async fn mutate(&self, method: &str, params: Value) -> Delivery {
        let Ok(request) = wire::rpc_request(crate::gateway::operation::next_request_id(method), method, Some(params))
        else {
            return Delivery::NotSent;
        };
        match self.client.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Success {
                payload: Some(payload),
                ..
            }) => Delivery::Value(payload),
            MutationDelivery::Response(GatewayResponse::Failure { error, .. })
                if error.code() == "WORLD_INVESTIGATION_NOT_SENT" =>
            {
                Delivery::Rejected
            }
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => Delivery::Unknown,
            MutationDelivery::NotWritten(_) => Delivery::NotSent,
            _ => Delivery::Unknown,
        }
    }

    async fn lookup(&self, request: &InvestigationRequest) -> Option<Value> {
        let mut params = exact_target(request)?;
        params["requestId"] = Value::String(request.identity.native_request_id.clone());
        let rpc = wire::rpc_request(
            crate::gateway::operation::next_request_id("world-investigation-lookup"),
            "chat.run.getByRequest",
            Some(params),
        )
        .ok()?;
        match self.client.rpc_query(rpc).await.ok()? {
            GatewayResponse::Success {
                payload: Some(payload),
                ..
            } => Some(payload),
            _ => None,
        }
    }

    async fn reconcile(
        &self,
        request: &InvestigationRequest,
        mut response: Value,
        release: bool,
    ) -> InvestigationReceipt {
        let Some(checked) = checked(request, &response) else {
            return unknown(request);
        };
        if let Some(accepted) = &checked.accepted {
            if request.authority.attach_accepted(accepted, &checked.producer).is_err() {
                return unknown(request);
            }
        }
        if release
            && checked.accepted.is_some()
            && response
                .pointer("/worldInvestigation/phase")
                .and_then(Value::as_str)
                == Some("held")
        {
            match request.authority.may_release().await {
                Ok(true) => {
                    let Some(mut params) = exact_target(request) else {
                        return invalid(request);
                    };
                    params["requestId"] = Value::String(request.identity.native_request_id.clone());
                    params["requestDigest"] = Value::String(checked.request_digest);
                    params["correlation"] = serde_json::to_value(&checked.accepted)
                        .expect("native correlation is JSON");
                    response = match self.mutate("chat.run.releaseInvestigation", params).await {
                        Delivery::Value(response) => response,
                        _ => return unknown_accepted(request, checked.accepted),
                    };
                }
                Ok(false) => {}
                Err(_) => return unknown_accepted(request, checked.accepted),
            }
        }
        let result = map_response(request, &response);
        if checked.accepted.is_some() && result.accepted != checked.accepted {
            return unknown_accepted(request, checked.accepted);
        }
        result
    }
}

struct Checked {
    accepted: Option<InvestigationAccepted>,
    producer: String,
    request_digest: String,
}

fn exact_target(request: &InvestigationRequest) -> Option<Value> {
    match &request.identity.selection {
        InvestigationSelection::Openclaw {
            agent_id,
            session_key,
            native_session_id,
        } => {
            let session = AgentScopedSessionKey::try_parse(session_key).ok()?;
            if session.agent_id() != agent_id.as_str() {
                return None;
            }
            Some(json!({"agentId":agent_id,"sessionKey":session_key,"sessionId":native_session_id}))
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
    let mut target = exact_target(request)?;
    if hash(json!({"budget":null,"content":request.execution_prompt}))?.as_str()
        != request.identity.content_budget_digest.as_str()
    {
        return None;
    }
    target["message"] = Value::String(request.execution_prompt.clone());
    target["idempotencyKey"] = Value::String(request.identity.native_request_id.clone());
    target["suppressCommandInterpretation"] = Value::Bool(true);
    target["worldInvestigation"] = json!({
        "version":1,"bindingId":request.identity.binding_id,"allowedEffects":request.allowed_effects,
        "budget":request.budget,"issuedAtMs":u64::try_from(request.created_at.unix_millis()).ok()?,
        "expiresAtMs":deadline(request)?,
    });
    Some(target)
}

fn checked(request: &InvestigationRequest, response: &Value) -> Option<Checked> {
    let facts = response
        .get("worldInvestigation")
        .filter(|value| value.is_object())?;
    let accepted_params = facts.get("acceptedParams")?;
    let mut expected = parameters(request)?;
    expected["worldInvestigation"]["producer"] = accepted_params
        .pointer("/worldInvestigation/producer")?
        .clone();
    if &expected != accepted_params {
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
    if facts["version"] != 1
        || facts["requestDigest"].as_str() != Some(request_digest.as_str())
        || facts["deadlineMs"].as_u64()? > deadline(request)?
    {
        return None;
    }
    let accepted = match facts.get("accepted")? {
        Value::Null => None,
        value => {
            let accepted: InvestigationAccepted = serde_json::from_value(value.clone()).ok()?;
            if accepted.binding_id != request.identity.binding_id
                || accepted.accepted_request_id != request.identity.native_request_id
                || accepted.content_budget_digest != request.identity.content_budget_digest
                || [
                    &accepted.accepted_request_id,
                    &accepted.accepted_run_id,
                    &accepted.accepted_input_id,
                    &accepted.native_attempt_id,
                    &accepted.native_instance_id,
                ]
                .into_iter()
                .any(|value| !bounded(value))
            {
                return None;
            }
            Some(accepted)
        }
    };
    Some(Checked {
        accepted,
        producer: producer.to_owned(),
        request_digest,
    })
}

fn map_response(request: &InvestigationRequest, response: &Value) -> InvestigationReceipt {
    let Some(checked) = checked(request, response) else {
        return unknown(request);
    };
    let facts = &response["worldInvestigation"];
    let mut result = receipt(
        request,
        InvestigationState::Accepted,
        InvestigationSentness::MayHaveSent,
    );
    result.accepted = checked.accepted;
    if facts["phase"] == "held" {
        result.state = InvestigationState::Pending;
    }
    // Terminal is a native stop/join fact, not a chat.abort acknowledgement or an accumulated usage value.
    if facts["phase"] != "terminal"
        || facts["childrenJoined"] != true
        || facts["pendingIo"] != 0
        || facts.pointer("/facts/ownership").and_then(Value::as_str) != Some("native_exclusive")
        || facts.pointer("/facts/inputScope").and_then(Value::as_str) != Some("whole_input")
        || facts
            .pointer("/facts/nativeStopped")
            .and_then(Value::as_bool)
            != Some(true)
        || facts
            .pointer("/facts/ownershipConfirmed")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return result;
    }
    if result.accepted.is_none() {
        return if never_sent(facts) {
            rejected(request, InvestigationRejection::StartRejected)
        } else {
            result
        };
    }
    let terminal = match facts
        .pointer("/facts/terminal/status")
        .and_then(Value::as_str)
    {
        Some("completed" | "succeeded") => InvestigationTerminal::Completed,
        Some("cancelled" | "aborted") => InvestigationTerminal::Cancelled,
        Some("failed") => InvestigationTerminal::Failed,
        Some("interrupted") => InvestigationTerminal::Interrupted,
        _ => return result,
    };
    result.state = InvestigationState::Terminal { status: terminal };
    if facts.pointer("/facts/coverage").and_then(Value::as_str) == Some("complete")
        && facts.pointer("/usage/kind").and_then(Value::as_str) == Some("complete")
    {
        if let Some(usage) = facts
            .pointer("/usage/usage")
            .cloned()
            .and_then(|value| serde_json::from_value::<world_protocol::budget::Usage>(value).ok())
            .filter(|usage| usage.cost.is_some())
        {
            result.usage = InvestigationUsage::Complete { usage };
        }
    }
    result
}

fn never_sent(receipt: &Value) -> bool {
    const DIMENSIONS: [&str; 7] = [
        "steps", "sourceReads", "rows", "bytes", "modelCalls", "inputTokens", "outputTokens",
    ];
    receipt.get("accepted").is_some_and(Value::is_null)
        && receipt["inputDelivery"] == "not_started"
        && receipt.pointer("/facts/coverage").and_then(Value::as_str) == Some("unknown")
        && receipt.pointer("/usage/kind").and_then(Value::as_str) == Some("unavailable")
        && receipt.pointer("/facts/io").and_then(Value::as_array).is_some_and(Vec::is_empty)
        && ["actual", "reserved"].into_iter().all(|field| {
            receipt["facts"].get(field).and_then(Value::as_object).is_some_and(|counters| {
                counters.iter().all(|(dimension, value)| {
                    if field == "actual" && dimension == "elapsed" {
                        value.as_str().is_some_and(|value| {
                            value.parse::<u64>().is_ok_and(|elapsed| elapsed.to_string() == value)
                        })
                    } else {
                        DIMENSIONS.contains(&dimension.as_str()) && value.as_str() == Some("0")
                    }
                })
            })
        })
}

struct NativeFailure(wire::GatewayError);
impl std::fmt::Debug for NativeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeFailure")
            .field("code", &self.0.code())
            .field("message", &self.0.message())
            .finish()
    }
}
impl std::fmt::Display for NativeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("native World settlement was rejected")
    }
}
impl std::error::Error for NativeFailure {}
fn native_failure(error: wire::GatewayError) -> NativeVerificationError {
    settlement_cause(NativeFailure(error))
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
