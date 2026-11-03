use std::{future::Future, io, pin::Pin, sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response, RouteOutcome, StreamHandler, StreamResponse},
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderHandle,
    owner::model_discovery::{DraftRequest, Failure},
    projection,
};

pub(super) const ENDPOINT: &str = "/api/provider-models/discover-draft";
const DEADLINE: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    account: super::accounts::ProviderAccountWireDraft,
    api_key: Option<String>,
    token: Option<String>,
}

pub(super) async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> RouteOutcome {
    if request.method() != "POST" || request.path() != ENDPOINT {
        return Response::not_found().into();
    }
    let Some(token) = request.bearer_authorization() else {
        return unauthorized().into();
    };
    let decision = verifier.lock().await.verify(
        token,
        super::now_millis(),
        ENDPOINT,
        "providers:models",
        "providerModels.discoverDraft",
        "provider-models",
    );
    let Ok(decision) = decision else {
        return unauthorized().into();
    };
    if decision.revision() != format!("{:x}", Sha256::digest(&request.body)) {
        return unauthorized().into();
    }
    let Ok(input) = serde_json::from_slice::<Input>(&request.body) else {
        return failure(Failure::InvalidRequest).into();
    };
    let account = input.account.into_draft();
    if account.validate().is_err() {
        return failure(Failure::InvalidRequest).into();
    }
    RouteOutcome::Stream(StreamResponse::owned(Discovery {
        provider,
        request: DraftRequest {
            account,
            api_key: input.api_key,
            token: input.token,
        },
    }))
}

struct Discovery {
    provider: ProviderHandle,
    request: DraftRequest,
}

impl StreamHandler for Discovery {
    fn write(
        self: Box<Self>,
        mut stream: TcpStream,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        Box::pin(async move {
            let cancellation = CancellationToken::new();
            let _cancel_on_drop = cancellation.clone().drop_guard();
            let mut extra = [0_u8; 1];
            let response = tokio::select! {
                biased;
                disconnected = stream.read(&mut extra) => {
                    cancellation.cancel();
                    disconnected?;
                    return Ok(());
                }
                _ = tokio::time::sleep(DEADLINE) => {
                    cancellation.cancel();
                    failure(Failure::Deadline)
                }
                result = self.provider.discover_provider_model_draft(self.request, cancellation.clone()) => match result {
                    Ok(models) => Response::json(200, json!({"models": models.iter().map(projection::models::draft_json).collect::<Vec<_>>()})),
                    Err(reason) => failure(reason),
                },
            };
            let body = serde_json::to_vec(response.body()).map_err(io::Error::other)?;
            let head = format!(
                "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status(),
                body.len()
            );
            tokio::time::timeout(Duration::from_secs(5), async {
                stream.write_all(head.as_bytes()).await?;
                stream.write_all(&body).await
            })
            .await
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "provider discovery response timed out",
                )
            })?
        })
    }
}

fn unauthorized() -> Response {
    Response::json(401, json!({"reason": "unavailable"}))
}
fn failure(reason: Failure) -> Response {
    Response::json(
        if matches!(reason, Failure::InvalidRequest) {
            400
        } else {
            422
        },
        json!({"reason": reason}),
    )
}
