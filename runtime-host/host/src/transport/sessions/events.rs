use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::{Mutex, broadcast};

use crate::{
    sessions::{events::SessionDeltaSource, state::SessionDelta},
    transport::{common::authorization::CapabilityDecisionVerifier, localhost},
};

const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const ENDPOINT: &str = "/api/sessions/events";
const AUTHORIZATION_SCOPE: &str = "session:events:read";
const AUTHORIZATION_CAPABILITY: &str = "session.events";
const AUTHORIZATION_SUBJECT: &str = "session-events";

pub(crate) async fn handle_localhost(
    request: &localhost::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    source: SessionDeltaSource,
) -> Option<localhost::RouteOutcome> {
    if request.method() != "GET" || request.path() != ENDPOINT {
        return None;
    }
    Some(
        route(request.headers(), verifier, source)
            .await
            .into_localhost_outcome(),
    )
}

async fn route(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    source: SessionDeltaSource,
) -> Action {
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Action::Response(Response::unauthorized());
    };
    let mut verifier = verifier.lock().await;
    if verifier
        .verify(
            authorization,
            now_millis(),
            ENDPOINT,
            AUTHORIZATION_SCOPE,
            AUTHORIZATION_CAPABILITY,
            AUTHORIZATION_SUBJECT,
        )
        .is_err()
    {
        return Action::Response(Response::unauthorized());
    }
    drop(verifier);
    Action::Stream(source.subscribe())
}

enum Action {
    Response(Response),
    Stream(broadcast::Receiver<SessionDelta>),
}

struct Response {
    status: u16,
    body: Value,
}

impl Action {
    fn into_localhost_outcome(self) -> localhost::RouteOutcome {
        match self {
            Self::Response(response) => {
                localhost::RouteOutcome::Response(response.into_localhost())
            }
            Self::Stream(receiver) => localhost::RouteOutcome::Sse(
                localhost::SseStream::session_deltas(receiver, KEEPALIVE_INTERVAL),
            ),
        }
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Session events request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Session events authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Session events route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn into_localhost(self) -> localhost::Response {
        localhost::Response::json(self.status, self.body)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    static NEXT_CORRELATION: AtomicU64 = AtomicU64::new(1);

    #[tokio::test]
    async fn authorization_uses_the_fixed_session_events_decision() {
        let source = SessionDeltaSource::new(16);
        let verifier = Arc::new(Mutex::new(
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier"),
        ));

        let rejected = route(
            &headers_with_decision(&decision_with_scope("sessions:read")),
            Arc::clone(&verifier),
            source.clone(),
        )
        .await;
        assert!(matches!(
            rejected,
            Action::Response(Response { status: 401, .. })
        ));

        let accepted = route(&headers_with_decision(&decision()), verifier, source).await;
        assert!(matches!(accepted, Action::Stream(_)));
    }

    fn headers_with_decision(decision: &str) -> Vec<(String, String)> {
        vec![(
            AUTHORIZATION_HEADER.to_owned(),
            format!("{BEARER_PREFIX}{decision}"),
        )]
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision() -> String {
        decision_with_scope(AUTHORIZATION_SCOPE)
    }

    fn decision_with_scope(scope: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": ENDPOINT,
            "scope": scope,
            "capability": AUTHORIZATION_CAPABILITY,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": now_millis() + 60_000,
            "correlation": format!("test:{}", NEXT_CORRELATION.fetch_add(1, Ordering::Relaxed)),
            "revision": "test",
        });
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
