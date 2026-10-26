use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension, failure::FailureStage, sources::*, time::DurationMs,
};

use super::super::{SourceCredential, SourceError, values};
use crate::extensions::invocation::CallBudget;

pub(super) async fn discover(
    config: &HttpJsonConnectionConfig,
    resource: &str,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
    budget: &CallBudget,
    maximum: usize,
) -> Result<SchemaObservation, SourceError> {
    if let Some(error) = interruption(&cancel, deadline) {
        return Err(error);
    }
    let path = config.schema_path.as_deref().ok_or_else(|| {
        SourceError::new(
            SourceFailure::CapabilityMissing {
                capability: SourceCapability::SchemaDiscovery,
            },
            FailureStage::Prepare,
        )
    })?;
    let origin = Url::parse(&config.origin).map_err(|_| endpoint_error())?;
    let mut url = origin.join(path).map_err(|_| endpoint_error())?;
    if !matches!(origin.scheme(), "http" | "https")
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.origin() != url.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(endpoint_error());
    }
    url.query_pairs_mut().append_pair("resource", resource);
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
    let request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json");
    let request = match credential {
        SourceCredential::None => request,
        SourceCredential::HttpBearer(token) => request.bearer_auth(token.as_str()),
        SourceCredential::Postgres { .. } => {
            return Err(SourceError::new(
                SourceFailure::Authentication,
                FailureStage::Prepare,
            ));
        }
    };
    let pending = request.send();
    tokio::pin!(pending);
    let mut primary = interruption(&cancel, deadline);
    let response = tokio::select! {
        result = &mut pending => result,
        _ = cancel.cancelled() => { primary = Some(super::super::cancelled()); pending.await },
        _ = tokio::time::sleep_until(deadline) => {
            primary = Some(SourceError::new(SourceFailure::ReadTimeout, FailureStage::Read)); pending.await
        },
    }.map_err(|cause| drain_error(primary.take(), http_error(cause)))?;
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
            StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => SourceFailure::ReadTimeout,
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
            .is_some_and(|length| length > maximum as u64)
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
                _ = cancel.cancelled() => { primary = Some(super::super::cancelled()); continue; },
                _ = tokio::time::sleep_until(deadline) => {
                    primary = Some(SourceError::new(SourceFailure::ReadTimeout, FailureStage::Read)); continue;
                },
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|cause| drain_error(primary.take(), http_error(cause)))?;
        let charge = budget
            .charge(BudgetDimension::Bytes, chunk.len() as u64)
            .map_err(super::super::budget_error);
        if primary.is_none() {
            primary = interruption(&cancel, deadline).or_else(|| charge.err());
        }
        if primary.is_none() && bytes.len().saturating_add(chunk.len()) > maximum {
            primary = Some(SourceError::new(
                SourceFailure::ResponseLimit,
                FailureStage::Read,
            ));
        }
        if primary.is_some() {
            bytes.clear();
        } else {
            bytes.extend_from_slice(&chunk);
        }
    }
    drop(stream);
    if let Some(error) = primary.or_else(|| interruption(&cancel, deadline)) {
        return Err(error);
    }
    budget.check().map_err(super::super::budget_error)?;
    let observation: SchemaObservation = world_protocol::wire::decode(&bytes, maximum)
        .map_err(|_| values::invalid_response("schema"))?;
    Ok(observation)
}
fn endpoint_error() -> SourceError {
    SourceError::invalid("schemaPath", SourcePlanReason::InvalidEndpoint)
}
fn interruption(cancel: &CancellationToken, deadline: Instant) -> Option<SourceError> {
    if cancel.is_cancelled() {
        Some(super::super::cancelled())
    } else if Instant::now() >= deadline {
        Some(SourceError::new(
            SourceFailure::ReadTimeout,
            FailureStage::Read,
        ))
    } else {
        None
    }
}
fn http_error(cause: reqwest::Error) -> SourceError {
    SourceError::caused_by(
        if cause.is_timeout() {
            SourceFailure::ReadTimeout
        } else {
            SourceFailure::Connection
        },
        FailureStage::Read,
        cause,
    )
}
fn drain_error(primary: Option<SourceError>, cause: SourceError) -> SourceError {
    match primary {
        Some(primary) => SourceError::cleanup(Some(primary), "source.discovery_http_drain", cause),
        None => cause,
    }
}
