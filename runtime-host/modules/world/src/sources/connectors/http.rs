use super::{SourceCredential, SourceError, metadata::ReadMetadata, values};
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url};
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension,
    failure::FailureStage,
    sources::*,
    time::{DurationMs, Timestamp},
};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub(super) async fn read(
    metadata: &ReadMetadata,
    plan: &SourceReadPlan,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
    budget: &crate::extensions::invocation::CallBudget,
) -> Result<SourcePage, SourceError> {
    if let Some(error) = interruption(&cancel, deadline) {
        return Err(error);
    }
    budget.check().map_err(super::budget_error)?;
    let SourceConnectionConfig::HttpJson(config) = &metadata.connection.config else {
        return Err(invalid("connection", SourcePlanReason::InvalidValue));
    };
    let resource = config
        .resources
        .iter()
        .find(|resource| resource.id == plan.resource)
        .ok_or_else(|| invalid("resource", SourcePlanReason::UnknownResource))?;
    if resource.key.is_empty() {
        return Err(invalid("key", SourcePlanReason::InvalidKey));
    }
    if plan.as_of.is_some() && !metadata.binding.body.capabilities.historical_read {
        return Err(SourceError::new(
            SourceFailure::HistoryUnavailable,
            FailureStage::Read,
        ));
    }
    if plan.predicate.is_some() && !metadata.binding.body.capabilities.predicate_pushdown {
        return Err(invalid(
            "predicate",
            SourcePlanReason::CapabilityNotDeclared,
        ));
    }
    if !plan.order.is_empty() && !metadata.binding.body.capabilities.ordering_pushdown {
        return Err(invalid("order", SourcePlanReason::CapabilityNotDeclared));
    }
    let origin = Url::parse(&config.origin)
        .map_err(|_| invalid("origin", SourcePlanReason::InvalidEndpoint))?;
    if !matches!(origin.scheme(), "http" | "https")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.host_str().is_none()
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err(invalid("origin", SourcePlanReason::InvalidEndpoint));
    }
    let pushdown = plan.predicate.is_some() || !plan.order.is_empty();
    let path = if pushdown {
        config
            .query_path
            .as_deref()
            .ok_or_else(|| invalid("queryPath", SourcePlanReason::CapabilityNotDeclared))?
    } else {
        &config.read_path
    };
    let mut url = origin
        .join(path)
        .map_err(|_| invalid("readPath", SourcePlanReason::InvalidEndpoint))?;
    if origin.origin() != url.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid("readPath", SourcePlanReason::InvalidEndpoint));
    }
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(30)),
        )
        .timeout(deadline.saturating_duration_since(Instant::now()))
        .build()
        .map_err(|cause| {
            SourceError::caused_by(SourceFailure::Connection, FailureStage::Prepare, cause)
        })?;
    let mut request = if pushdown {
        let bytes = world_protocol::wire::encode(plan, world_protocol::api::MAX_REQUEST_BYTES)
            .map_err(|_| invalid("plan", SourcePlanReason::InvalidValue))?;
        client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes)
    } else {
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("resource", &plan.resource)
                .append_pair("limit", &plan.limit.to_string());
            for field in &plan.fields {
                query.append_pair("field", field);
            }
            if let Some(continuation) = &plan.continuation {
                query.append_pair("continuation", continuation);
            }
            if let Some(as_of) = &plan.as_of {
                query.append_pair("asOf", as_of.as_str());
            }
        }
        client.get(url)
    };
    request = match credential {
        SourceCredential::None => request,
        SourceCredential::HttpBearer(token) => request.bearer_auth(token.as_str()),
        SourceCredential::Postgres { .. } => {
            return Err(SourceError::new(
                SourceFailure::Authentication,
                FailureStage::Prepare,
            ));
        }
    };
    let work = async {
        if let Some(error) = interruption(&cancel, deadline) {
            return Err(error);
        }
        let pending = request
            .timeout(deadline.saturating_duration_since(Instant::now()))
            .send();
        tokio::pin!(pending);
        let mut primary = None;
        let response = tokio::select! {
            result = &mut pending => result,
            _ = cancel.cancelled() => {
                primary = Some(SourceError::new(SourceFailure::Cancelled, FailureStage::Read));
                pending.await
            },
            _ = tokio::time::sleep_until(deadline) => {
                primary = Some(SourceError::new(SourceFailure::ReadTimeout, FailureStage::Read));
                pending.await
            },
        };
        let response = response.map_err(|cause| drain_error(primary.take(), http_error(cause)))?;
        let status = response.status();
        if primary.is_none() && !status.is_success() {
            let failure = match status {
                StatusCode::UNAUTHORIZED => SourceFailure::Authentication,
                StatusCode::FORBIDDEN => SourceFailure::PermissionDenied,
                StatusCode::TOO_MANY_REQUESTS => SourceFailure::RateLimited {
                    retry_after: response
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.parse::<u64>().ok())
                        .and_then(|seconds| seconds.checked_mul(1000))
                        .map(DurationMs),
                },
                StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => {
                    SourceFailure::ReadTimeout
                }
                status if status.is_server_error() => SourceFailure::ServiceUnavailable,
                status => SourceFailure::UpstreamUnrecognized {
                    safe_code: format!("http_{}", status.as_u16()),
                },
            };
            primary = Some(SourceError::new(failure, FailureStage::Read));
        }
        if primary.is_none()
            && response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            primary = Some(SourceError::new(
                SourceFailure::ResponseLimit,
                FailureStage::Read,
            ));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        loop {
            let chunk = if primary.is_some() {
                stream.next().await
            } else {
                tokio::select! {
                    chunk = stream.next() => chunk,
                    _ = cancel.cancelled() => {
                        primary = Some(SourceError::new(SourceFailure::Cancelled, FailureStage::Read));
                        continue;
                    },
                    _ = tokio::time::sleep_until(deadline) => {
                        primary = Some(SourceError::new(SourceFailure::ReadTimeout, FailureStage::Read));
                        continue;
                    },
                }
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(cause) => return Err(drain_error(primary, http_error(cause))),
            };
            let charge = budget
                .charge(BudgetDimension::Bytes, chunk.len() as u64)
                .map_err(super::budget_error);
            if primary.is_none() {
                primary = interruption(&cancel, deadline).or_else(|| charge.err());
            }
            if primary.is_some() {
                bytes.clear();
                continue;
            }
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                primary = Some(SourceError::new(
                    SourceFailure::ResponseLimit,
                    FailureStage::Read,
                ));
                bytes.clear();
                continue;
            }
            bytes.extend_from_slice(&chunk);
        }
        drop(stream);
        if let Some(error) = primary.or_else(|| interruption(&cancel, deadline)) {
            return Err(error);
        }
        budget.check().map_err(super::budget_error)?;
        let document: serde_json::Value = world_protocol::wire::decode(&bytes, MAX_RESPONSE_BYTES)
            .map_err(|_| values::invalid_response("response"))?;
        let rows = document
            .pointer(&resource.rows_pointer)
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| values::invalid_response("rows"))?;
        if rows.len() > plan.limit as usize {
            return Err(SourceError::new(
                SourceFailure::ResponseLimit,
                FailureStage::Read,
            ));
        }
        let mut result = Vec::with_capacity(rows.len());
        let mut keys = std::collections::BTreeSet::new();
        for row in rows {
            if let Some(error) = interruption(&cancel, deadline) {
                return Err(error);
            }
            budget
                .charge(BudgetDimension::Rows, 1)
                .map_err(super::budget_error)?;
            let mut key = Vec::new();
            for id in &resource.key {
                let field = resource
                    .fields
                    .iter()
                    .find(|field| &field.id == id)
                    .ok_or_else(|| invalid("key", SourcePlanReason::InvalidKey))?;
                if !field.readable {
                    return Err(invalid("key", SourcePlanReason::FieldNotReadable));
                }
                key.push(values::from_json(
                    row.pointer(&field.pointer),
                    &field.value_type,
                    field.nullable,
                ));
            }
            let native_key = values::native_key(&key)?;
            if !keys.insert(native_key.clone()) {
                return Err(values::invalid_response("duplicateKey"));
            }
            let fields = plan
                .fields
                .iter()
                .map(|name| {
                    let field = resource
                        .fields
                        .iter()
                        .find(|field| field.id.as_str() == name)
                        .ok_or_else(|| invalid("fields", SourcePlanReason::UnknownField))?;
                    if !field.readable {
                        return Err(invalid("fields", SourcePlanReason::FieldNotReadable));
                    }
                    let value = row.pointer(&field.pointer);
                    Ok(SourceField {
                        id: field.id.clone(),
                        name: metadata
                            .schema
                            .fields
                            .iter()
                            .find(|entry| entry.id == field.id)
                            .ok_or_else(|| values::invalid_response("schemaField"))?
                            .name
                            .clone(),
                        value: values::from_json(value, &field.value_type, field.nullable),
                        raw_lexeme: value.map(|value| {
                            value
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| value.to_string())
                        }),
                        formula: None,
                        locator: None,
                    })
                })
                .collect::<Result<Vec<_>, SourceError>>()?;
            result.push(SourceRow {
                native_key,
                incarnation: metadata.binding.body.incarnation.clone(),
                fields,
            });
        }
        let continuation = match &resource.continuation_pointer {
            None => None,
            Some(pointer) => match document.pointer(pointer) {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(value))
                    if !value.is_empty() && value.len() <= 4096 =>
                {
                    Some(value.clone())
                }
                _ => return Err(values::invalid_response("continuation")),
            },
        };
        let binding = &metadata.binding.body;
        let complete = continuation.is_none() && plan.continuation.is_none();
        Ok(SourcePage {
            rows: result,
            basis: SourceBasis {
                source_id: binding.source_id.clone(),
                incarnation: binding.incarnation.clone(),
                binding: metadata.binding.reference.clone(),
                mapping_revision: binding.mapping.revision,
                authority_revision: binding.authority.revision,
                schema: binding.schema.clone(),
                identity_rule: binding.identity_rule.clone(),
                field_definitions: binding
                    .field_mapping
                    .iter()
                    .map(|field| field.property.clone())
                    .collect(),
                position: None,
                snapshot: None,
                observed_at: Timestamp::try_new(chrono::Utc::now().to_rfc3339())
                    .map_err(|_| values::invalid_response("observedAt"))?,
                captured_at: None,
                last_reconciled_at: None,
                guarantee: SourceGuarantee::Authoritative,
                gap: (!complete).then_some(SourceGap {
                    reason: GapReason::IncompleteEnumeration,
                    after: None,
                    before: None,
                }),
            },
            continuation,
            complete,
        })
    };
    work.await
}
fn interruption(cancel: &CancellationToken, deadline: Instant) -> Option<SourceError> {
    if cancel.is_cancelled() {
        Some(SourceError::new(
            SourceFailure::Cancelled,
            FailureStage::Read,
        ))
    } else if Instant::now() >= deadline {
        Some(SourceError::new(
            SourceFailure::ReadTimeout,
            FailureStage::Read,
        ))
    } else {
        None
    }
}
fn drain_error(primary: Option<SourceError>, cleanup: SourceError) -> SourceError {
    match primary {
        Some(primary) => SourceError::cleanup(Some(primary), "source.http_body_cleanup", cleanup),
        None => cleanup,
    }
}
fn invalid(field: &str, reason: SourcePlanReason) -> SourceError {
    SourceError::invalid(field, reason)
}
fn http_error(cause: reqwest::Error) -> SourceError {
    let failure = if cause.is_timeout() {
        SourceFailure::ReadTimeout
    } else if cause.is_connect() {
        SourceFailure::Connection
    } else {
        SourceFailure::ProtocolViolation
    };
    SourceError::caused_by(failure, FailureStage::Read, cause)
}
