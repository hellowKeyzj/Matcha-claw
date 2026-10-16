use crate::events::Event;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionUsage {
    session_id: String,
    agent_id: String,
    through_seq: u64,
    result_count: usize,
    coverage: &'static str,
    native_outcome_unknown: bool,
    usage: QueryUsage,
    instances: Vec<InstanceUsage>,
    budgets: Budgets,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryUsage {
    status: &'static str,
    scope: &'static str,
    value: Option<Tokens>,
    reason: Option<&'static str>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceUsage {
    instance_id: Option<String>,
    started_seq: Option<u64>,
    baseline_status: &'static str,
    result_count: usize,
    latest_result: Option<ResultRef>,
    total_cost_usd: Counter,
    model_usage: Counter,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultRef {
    seq: u64,
    run_id: Option<String>,
    at_ms: u64,
    subtype: String,
    is_error: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Counter {
    status: &'static str,
    scope: &'static str,
    value: Option<Value>,
    seq: Option<u64>,
    counter_reset_observed: bool,
    reason: Option<&'static str>,
    last_known: Option<Snapshot>,
}

#[derive(Serialize)]
struct Snapshot {
    value: Value,
    seq: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Budgets {
    limit_usd: Option<f64>,
    limit_status: &'static str,
    exceeded_results: Vec<ResultRef>,
    enforcement: &'static str,
}

pub(super) struct Projection {
    output: SessionUsage,
    tokens: Tokens,
    unknown: Option<&'static str>,
    seen: BTreeSet<(String, String)>,
}

impl Projection {
    pub(super) fn new(
        session_id: String,
        agent_id: String,
        through_seq: u64,
        native_outcome_unknown: bool,
    ) -> Self {
        Self {
            output: SessionUsage {
                session_id,
                agent_id,
                through_seq,
                result_count: 0,
                coverage: "observedDurableResultsOnly",
                native_outcome_unknown,
                usage: QueryUsage {
                    status: "unknown",
                    scope: "observedNativeQueries",
                    value: None,
                    reason: Some("no_native_result"),
                },
                instances: Vec::new(),
                budgets: Budgets {
                    limit_usd: None,
                    limit_status: "unknown",
                    exceeded_results: Vec::new(),
                    enforcement: "nativeOnly",
                },
            },
            tokens: Tokens::default(),
            unknown: None,
            seen: BTreeSet::new(),
        }
    }

    pub(super) fn observe(&mut self, event: Event) {
        if event.kind == "cli.started" {
            self.output.instances.push(InstanceUsage::new(
                event
                    .payload
                    .get("instanceId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                Some(event.seq),
            ));
            return;
        }
        if event.kind != "native.result" {
            return;
        }
        if self.output.instances.is_empty() {
            self.output.instances.push(InstanceUsage::new(None, None));
        }
        let instance = self.output.instances.last_mut().expect("instance exists");
        if let (Some(instance_id), Some(uuid)) = (
            instance.instance_id.as_ref().filter(|id| !id.is_empty()),
            event
                .payload
                .get("uuid")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty()),
        ) {
            if !self.seen.insert((instance_id.clone(), uuid.to_owned())) {
                return;
            }
        } else {
            self.unknown.get_or_insert("native_result_identity_missing");
        }
        instance.result_count += 1;
        self.output.result_count += 1;
        instance.latest_result = Some(result_ref(&event));
        let payload = &event.payload;
        if payload.get("session_id").and_then(Value::as_str)
            != Some(self.output.session_id.as_str())
        {
            self.unknown.get_or_insert("native_result_session_mismatch");
            instance
                .total_cost_usd
                .observe(None, event.seq, "native_result_session_mismatch");
            instance
                .model_usage
                .observe(None, event.seq, "native_result_session_mismatch");
            return;
        }
        if payload.get("subtype").and_then(Value::as_str) == Some("error_max_budget_usd") {
            self.output
                .budgets
                .exceeded_results
                .push(result_ref(&event));
        }
        // print.ts emits these zero/empty values when execution/load errors bypass QueryEngine.
        // They are placeholders, not evidence that no API cost or token usage occurred.
        let placeholder = error_placeholder(payload);
        instance.total_cost_usd.observe(
            if placeholder {
                None
            } else {
                payload
                    .get("total_cost_usd")
                    .filter(|value| nonnegative(value))
                    .cloned()
            },
            event.seq,
            if placeholder {
                "native_execution_error_placeholder"
            } else {
                "native_cost_missing_or_invalid"
            },
        );
        instance.model_usage.observe(
            if placeholder {
                None
            } else {
                model_usage(payload.get("modelUsage"))
            },
            event.seq,
            if placeholder {
                "native_execution_error_placeholder"
            } else {
                "native_model_usage_missing_or_invalid"
            },
        );
        let known_subtype = matches!(
            payload.get("subtype").and_then(Value::as_str),
            Some(
                "success"
                    | "error_during_execution"
                    | "error_max_turns"
                    | "error_max_budget_usd"
                    | "error_max_structured_output_retries"
            )
        );
        if placeholder {
            self.unknown
                .get_or_insert("native_execution_error_placeholder");
        } else if !known_subtype {
            self.unknown.get_or_insert("native_usage_scope_unknown");
        } else if let Some(tokens) = tokens(payload.get("usage")) {
            if self.tokens.add(tokens).is_none() {
                self.unknown.get_or_insert("native_usage_overflow");
            }
        } else {
            self.unknown
                .get_or_insert("native_usage_missing_or_invalid");
        }
    }

    pub(super) fn finish(mut self) -> SessionUsage {
        if self.output.result_count != 0 {
            self.output.usage.reason = self.unknown;
            if self.unknown.is_none() {
                self.output.usage.status = "available";
                self.output.usage.value = Some(self.tokens);
            }
        }
        self.output
    }
}

impl InstanceUsage {
    fn new(instance_id: Option<String>, started_seq: Option<u64>) -> Self {
        Self {
            instance_id,
            started_seq,
            baseline_status: "unknown",
            result_count: 0,
            latest_result: None,
            total_cost_usd: Counter::new(),
            model_usage: Counter::new(),
        }
    }
}

impl Counter {
    fn new() -> Self {
        Self {
            status: "unknown",
            scope: "nativeCumulative",
            value: None,
            seq: None,
            counter_reset_observed: false,
            reason: Some("no_native_result"),
            last_known: None,
        }
    }

    fn observe(&mut self, value: Option<Value>, seq: u64, reason: &'static str) {
        let previous = self
            .value
            .take()
            .zip(self.seq)
            .map(|(value, seq)| Snapshot { value, seq })
            .or_else(|| self.last_known.take());
        self.seq = Some(seq);
        if let Some(value) = value {
            if previous
                .as_ref()
                .is_some_and(|old| decreased(&old.value, &value))
            {
                self.counter_reset_observed = true;
            }
            self.status = "available";
            self.value = Some(value);
            self.reason = None;
            self.last_known = None;
        } else {
            self.status = "unknown";
            self.reason = Some(reason);
            self.last_known = previous;
        }
    }
}

impl Tokens {
    fn add(&mut self, other: Self) -> Option<()> {
        self.input_tokens = self.input_tokens.checked_add(other.input_tokens)?;
        self.output_tokens = self.output_tokens.checked_add(other.output_tokens)?;
        self.cache_read_input_tokens = self
            .cache_read_input_tokens
            .checked_add(other.cache_read_input_tokens)?;
        self.cache_creation_input_tokens = self
            .cache_creation_input_tokens
            .checked_add(other.cache_creation_input_tokens)?;
        Some(())
    }
}

fn result_ref(event: &Event) -> ResultRef {
    ResultRef {
        seq: event.seq,
        run_id: event.run_id.clone(),
        at_ms: event.at_ms,
        subtype: event
            .payload
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned(),
        is_error: event.payload.get("is_error").and_then(Value::as_bool),
    }
}

fn tokens(value: Option<&Value>) -> Option<Tokens> {
    let value = value?;
    Some(Tokens {
        input_tokens: value.get("input_tokens")?.as_u64()?,
        output_tokens: value.get("output_tokens")?.as_u64()?,
        cache_read_input_tokens: value.get("cache_read_input_tokens")?.as_u64()?,
        cache_creation_input_tokens: value.get("cache_creation_input_tokens")?.as_u64()?,
    })
}

pub(super) fn error_placeholder(value: &Value) -> bool {
    value.get("subtype").and_then(Value::as_str) == Some("error_during_execution")
        && [
            "duration_ms",
            "duration_api_ms",
            "num_turns",
            "total_cost_usd",
        ]
        .iter()
        .all(|field| value.get(*field).and_then(Value::as_f64) == Some(0.0))
        && value
            .get("modelUsage")
            .and_then(Value::as_object)
            .is_some_and(Map::is_empty)
        && tokens(value.get("usage")).is_some_and(|tokens| {
            tokens.input_tokens == 0
                && tokens.output_tokens == 0
                && tokens.cache_read_input_tokens == 0
                && tokens.cache_creation_input_tokens == 0
        })
}

fn nonnegative(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number >= 0.0)
}

fn model_usage(value: Option<&Value>) -> Option<Value> {
    let mut models = Map::new();
    for (model, usage) in value?.as_object()? {
        let mut projected = Map::new();
        for field in [
            "inputTokens",
            "outputTokens",
            "cacheReadInputTokens",
            "cacheCreationInputTokens",
            "webSearchRequests",
            "costUSD",
            "contextWindow",
            "maxOutputTokens",
        ] {
            let value = usage.get(field).filter(|value| nonnegative(value))?;
            projected.insert(field.to_owned(), value.clone());
        }
        models.insert(model.clone(), Value::Object(projected));
    }
    Some(Value::Object(models))
}

fn decreased(previous: &Value, current: &Value) -> bool {
    if let (Some(previous), Some(current)) = (previous.as_f64(), current.as_f64()) {
        return current < previous;
    }
    previous.as_object().is_some_and(|fields| {
        fields.iter().any(|(name, previous)| {
            if matches!(name.as_str(), "contextWindow" | "maxOutputTokens") {
                return false;
            }
            current
                .get(name)
                .is_none_or(|current| decreased(previous, current))
        })
    })
}
