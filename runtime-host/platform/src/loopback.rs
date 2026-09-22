use std::{future::Future, io, pin::Pin, sync::Arc, time::Duration};

use serde_json::Value;
use tokio::{io::AsyncWriteExt, net::TcpStream};

#[derive(Clone, Copy)]
pub enum BodyPolicy {
    Empty,
    Optional { max_bytes: usize },
    Required { max_bytes: usize },
}

pub struct RequestHead {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub websocket: bool,
    pub websocket_key: Option<String>,
    content_length: Option<usize>,
}

impl RequestHead {
    pub fn new(
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        websocket: bool,
        websocket_key: Option<String>,
        content_length: Option<usize>,
    ) -> Self {
        Self {
            method,
            path,
            headers,
            websocket,
            websocket_key,
            content_length,
        }
    }

    pub fn bearer_authorization(&self) -> Option<&str> {
        self.headers
            .iter()
            .find(|(name, _)| name == "authorization")
            .and_then(|(_, value)| value.strip_prefix("Bearer "))
    }

    pub const fn content_length(&self) -> Option<usize> {
        self.content_length
    }
}

pub struct Request {
    pub head: RequestHead,
    pub body: Vec<u8>,
}

impl Request {
    pub fn method(&self) -> &str {
        &self.head.method
    }

    pub fn path(&self) -> &str {
        &self.head.path
    }

    pub fn headers(&self) -> &[(String, String)] {
        &self.head.headers
    }

    pub fn bearer_authorization(&self) -> Option<&str> {
        self.head.bearer_authorization()
    }
}

pub struct Response {
    status: u16,
    body: Value,
    headers: Vec<(String, String)>,
    raw_headers: String,
}

impl Response {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            headers: Vec::new(),
            raw_headers: String::new(),
        }
    }

    pub fn error(status: u16, error: &'static str) -> Self {
        Self::json(
            status,
            serde_json::json!({ "success": false, "error": error }),
        )
    }

    pub fn bad_request() -> Self {
        Self::error(400, "Runtime Host request is invalid")
    }

    pub fn not_found() -> Self {
        Self::error(404, "Runtime Host route is not available")
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn with_raw_headers(mut self, headers: String) -> Self {
        self.raw_headers = headers;
        self
    }

    pub const fn status(&self) -> u16 {
        self.status
    }

    pub const fn body(&self) -> &Value {
        &self.body
    }

    pub fn headers(&self) -> &[(String, String)] {
        &self.headers
    }

    pub fn raw_headers(&self) -> &str {
        &self.raw_headers
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ModuleId(&'static str);

impl ModuleId {
    pub const fn new(value: &'static str) -> Self {
        Self(value)
    }

    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

pub type RouteFuture = Pin<Box<dyn Future<Output = RouteOutcome> + Send>>;
type RouteHeadPlanFn = fn(&RequestHead) -> Option<RouteHeadPlan>;
type RouteDispatchFn = dyn Fn(Request) -> RouteFuture + Send + Sync;

pub enum RouteOutcome {
    Response(Response),
    Upgrade(Upgrade),
    Stream(StreamResponse),
}

impl RouteOutcome {
    pub async fn write(self, stream: TcpStream) -> io::Result<()> {
        match self {
            Self::Response(response) => write_json_response(stream, response).await,
            Self::Upgrade(upgrade) => upgrade.serve(stream).await,
            Self::Stream(streaming) => streaming.write(stream).await,
        }
    }
}

impl From<Response> for RouteOutcome {
    fn from(response: Response) -> Self {
        Self::Response(response)
    }
}

pub enum Upgrade {
    Owned(Box<dyn UpgradeHandler>),
}

impl Upgrade {
    pub fn owned(handler: impl UpgradeHandler + 'static) -> Self {
        Self::Owned(Box::new(handler))
    }

    pub async fn serve(self, stream: TcpStream) -> io::Result<()> {
        match self {
            Self::Owned(handler) => handler.serve(stream).await,
        }
    }
}

pub trait UpgradeHandler: Send {
    fn serve(
        self: Box<Self>,
        stream: TcpStream,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;
}

pub enum StreamResponse {
    Owned(Box<dyn StreamHandler>),
}

impl StreamResponse {
    pub fn owned(handler: impl StreamHandler + 'static) -> Self {
        Self::Owned(Box::new(handler))
    }

    pub async fn write(self, stream: TcpStream) -> io::Result<()> {
        match self {
            Self::Owned(handler) => handler.write(stream).await,
        }
    }
}

pub trait StreamHandler: Send {
    fn write(
        self: Box<Self>,
        stream: TcpStream,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;
}

async fn write_json_response(mut stream: TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(response.body()).expect("loopback response is serializable");
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\n{}{}Content-Length: {}\r\nConnection: close\r\n\r\n",
                response.status(),
                reason_phrase(response.status()),
                response.raw_headers(),
                format_headers(response.headers()),
                body.len(),
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}

fn format_headers(headers: &[(String, String)]) -> String {
    let mut output = String::new();
    for (name, value) in headers {
        output.push_str(name);
        output.push_str(": ");
        output.push_str(value);
        output.push_str("\r\n");
    }
    output
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Content",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

#[derive(Clone, Copy)]
pub enum RouteDeadline {
    Request(Duration),
    /// Only body reception is bounded; the module owns execution deadlines.
    Body(Duration),
}

#[derive(Clone, Copy)]
pub struct RouteHeadPlan {
    body_policy: BodyPolicy,
    deadline: RouteDeadline,
    timeout_response: fn() -> Response,
}

impl RouteHeadPlan {
    pub const fn new(
        body_policy: BodyPolicy,
        deadline: Duration,
        timeout_response: fn() -> Response,
    ) -> Self {
        Self {
            body_policy,
            deadline: RouteDeadline::Request(deadline),
            timeout_response,
        }
    }

    pub const fn body_deadline(
        body_policy: BodyPolicy,
        deadline: Duration,
        timeout_response: fn() -> Response,
    ) -> Self {
        Self {
            body_policy,
            deadline: RouteDeadline::Body(deadline),
            timeout_response,
        }
    }

    pub const fn body_policy(self) -> BodyPolicy {
        self.body_policy
    }

    pub const fn deadline(self) -> RouteDeadline {
        self.deadline
    }

    pub fn timeout_response(self) -> Response {
        (self.timeout_response)()
    }
}

#[derive(Clone)]
pub struct RouteDescriptor {
    id: &'static str,
    head_plan: RouteHeadPlanFn,
    dispatch: Arc<RouteDispatchFn>,
}

impl RouteDescriptor {
    pub fn bound(
        id: &'static str,
        head_plan: RouteHeadPlanFn,
        dispatch: impl Fn(Request) -> RouteFuture + Send + Sync + 'static,
    ) -> Self {
        Self {
            id,
            head_plan,
            dispatch: Arc::new(dispatch),
        }
    }

    pub const fn id(&self) -> &'static str {
        self.id
    }

    pub fn plan_head(&self, head: &RequestHead) -> Option<RouteHeadPlan> {
        (self.head_plan)(head)
    }

    pub fn dispatch(&self, request: Request) -> RouteFuture {
        (self.dispatch)(request)
    }
}

#[derive(Clone)]
pub struct ModuleDescriptor {
    id: ModuleId,
    routes: Vec<RouteDescriptor>,
}

impl ModuleDescriptor {
    pub fn new(id: ModuleId, routes: Vec<RouteDescriptor>) -> Self {
        debug_assert!(!id.as_str().is_empty());
        debug_assert!(routes.iter().all(|route| !route.id().is_empty()));
        Self { id, routes }
    }

    pub const fn id(&self) -> ModuleId {
        self.id
    }

    pub fn routes(&self) -> &[RouteDescriptor] {
        &self.routes
    }
}
