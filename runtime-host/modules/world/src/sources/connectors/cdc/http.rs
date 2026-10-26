use super::super::{SourceCredential, SourceError, metadata::ReadMetadata, values};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{failure::FailureStage, sources::*, time::Timestamp};

const MAX_BYTES: usize = 8 * 1024 * 1024;
pub(super) async fn read(
    metadata: &ReadMetadata,
    plan: &SourceReadPlan,
    a: &crate::sources::sync::Assignment,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<(OrderedSourceBatch, Vec<u8>, Timestamp), SourceError> {
    let SourceConnectionConfig::HttpJson(config) = &metadata.connection.config else {
        return Err(super::missing());
    };
    let feed = config.changes.as_ref().ok_or_else(super::missing)?;
    let mut url = endpoint(&config.origin, &feed.read_path)?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("resource", &plan.resource)
            .append_pair("partition", &a.partition)
            .append_pair("epoch", &a.epoch.0.to_string());
        if let Some(cursor) = &plan.continuation {
            q.append_pair("after", cursor);
        }
        for field in &plan.fields {
            q.append_pair("field", field);
        }
    }
    let request = credential_request(client(deadline)?.get(url), credential)?;
    let raw = execute(request, cancel, deadline).await?;
    let batch: OrderedSourceBatch = world_protocol::wire::decode(&raw, MAX_BYTES)
        .map_err(|_| values::invalid_response("changeFeed"))?;
    if batch.binding != a.binding
        || batch.epoch != a.epoch
        || !valid_position(&batch.captured, a)
        || batch
            .events
            .iter()
            .any(|event| !valid_position(&event.position, a))
    {
        return Err(values::invalid_response("changeFeed.basis"));
    }
    if batch
        .events
        .iter()
        .map(|e| &e.event_id)
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != batch.events.len()
    {
        return Err(values::invalid_response("changeFeed.eventId"));
    }
    let observed = Timestamp::try_new(chrono::Utc::now().to_rfc3339())
        .map_err(|_| values::invalid_response("observedAt"))?;
    Ok((batch, raw, observed))
}
pub(super) async fn ack(
    metadata: &ReadMetadata,
    position: &SourcePosition,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<(), SourceError> {
    let SourceConnectionConfig::HttpJson(config) = &metadata.connection.config else {
        return Err(super::missing());
    };
    let feed = config.changes.as_ref().ok_or_else(super::missing)?;
    let path = feed.ack_path.as_ref().ok_or_else(super::missing)?;
    let body = world_protocol::wire::encode(position, 64 * 1024)
        .map_err(|_| values::invalid_response("ack.position"))?;
    let request = credential_request(
        client(deadline)?
            .post(endpoint(&config.origin, path)?)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body),
        credential,
    )?;
    let response = execute(request, cancel, deadline).await?;
    let confirmed: SourcePosition = world_protocol::wire::decode(&response, 64 * 1024)
        .map_err(|_| values::invalid_response("ack.confirmation"))?;
    if &confirmed != position {
        return Err(SourceError::new(
            SourceFailure::PositionIncomparable,
            FailureStage::Execute,
        ));
    }
    Ok(())
}
fn valid_position(p: &SourcePosition, a: &crate::sources::sync::Assignment) -> bool {
    p.source_id == a.source_id
        && p.incarnation == a.incarnation
        && p.partition == a.partition
        && p.format == a.format
}
fn endpoint(origin: &str, path: &str) -> Result<Url, SourceError> {
    let origin = Url::parse(origin).map_err(|_| values::invalid_response("origin"))?;
    let url = origin
        .join(path)
        .map_err(|_| values::invalid_response("endpoint"))?;
    if !matches!(origin.scheme(), "http" | "https")
        || origin.origin() != url.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(values::invalid_response("endpoint"));
    }
    Ok(url)
}
fn client(deadline: Instant) -> Result<Client, SourceError> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(30)),
        )
        .timeout(deadline.saturating_duration_since(Instant::now()))
        .build()
        .map_err(|e| SourceError::caused_by(SourceFailure::Connection, FailureStage::Prepare, e))
}
fn credential_request(
    request: reqwest::RequestBuilder,
    credential: SourceCredential,
) -> Result<reqwest::RequestBuilder, SourceError> {
    match credential {
        SourceCredential::None => Ok(request),
        SourceCredential::HttpBearer(token) => Ok(request.bearer_auth(token.as_str())),
        SourceCredential::Postgres { .. } => Err(SourceError::new(
            SourceFailure::Authentication,
            FailureStage::Prepare,
        )),
    }
}
async fn execute(
    request: reqwest::RequestBuilder,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<Vec<u8>, SourceError> {
    let work = async {
        let response = request.send().await.map_err(http_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(SourceError::new(
                match status.as_u16() {
                    401 => SourceFailure::Authentication,
                    403 => SourceFailure::PermissionDenied,
                    408 | 504 => SourceFailure::ReadTimeout,
                    429 => SourceFailure::RateLimited { retry_after: None },
                    500..=599 => SourceFailure::ServiceUnavailable,
                    n => SourceFailure::UpstreamUnrecognized {
                        safe_code: format!("http_{n}"),
                    },
                },
                FailureStage::Read,
            ));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
        {
            return Err(SourceError::new(
                SourceFailure::ResponseLimit,
                FailureStage::Read,
            ));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(http_error)?;
            if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
                return Err(SourceError::new(
                    SourceFailure::ResponseLimit,
                    FailureStage::Read,
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    tokio::select! {r=work=>r,_=cancel.cancelled()=>Err(super::super::cancelled()),_=tokio::time::sleep_until(deadline)=>Err(SourceError::new(SourceFailure::ReadTimeout,FailureStage::Read))}
}
fn http_error(e: reqwest::Error) -> SourceError {
    let failure = if e.is_timeout() {
        SourceFailure::ReadTimeout
    } else {
        SourceFailure::Connection
    };
    SourceError::caused_by(failure, FailureStage::Read, e)
}
