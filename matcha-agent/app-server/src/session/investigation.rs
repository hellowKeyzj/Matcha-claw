use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::rpc;

use super::run;

const DIMENSIONS: [&str; 7] = [
    "steps", "sourceReads", "rows", "bytes", "modelCalls", "inputTokens", "outputTokens",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Envelope {
    pub version: u32,
    pub binding_id: String,
    pub allowed_effects: Vec<String>,
    pub budget: Value,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub producer: Producer,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Producer {
    pub runtime_instance: String,
    pub mac: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Correlation {
    pub binding_id: String,
    pub accepted_request_id: String,
    pub accepted_run_id: String,
    pub accepted_input_id: String,
    pub content_budget_digest: String,
    pub native_attempt_id: String,
    pub native_instance_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Investigation {
    pub envelope: Envelope,
    pub request_digest: String,
    pub accepted_params: Value,
    pub deadline_ms: u64,
    pub native_attempt_id: Option<String>,
    pub native_instance_id: Option<String>,
    pub dispatch_state: String,
    #[serde(default = "unknown_delivery")]
    pub input_delivery: String,
    pub io: BTreeMap<String, Io>,
    pub receipt: Option<Value>,
    #[serde(default)]
    pub settled_at_ms: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Io {
    pub admission_digest: String,
    pub kind: String,
    pub reservation: Value,
    pub proof: Value,
    pub observation: Option<Value>,
}

fn unknown_delivery() -> String { "may_have_sent".into() }

pub(super) fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(object.iter()
            .map(|(key, value)| (key.clone(), canonical(value)))
            .collect::<BTreeMap<_, _>>().into_iter().collect()),
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        value => value.clone(),
    }
}

pub(super) fn digest(value: &Value) -> rpc::Result<String> {
    let bytes = serde_json::to_vec(&canonical(value))
        .map_err(|error| rpc::Error::internal("investigation_digest").with_source(error))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub(super) fn request_digest(params: &Value) -> rpc::Result<String> {
    let mut signed = params.clone();
    signed.pointer_mut("/worldInvestigation/producer")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| denied("investigation_producer_invalid"))?
        .remove("mac");
    digest(&signed)
}

fn integer(value: &Value) -> rpc::Result<u64> {
    let text = value.as_str().ok_or_else(|| denied("investigation_integer_invalid"))?;
    if text.is_empty() || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(denied("investigation_integer_invalid"));
    }
    text.parse().map_err(|_| denied("investigation_integer_invalid"))
}

fn counter(value: &Value, field: &str) -> rpc::Result<u64> {
    integer(value.get(field).ok_or_else(|| denied("investigation_dimension_missing"))?)
}

fn maximum<'a>(budget: &'a Value, dimension: &str) -> &'a Value {
    let field = match dimension {
        "steps" => "maxSteps", "sourceReads" => "maxSourceReads", "rows" => "maxRows",
        "bytes" => "maxBytes", "modelCalls" => "maxModelCalls", "inputTokens" => "maxInputTokens",
        "outputTokens" => "maxOutputTokens", _ => unreachable!(),
    };
    &budget[field]
}

pub(super) fn denied(reason: &str) -> rpc::Error {
    rpc::Error::new(-32007, reason, "World investigation admission was rejected")
        .with_data(json!({"delivery":"notSent"}))
}

fn required_effects(kind: &str, proof: &Value) -> rpc::Result<&'static [&'static str]> {
    let (effect, required): (&str, &'static [&'static str]) = match kind {
        "loop" if proof["producer"] == "query_loop" => return Ok(&[]),
        "model" if proof["producer"] == "matcha_model_transport" => {
            ("probabilistic", &["probabilistic"])
        }
        // These are native entry minima; World still authorizes the complete current impact.
        "tool" => match proof["toolName"].as_str() {
            Some("StructuredOutput") if proof["producer"] == "matcha_structured_output" => ("pure", &["pure"]),
            Some("Read") if proof["producer"] == "matcha_builtin_read" => ("source_read", &["source_read"]),
            Some("world_discover" | "world_query" | "world_explain" | "world_action_status") => {
                ("source_read", &["source_read"])
            }
            Some("world_observe" | "world_change_propose" | "world_branch_test") => ("pure", &["pure"]),
            Some("world_action_propose") => ("source_read", &["pure", "source_read"]),
            Some("world_action_submit") => ("external_write", &["external_write"]),
            _ => return Err(denied("investigation_tool_proof_invalid")),
        },
        "source" => match (proof["producer"].as_str(), proof["operation"].as_str()) {
            (Some("matcha_local_source"), Some("directory_read" | "stat" | "lstat" | "realpath" | "readlink"))
            | (Some("bounded_regular_file"), Some("file_read"))
            | (Some("matcha_model_transport"), Some("input_token_count"))
            | (Some("matcha_sealed_skill"), Some("catalog_read" | "content_read"))
            | (Some("matcha_files_api"), Some("file_download" | "file_list" | "file_stage"))
            | (Some("matcha_inbound_attachment"), Some("attachment_download" | "attachment_stage")) => {
                ("source_read", &["source_read"])
            }
            (Some("matcha_files_api"), Some("file_upload"))
            | (Some("matcha_http_hook"), Some("http_post")) => {
                ("external_write", &["external_write", "source_read"])
            }
            _ => return Err(denied("investigation_source_proof_invalid")),
        },
        _ => return Err(denied("investigation_proof_invalid")),
    };
    if proof["effect"].as_str() != Some(effect) {
        return Err(denied("investigation_effect_proof_invalid"));
    }
    Ok(required)
}

fn exact_input_receipt<'a>(correlation: Option<&Correlation>, result: Option<&'a Value>) -> Option<&'a Value> {
    let identity = correlation?;
    let receipt = result?.get("native_input_receipt")?;
    (receipt["correlation"] == json!(identity)
        && receipt["scope"] == "accepted_input" && receipt["coverage"] == "native_exclusive"
        && receipt["childrenJoined"] == true && receipt["pendingIo"] == "0").then_some(receipt)
}

fn free_io(kind: &str, proof: &Value) -> bool {
    match kind {
        "loop" => proof["producer"] == "query_loop",
        "tool" => matches!(proof["toolName"].as_str(), Some("StructuredOutput" | "Read")),
        "source" => matches!((proof["producer"].as_str(), proof["operation"].as_str()),
            (Some("bounded_regular_file"), Some("file_read"))
            | (Some("matcha_local_source"), Some("directory_read" | "stat" | "lstat" | "realpath" | "readlink"))),
        _ => false,
    }
}

impl super::Sessions {
    pub(super) async fn prepared_investigation(&self, run: run::Run) -> rpc::Result<run::Run> {
        if run.world_investigation.is_none() || run.status.terminal() { return Ok(run); }
        let session = self.stored_session(&run.session_id).await?;
        loop {
            let changed = session.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let stored = super::record::get_run(&self.0.database, &run.run_id).await?;
            if let Some(error) = &session.data.lock().await.storage_fault { return Err(error.clone()); }
            if stored.run.status.terminal() || stored.run.world_investigation.as_ref()
                .is_some_and(|world| world.correlation(&stored.run).is_some())
            {
                return Ok(stored.run);
            }
            changed.await;
        }
    }

    pub(super) async fn investigation_control_locked(
        &self,
        execution: &mut super::Execution,
        instance_id: &str,
        request: &Value,
    ) -> rpc::Result<Value> {
        let supplied: Correlation = serde_json::from_value(request["correlation"].clone())
            .map_err(|_| denied("investigation_correlation_invalid"))?;
        let active = execution.active.as_ref().ok_or_else(|| denied("investigation_input_inactive"))?;
        let expected = active.record.run.world_investigation.as_ref()
            .and_then(|world| world.correlation(&active.record.run))
            .ok_or_else(|| denied("investigation_input_unbound"))?;
        if supplied != expected || supplied.native_instance_id != instance_id
            || !active.input_started || active.ownership_ambiguous
        {
            return Err(denied("investigation_correlation_mismatch"));
        }
        let observing = request["subtype"] == "native_io_observe";
        if !observing && (active.record.run.cancel_requested_at_ms.is_some()
            || execution.closing || execution.storage_fault.is_some())
        {
            return Err(denied("investigation_cancelled"));
        }
        let mut updated = active.record.clone();
        let world = updated.run.world_investigation.as_mut().expect("World scope checked");
        let response = if observing { world.observe(request)? } else {
            world.input_delivery = "may_have_sent".into();
            world.admit(request, rpc::now_ms())?
        };
        self.save_run_locked(execution, &updated).await?;
        execution.active.as_mut().expect("locked active Run").record = updated;
        Ok(response)
    }
}

impl Investigation {
    pub fn accept(envelope: Envelope, request_digest: String, accepted_params: Value, now: u64) -> rpc::Result<Self> {
        if envelope.version != 1 || envelope.binding_id.is_empty()
            || envelope.issued_at_ms > now || envelope.expires_at_ms <= now
            || envelope.allowed_effects.iter().any(|effect| !matches!(effect.as_str(),
                "pure" | "source_read" | "clock_read" | "probabilistic" | "external_write"))
        {
            return Err(denied("investigation_envelope_invalid"));
        }
        let budget = envelope.budget.as_object().ok_or_else(|| denied("investigation_budget_invalid"))?;
        if budget.keys().any(|key| !matches!(key.as_str(), "maxWallTime" | "maxSteps"
            | "maxSourceReads" | "maxRows" | "maxBytes" | "maxModelCalls" | "maxInputTokens"
            | "maxOutputTokens" | "maxCost" | "deadline"))
        {
            return Err(denied("investigation_budget_invalid"));
        }
        for dimension in DIMENSIONS { integer(maximum(&envelope.budget, dimension))?; }
        let wall = integer(&envelope.budget["maxWallTime"])?;
        let mut deadline_ms = now.checked_add(wall).ok_or_else(|| denied("investigation_deadline_invalid"))?
            .min(envelope.expires_at_ms);
        if let Some(deadline) = envelope.budget.get("deadline").filter(|value| !value.is_null()) {
            let parsed = chrono::DateTime::parse_from_rfc3339(deadline.as_str()
                .ok_or_else(|| denied("investigation_deadline_invalid"))?)
                .map_err(|_| denied("investigation_deadline_invalid"))?.timestamp_millis();
            deadline_ms = deadline_ms.min(u64::try_from(parsed)
                .map_err(|_| denied("investigation_deadline_invalid"))?);
        }
        if deadline_ms <= now { return Err(denied("investigation_deadline_exceeded")); }
        if envelope.budget.get("maxCost").is_some_and(|value| !value.is_null()) {
            // The native provider binding currently has no immutable tariff authority.
            return Err(denied("investigation_exact_cost_basis_unavailable"));
        }
        Ok(Self { envelope, request_digest, accepted_params, deadline_ms, native_attempt_id: None,
            native_instance_id: None, dispatch_state: "held".into(), input_delivery: "not_started".into(), io: BTreeMap::new(), receipt: None, settled_at_ms: None })
    }

    pub fn correlation(&self, run: &run::Run) -> Option<Correlation> {
        Some(Correlation {
            binding_id: self.envelope.binding_id.clone(),
            accepted_request_id: run.request_id.clone()?, accepted_run_id: run.run_id.clone(),
            accepted_input_id: run.message_id.clone(), content_budget_digest: format!("sha256:{}", run.content_budget_digest.as_ref()?),
            native_attempt_id: self.native_attempt_id.clone()?, native_instance_id: self.native_instance_id.clone()?,
        })
    }

    pub fn frame(&self, run: &run::Run) -> rpc::Result<Value> {
        Ok(json!({"correlation":self.correlation(run).ok_or_else(|| denied("investigation_dispatch_unbound"))?,
            "allowedEffects":self.envelope.allowed_effects,"budget":self.envelope.budget,
            "deadlineMs":self.deadline_ms,"requestDigest":self.request_digest}))
    }

    pub fn remaining(&self) -> rpc::Result<Value> {
        let mut remaining = serde_json::Map::new();
        for dimension in DIMENSIONS {
            let mut occupied = 0_u64;
            for io in self.io.values() {
                let used = match io.observation.as_ref() {
                    Some(observed) if observed["status"] == "not_sent" => 0,
                    Some(observed) if observed["status"] == "complete" => counter(&observed["usage"], dimension)?,
                    _ => counter(&io.reservation, dimension)?,
                };
                occupied = occupied.checked_add(used).ok_or_else(|| denied("investigation_budget_exceeded"))?;
            }
            let available = integer(maximum(&self.envelope.budget, dimension))?.checked_sub(occupied)
                .ok_or_else(|| denied("investigation_budget_exceeded"))?;
            remaining.insert(dimension.into(), json!(available.to_string()));
        }
        Ok(Value::Object(remaining))
    }

    pub fn admit(&mut self, request: &Value, now: u64) -> rpc::Result<Value> {
        let io_id = request.get("ioId").and_then(Value::as_str)
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .ok_or_else(|| denied("investigation_io_invalid"))?;
        let admission_digest = digest(request)?;
        if let Some(existing) = self.io.get(io_id) {
            if existing.admission_digest != admission_digest {
                return Err(denied("investigation_io_conflict"));
            }
            return Ok(json!({"ioId":io_id,"admissionDigest":admission_digest,"remaining":self.remaining()?}));
        }
        if now >= self.deadline_ms { return Err(denied("investigation_deadline_exceeded")); }
        let kind = request.get("kind").and_then(Value::as_str)
            .filter(|kind| matches!(*kind, "model" | "loop" | "tool" | "source"))
            .ok_or_else(|| denied("investigation_io_kind_invalid"))?;
        let reservation = request.get("reservation").filter(|value| value.is_object())
            .ok_or_else(|| denied("investigation_reservation_invalid"))?;
        let proof = request.get("proof").filter(|value| value.is_object())
            .ok_or_else(|| denied("investigation_proof_invalid"))?;
        if required_effects(kind, proof)?.iter().any(|required| {
            !self.envelope.allowed_effects.iter().any(|effect| effect.as_str() == *required)
        }) {
            return Err(denied("investigation_effect_denied"));
        }
        if kind == "model" {
            let prepared = request.get("preparedRequestDigest").and_then(Value::as_str)
                .filter(|digest| digest.starts_with("sha256:") && digest.len() == 71)
                .ok_or_else(|| denied("investigation_prepared_digest_invalid"))?;
            if proof.pointer("/inputCount/requestDigest").and_then(Value::as_str) != Some(prepared)
                || proof.pointer("/inputCount/exact").and_then(Value::as_bool) != Some(true)
                || counter(reservation, "modelCalls")? != 1
                || integer(&proof["inputCount"]["tokens"])? != counter(reservation, "inputTokens")?
                || integer(&proof["outputCap"])? != counter(reservation, "outputTokens")?
                || integer(&proof["outputCap"])? == 0
                || proof.get("outputCapEnforced").and_then(Value::as_bool) != Some(true)
            {
                return Err(denied("investigation_model_proof_invalid"));
            }
        }
        let remaining = self.remaining()?;
        for dimension in DIMENSIONS {
            if counter(reservation, dimension)? > counter(&remaining, dimension)? {
                return Err(denied("investigation_budget_exceeded"));
            }
        }
        self.io.insert(io_id.to_owned(), Io { admission_digest: admission_digest.clone(), kind: kind.into(),
            reservation: reservation.clone(), proof: proof.clone(), observation: None });
        Ok(json!({"ioId":io_id,"admissionDigest":admission_digest,"remaining":self.remaining()?}))
    }

    pub fn observe(&mut self, request: &Value) -> rpc::Result<Value> {
        let io_id = request.get("ioId").and_then(Value::as_str)
            .ok_or_else(|| denied("investigation_io_invalid"))?;
        let io = self.io.get_mut(io_id).ok_or_else(|| denied("investigation_io_not_admitted"))?;
        let observed = request.get("observation").filter(|value| value.is_object())
            .ok_or_else(|| denied("investigation_observation_invalid"))?;
        if let Some(existing) = &io.observation {
            if existing != observed { return Err(denied("investigation_observation_conflict")); }
        } else {
            match observed["status"].as_str() {
                Some("complete") => {
                    for dimension in DIMENSIONS {
                        if counter(&observed["usage"], dimension)? > counter(&io.reservation, dimension)? {
                            return Err(denied("investigation_observation_exceeds_reservation"));
                        }
                    }
                    if io.kind == "model" && !observed.get("rawUsage").is_some_and(Value::is_object) {
                        return Err(denied("investigation_raw_usage_missing"));
                    }
                }
                Some("unknown" | "not_sent") => {}
                _ => return Err(denied("investigation_observation_invalid")),
            }
            io.observation = Some(observed.clone());
        }
        Ok(json!({"ioId":io_id,"observed":true,"remaining":self.remaining()?}))
    }

    pub fn free_usage(&self, correlation: Option<&Correlation>, result: Option<&Value>, elapsed: u64) -> Option<Value> {
        let input = exact_input_receipt(correlation, result)?;
        let receipt = self.receipt.as_ref()?;
        if self.envelope.budget.get("maxCost").is_some_and(|value| !value.is_null())
            || !input.get("unavailable").and_then(Value::as_array).is_some_and(Vec::is_empty)
            || self.input_delivery != "may_have_sent" || receipt["inputDelivery"] != self.input_delivery
            || receipt["correlation"] != json!(correlation?)
            || receipt["scope"] != "accepted_input" || receipt["coverage"] != "native_exclusive"
            || receipt["nativeStopped"] != true || receipt["ownershipConfirmed"] != true
            || receipt["childrenJoined"] != true || receipt["pendingIo"] != "0"
        {
            return None;
        }
        let mut totals = [0_u64; DIMENSIONS.len()];
        for io in self.io.values() {
            let required = required_effects(&io.kind, &io.proof).ok()?;
            if required.iter().any(|effect| !self.envelope.allowed_effects.iter().any(|allowed| allowed.as_str() == *effect)) {
                return None;
            }
            let observation = io.observation.as_ref()?;
            match observation["status"].as_str()? {
                "not_sent" => {},
                "complete" if free_io(&io.kind, &io.proof) => {
                    for (index, dimension) in DIMENSIONS.iter().enumerate() {
                        let used = counter(&observation["usage"], dimension).ok()?;
                        if used > counter(&io.reservation, dimension).ok()? { return None; }
                        totals[index] = totals[index].checked_add(used)?;
                    }
                }
                _ => return None,
            }
        }
        let mut actual = serde_json::Map::new();
        for (dimension, total) in DIMENSIONS.into_iter().zip(totals) {
            actual.insert(dimension.into(), json!(total.to_string()));
        }
        actual.insert("elapsed".into(), json!(elapsed.to_string()));
        actual.insert("cost".into(), Value::Null);
        Some(Value::Object(actual))
    }

    pub fn finish(&mut self, correlation: Option<Correlation>, result: Option<&Value>) {
        let pending = self.io.values().filter(|io| io.observation.as_ref()
            .is_none_or(|value| !matches!(value["status"].as_str(), Some("complete" | "not_sent")))).count();
        let exact_input = exact_input_receipt(correlation.as_ref(), result).is_some();
        let not_started = self.input_delivery == "not_started" && self.io.is_empty();
        // Free usage is finalized only after the native stop and ownership facts are known.
        let mut receipt = json!({"scope":"accepted_input","coverage":"native_exclusive",
            "correlation":correlation,"pendingIo":pending.to_string(),"childrenJoined":exact_input || not_started,
            "inputDelivery":self.input_delivery,"nativeStopped":not_started,"ownershipConfirmed":not_started,
            "usage":{"coverage":"unavailable","reason":"exact_cost_basis_unavailable"}});
        receipt["receiptDigest"] = json!(digest(&receipt).expect("native receipt contains only JSON values"));
        self.receipt = Some(receipt);
    }
}
