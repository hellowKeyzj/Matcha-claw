mod dispatch;
mod socket;
mod subscriptions;

use crate::{
    config::ConfigStore, diagnostics::Diagnostics, events::Events, interaction::Interactions, rpc,
    sealed, session::Sessions, workspace,
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Path, Query, Request, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header, uri::Authority},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;
use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(super) const PROTOCOL_VERSION: &str = "matcha-app-server-v1";

// Transport dependencies only; canonical business state stays in its module.
#[derive(Clone)]
pub(super) struct Gateway {
    config: Arc<ConfigStore>,
    sessions: Sessions,
    events: Events,
    interactions: Interactions,
    diagnostics: Diagnostics,
    media: workspace::Media,
    token: Option<Arc<str>>,
    listen: SocketAddr,
    shutdown: CancellationToken,
    connections: TaskTracker,
}

pub async fn serve(
    config: Arc<ConfigStore>,
    sessions: Sessions,
    events: Events,
    interactions: Interactions,
    diagnostics: Diagnostics,
    media: workspace::Media,
    listener: tokio::net::TcpListener,
) -> rpc::Result<()> {
    let snapshot = config.snapshot().await;
    let token = match snapshot.auth_token_env {
        Some(name) => {
            let token = std::env::var(name).map_err(|_| {
                rpc::Error::unavailable("auth_token_missing", "The configured token is unavailable")
            })?;
            if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
                return Err(rpc::Error::invalid(
                    "The management token must contain only nonempty visible ASCII characters",
                ));
            }
            Some(Arc::<str>::from(token))
        }
        None => None,
    };
    if !snapshot.listen.ip().is_loopback() && token.is_none() {
        return Err(rpc::Error::new(
            -32007,
            "token_required",
            "A management token is required for a non-loopback listener",
        ));
    }
    let listen = listener
        .local_addr()
        .map_err(|_| rpc::Error::internal("listen_address"))?;
    let shutdown = CancellationToken::new();
    let connections = TaskTracker::new();
    let stopping = shutdown.clone();
    let closing_sessions = sessions.clone();
    let cleanup = tokio::spawn(async move {
        stopping.cancelled().await;
        closing_sessions.shutdown().await
    });
    let gateway = Gateway {
        config,
        sessions,
        events,
        interactions,
        diagnostics,
        media,
        token,
        listen,
        shutdown: shutdown.clone(),
        connections: connections.clone(),
    };
    let router = Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .route("/ws", get(upgrade))
        .route("/files/{agentId}/{*path}", get(read_file).put(write_file))
        .route(
            "/media/{agentId}/{sessionId}",
            axum::routing::put(stage_media),
        )
        .route(
            "/media/{agentId}/{sessionId}/{reference}",
            axum::routing::post(take_media),
        )
        .route("/sealed-skills/{sessionId}/catalog", get(sealed_catalog))
        .route(
            "/sealed-skills/{sessionId}/read/{skillKey}/{*path}",
            get(read_sealed),
        )
        .with_state(gateway);
    eprintln!("matcha-app-server listening on http://{listen}");
    let signal_failed = Arc::new(AtomicBool::new(false));
    let signal_result = signal_failed.clone();
    let stop = shutdown.clone();
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            tokio::select! {
                result = shutdown_signal() => {
                    if result.is_err() {
                        signal_result.store(true, Ordering::Relaxed);
                        eprintln!("matcha-app-server: shutdown signal handler unavailable");
                    }
                },
                _ = stop.cancelled() => {},
            }
            stop.cancel();
        })
        .await;
    shutdown.cancel();
    connections.close();
    connections.wait().await;
    let cleanup = cleanup
        .await
        .map_err(|_| rpc::Error::internal("session_shutdown_task"))
        .and_then(|result| result);
    if result.is_err() {
        let error = rpc::Error::unavailable("http_serve_failed", "The HTTP listener failed");
        return Err(match cleanup {
            Err(cleanup) => error.with_data(json!({ "cleanup": cleanup })),
            Ok(()) => error,
        });
    }
    cleanup?;
    if signal_failed.load(Ordering::Relaxed) {
        return Err(rpc::Error::internal("shutdown_signal"));
    }
    Ok(())
}

async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let mut ctrl_break = tokio::signal::windows::ctrl_break()?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            signal = ctrl_break.recv() => signal.ok_or_else(|| std::io::Error::other("Ctrl+Break signal stream closed")),
        }
    }
    #[cfg(not(windows))]
    {
        tokio::signal::ctrl_c().await
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "scope": "http" }))
}

async fn version() -> Json<serde_json::Value> {
    Json(json!({
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

async fn upgrade(
    State(gateway): State<Gateway>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Err(error) = gateway.check_origin(&headers) {
        return http_error(error);
    }
    // Register before returning the upgrade response, not after the async handshake:
    // graceful shutdown must also wait for a not-yet-polled upgrade callback.
    let connection = gateway.connections.token();
    upgrade
        .on_upgrade(move |socket| async move {
            let _connection = connection;
            socket::serve(socket, gateway).await;
        })
        .into_response()
}

async fn read_file(
    State(gateway): State<Gateway>,
    Path((agent_id, path)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = gateway.authorize_file(&headers) {
        return http_error(error);
    }
    match workspace::read_file(&gateway.config, &agent_id, &path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => http_error(error),
    }
}

async fn write_file(
    State(gateway): State<Gateway>,
    Path((agent_id, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    if let Err(error) = gateway.authorize_file(request.headers()) {
        return http_error(error);
    }
    // ponytail: the workspace primitive accepts a whole file; stream when that API does.
    let bytes = tokio::select! {
        biased;
        _ = gateway.shutdown.cancelled() => return http_error(rpc::Error::unavailable("server_shutdown", "The server is shutting down")),
        body = to_bytes(request.into_body(), usize::MAX) => match body {
            Ok(bytes) => bytes,
            Err(_) => return http_error(rpc::Error::invalid("The upload body could not be read")),
        },
    };
    // Once the body is accepted, the commit outlives the HTTP response future.
    let operations = gateway.connections.clone();
    let write = operations.spawn(async move {
        let result = workspace::write_file(&gateway.config, &agent_id, &path, &bytes).await;
        if let Err(error) = &result {
            let kind = error
                .data
                .as_ref()
                .and_then(|data| data["kind"].as_str())
                .unwrap_or("file_write_failed");
            if gateway
                .diagnostics
                .record(
                    "gateway",
                    "file_write",
                    kind,
                    json!({ "agentId": agent_id }),
                )
                .await
                .is_err()
            {
                eprintln!("matcha-app-server: gateway diagnostic write failed");
            }
        }
        result
    });
    match write.await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => http_error(error),
        Err(_) => http_error(rpc::Error::new(
            -32006,
            "file_write_outcome_unknown",
            "The file write task stopped; inspect the file before retrying",
        )),
    }
}

async fn stage_media(
    State(gateway): State<Gateway>,
    Path((agent_id, session_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    if let Err(error) = gateway.authorize_file(request.headers()) {
        return http_error(error);
    }
    let metadata = match Query::<workspace::MediaUpload>::try_from_uri(request.uri()) {
        Ok(Query(metadata)) => metadata,
        Err(_) => return http_error(rpc::Error::invalid("Media upload metadata is invalid")),
    };
    let bytes = tokio::select! {
        biased;
        _ = gateway.shutdown.cancelled() => return http_error(rpc::Error::unavailable("server_shutdown", "The server is shutting down")),
        body = to_bytes(request.into_body(), usize::MAX) => match body {
            Ok(bytes) => bytes.to_vec(),
            Err(_) => return http_error(rpc::Error::invalid("The upload body could not be read")),
        },
    };
    let operations = gateway.connections.clone();
    let staged = operations.spawn(async move {
        gateway
            .media
            .stage(
                &gateway.config,
                &gateway.sessions,
                &agent_id,
                &session_id,
                metadata,
                bytes,
            )
            .await
    });
    match staged.await {
        Ok(Ok(receipt)) => Json(receipt).into_response(),
        Ok(Err(error)) => http_error(error),
        Err(_) => http_error(rpc::Error::new(
            -32006,
            "media_stage_outcome_unknown",
            "The media staging task stopped without a confirmed result",
        )),
    }
}

async fn take_media(
    State(gateway): State<Gateway>,
    Path((agent_id, session_id, reference)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = gateway.authorize_file(&headers) {
        return http_error(error);
    }
    let operations = gateway.connections.clone();
    let taken = operations.spawn(async move {
        gateway
            .media
            .take(
                &gateway.config,
                &gateway.sessions,
                &agent_id,
                &session_id,
                &reference,
            )
            .await
    });
    match taken.await {
        Ok(Ok(bytes)) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(error)) => http_error(error),
        Err(_) => http_error(rpc::Error::new(
            -32006,
            "media_take_outcome_unknown",
            "Media consumption could not be confirmed; the reference must not be retried blindly",
        )),
    }
}

async fn sealed_catalog(
    State(gateway): State<Gateway>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = gateway.check_origin(&headers) {
        return http_error(error);
    }
    sealed_response(
        sealed::catalog(
            &gateway.config,
            &gateway.sessions,
            &session_id,
            single_header(&headers, "authorization"),
        )
        .await,
    )
}

async fn read_sealed(
    State(gateway): State<Gateway>,
    Path((session_id, skill_key, path)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = gateway.check_origin(&headers) {
        return http_error(error);
    }
    sealed_response(
        sealed::read(
            &gateway.config,
            &gateway.sessions,
            &session_id,
            &skill_key,
            &path,
            single_header(&headers, "authorization"),
            single_header(&headers, "x-matcha-sealed-package-sha256"),
        )
        .await,
    )
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    value.to_str().ok()
}

fn sealed_response(result: rpc::Result) -> Response {
    match result {
        Ok(value) => (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            Json(value),
        )
            .into_response(),
        Err(error) => http_error(error),
    }
}

impl Gateway {
    fn authorize_file(&self, headers: &HeaderMap) -> rpc::Result<()> {
        self.check_origin(headers)?;
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|header| header.to_str().ok())
            .and_then(|value| {
                let (scheme, token) = value.split_once(' ')?;
                scheme.eq_ignore_ascii_case("Bearer").then_some(token)
            });
        self.authenticate(token)
    }

    pub(super) fn authenticate(&self, token: Option<&str>) -> rpc::Result<()> {
        match &self.token {
            Some(expected) if token != Some(expected.as_ref()) => Err(rpc::Error::new(
                -32007,
                "unauthorized",
                "A valid management token is required",
            )),
            _ => Ok(()),
        }
    }

    fn check_origin(&self, headers: &HeaderMap) -> rpc::Result<()> {
        let forbidden = || {
            rpc::Error::new(
                -32007,
                "origin_forbidden",
                "The request Host or Origin is not allowed",
            )
        };
        if headers.get_all(header::HOST).iter().count() != 1 {
            return Err(forbidden());
        }
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<Authority>().ok())
            .filter(|authority| !authority.as_str().contains('@'))
            .ok_or_else(forbidden)?;
        if (host.port().is_some() && host.port_u16().is_none())
            || host.port_u16().unwrap_or(80) != self.listen.port()
        {
            return Err(forbidden());
        }
        if self.listen.ip().is_loopback() {
            let hostname = host.host().trim_matches(['[', ']']);
            let local = hostname.eq_ignore_ascii_case("localhost")
                || hostname.parse::<IpAddr>().ok() == Some(self.listen.ip());
            if !local {
                return Err(forbidden());
            }
        }
        let mut origins = headers.get_all(header::ORIGIN).iter();
        if let Some(origin) = origins.next() {
            if origins.next().is_some() {
                return Err(forbidden());
            }
            let origin = origin
                .to_str()
                .ok()
                .and_then(|value| value.parse::<axum::http::Uri>().ok())
                .ok_or_else(forbidden)?;
            let authority = origin.authority().ok_or_else(forbidden)?;
            if authority.as_str().contains('@')
                || (authority.port().is_some() && authority.port_u16().is_none())
                || origin.scheme_str() != Some("http")
                || origin
                    .path_and_query()
                    .is_some_and(|path| path.as_str() != "/")
                || !authority.host().eq_ignore_ascii_case(host.host())
                || authority.port_u16().unwrap_or(80) != host.port_u16().unwrap_or(80)
            {
                return Err(forbidden());
            }
        }
        Ok(())
    }
}

fn http_error(error: rpc::Error) -> Response {
    let status = match error.code {
        -32700 | -32600 | -32602 => StatusCode::BAD_REQUEST,
        -32601 | -32001 => StatusCode::NOT_FOUND,
        -32002 => StatusCode::CONFLICT,
        -32003 => StatusCode::SERVICE_UNAVAILABLE,
        -32007
            if matches!(
                error.data.as_ref().and_then(|data| data["kind"].as_str()),
                Some("origin_forbidden" | "sealed_disabled")
            ) =>
        {
            StatusCode::FORBIDDEN
        }
        -32007 => StatusCode::UNAUTHORIZED,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let mut response = (status, Json(json!({ "error": error }))).into_response();
    if status == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            axum::http::HeaderValue::from_static("Bearer"),
        );
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}
