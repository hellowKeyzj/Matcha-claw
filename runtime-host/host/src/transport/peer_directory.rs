use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::{peer_directory::Directory, transport::authorization::CapabilityDecisionVerifier};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const AUTHORIZATION_ENDPOINT: &str = "/api/runtime-endpoints/list";
const AUTHORIZATION_SCOPE: &str = "runtime:endpoints:read";
const CAPABILITY_ID: &str = "runtime.endpoints.directory";
const AUTHORIZATION_SUBJECT: &str = "runtime-endpoint-directory";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
}

pub(crate) fn decode_authorization(
    headers: &[(String, String)],
    verifier: &mut CapabilityDecisionVerifier,
) -> Result<(), DecodeError> {
    let authorization = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
        .ok_or(DecodeError::Unauthorized)?;
    verifier
        .verify(
            authorization,
            now_millis(),
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            CAPABILITY_ID,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    Ok(())
}

pub(crate) enum Delivery {
    Ok(Directory),
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok(directory) => serde_json::to_value(directory)
                .expect("Runtime endpoint directory response is serializable"),
        }
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

pub(crate) mod server {
    use super::{AUTHORIZATION_HEADER, BEARER_PREFIX, Delivery};
    use crate::transport::authorization::CapabilityDecisionVerifier;
    use serde_json::Value;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    pub(crate) struct Response {
        pub(crate) status: u16,
        pub(crate) body: Value,
    }

    pub(crate) async fn handle(
        headers: &[(String, String)],
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        owner: crate::owner::Handle,
    ) -> Response {
        let authorization_present = headers
            .iter()
            .find(|(name, _)| name == AUTHORIZATION_HEADER)
            .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX));
        if authorization_present.is_none() {
            return Response::unauthorized();
        }
        let mut verifier = verifier.lock().await;
        if super::decode_authorization(headers, &mut verifier).is_err() {
            return Response::unauthorized();
        }
        drop(verifier);

        Response::from_delivery(Delivery::Ok(owner.runtime_endpoint_directory().await))
    }

    impl Response {
        fn unauthorized() -> Self {
            Self::fixed(401, "Runtime endpoint directory authorization is invalid")
        }

        fn fixed(status: u16, error: &'static str) -> Self {
            Self {
                status,
                body: serde_json::json!({ "success": false, "error": error }),
            }
        }

        fn from_delivery(delivery: Delivery) -> Self {
            Self {
                status: delivery.status_code(),
                body: delivery.body(),
            }
        }
    }
}
