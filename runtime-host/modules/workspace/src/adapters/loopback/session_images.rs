use base64::{Engine as _, engine::general_purpose::STANDARD};
use platform::{
    endpoint::runtime_address::RuntimeEndpoint,
    loopback::{Request, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Dependencies;
use crate::session_images::{SessionImageFailure, SessionImagePage};

pub(super) const AUTHORIZATION_ENDPOINT: &str = "/api/workspace/session-images";
const LIST_OPERATION: &str = "media.listSessionImages";
const READ_OPERATION: &str = "media.readSessionImage";

pub(crate) async fn handle(request: Request, dependencies: Dependencies) -> Response {
    if request.method() != "POST" || request.path() != AUTHORIZATION_ENDPOINT {
        return error(404, "Session image route is not available");
    }
    let Some(authorization) = request
        .headers()
        .iter()
        .find(|(name, _)| name == "authorization")
        .and_then(|(_, value)| value.strip_prefix("Bearer "))
    else {
        return error(401, "Session image authorization is invalid");
    };
    let request: ImageRequest = match serde_json::from_slice(&request.body) {
        Ok(request) => request,
        Err(_) => return error(400, "Session image request is invalid"),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    if dependencies
        .verifier
        .lock()
        .await
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            "workspace-media:read",
            &request.operation_id,
            "workspace-media",
        )
        .is_err()
    {
        return error(401, "Session image authorization is invalid");
    }
    let (endpoint, session_key, agent_id) = request.input.scope();
    if request.id != "workspace.media"
        || request.scope.kind != "session"
        || request.target.kind != "workspace-media"
        || &request.scope.endpoint != endpoint
        || request.scope.session_key != session_key
        || !valid_identity(session_key)
        || !valid_identity(agent_id)
    {
        return error(400, "Session image request is invalid");
    }
    let Some(endpoint) = endpoint.runtime_endpoint() else {
        return error(400, "Session image request is invalid");
    };
    let session_key = session_key.to_owned();
    let agent_id = agent_id.to_owned();
    match request.input {
        Input::List { cursor, .. } if request.operation_id == LIST_OPERATION => {
            if cursor
                .as_deref()
                .is_some_and(|cursor| !valid_opaque(cursor, 256))
            {
                return failure(SessionImageFailure::CursorInvalid);
            }
            match dependencies
                .workspace
                .list_session_images(endpoint, session_key, agent_id, cursor)
                .await
                .unwrap_or(Err(SessionImageFailure::Unavailable))
            {
                Ok(page) => page_response(page),
                Err(error) => failure(error),
            }
        }
        Input::Read { reference, .. } if request.operation_id == READ_OPERATION => {
            if !valid_opaque(&reference, 8192) {
                return failure(SessionImageFailure::InvalidReference);
            }
            match dependencies
                .workspace
                .read_session_image(endpoint, session_key, agent_id, reference)
                .await
                .unwrap_or(Err(SessionImageFailure::Unavailable))
            {
                Ok(image) => Response::json(
                    200,
                    json!({
                        "name": image.name,
                        "mimeType": image.mime_type,
                        "data": STANDARD.encode(&image.bytes),
                    }),
                ),
                Err(error) => failure(error),
            }
        }
        _ => error(400, "Session image request is invalid"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageRequest {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
    endpoint: Endpoint,
    session_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum Input {
    List {
        endpoint: Endpoint,
        #[serde(rename = "sessionKey")]
        session_key: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(default, deserialize_with = "optional_cursor")]
        cursor: Option<String>,
    },
    Read {
        endpoint: Endpoint,
        #[serde(rename = "sessionKey")]
        session_key: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        reference: String,
    },
}

impl Input {
    fn scope(&self) -> (&Endpoint, &str, &str) {
        match self {
            Self::List {
                endpoint,
                session_key,
                agent_id,
                ..
            }
            | Self::Read {
                endpoint,
                session_key,
                agent_id,
                ..
            } => (endpoint, session_key, agent_id),
        }
    }
}

#[derive(Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn runtime_endpoint(&self) -> Option<RuntimeEndpoint> {
        (self.kind == "native-runtime")
            .then(|| {
                RuntimeEndpoint::try_new(&self.runtime_adapter_id, &self.runtime_instance_id).ok()
            })
            .flatten()
    }
}

fn optional_cursor<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn valid_identity(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.as_bytes().contains(&0)
}

fn valid_opaque(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.as_bytes().contains(&0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImagePage {
    items: Vec<Image>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
    omitted_oversized: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Image {
    reference: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    readable: bool,
}

fn page_response(page: SessionImagePage) -> Response {
    Response::json(
        200,
        serde_json::to_value(ImagePage {
            items: page
                .items
                .into_iter()
                .map(|image| Image {
                    reference: image.reference,
                    name: image.name,
                    mime_type: image.mime_type,
                    readable: image.readable,
                })
                .collect(),
            next_cursor: page.next_cursor,
            omitted_oversized: page.omitted_oversized,
        })
        .expect("session image page is serializable"),
    )
}

fn failure(failure: SessionImageFailure) -> Response {
    let (code, message) = match failure {
        SessionImageFailure::Unsupported => ("unsupported", "Session images are unsupported"),
        SessionImageFailure::CursorInvalid => ("cursorInvalid", "Session image cursor is invalid"),
        SessionImageFailure::InvalidReference => {
            ("invalidReference", "Session image reference is invalid")
        }
        SessionImageFailure::TooLarge => ("tooLarge", "Session image exceeds the limit"),
        SessionImageFailure::Unavailable => return unavailable_response(),
    };
    Response::json(
        422,
        json!({ "success": false, "code": code, "error": message }),
    )
}

pub(super) fn unavailable_response() -> Response {
    error(503, "Session images are unavailable")
}

fn error(status: u16, message: &'static str) -> Response {
    Response::json(status, json!({ "success": false, "error": message }))
}
