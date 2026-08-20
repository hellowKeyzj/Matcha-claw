use std::{collections::HashMap, future::Future, io, pin::Pin, sync::Arc, time::Duration};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as BASE64},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use fleet::terminal::{Generation, ProviderId, SessionId, TargetId};

use super::{
    protocol::{MAX_CONTROL, MAX_PAYLOAD, control, read_frame, write_frame},
    provider::{ProviderCommand, ProviderEvent, TerminalProvider, TerminalProviderHandle},
};

const MAX_HEADER: usize = 8 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const PATH: &str = "/api/fleet/terminal";
const MAX_SESSION_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const OUTPUT_QUEUE_WAIT: Duration = Duration::from_millis(100);

struct ActiveGeneration {
    generation: Generation,
    cancellation: CancellationToken,
}

type ActiveGenerations = HashMap<SessionId, ActiveGeneration>;

struct SessionFinalizer {
    tickets: Arc<dyn TicketPort>,
    generations: Arc<Mutex<ActiveGenerations>>,
    session: SessionId,
    generation: Generation,
    finalized: bool,
}

impl SessionFinalizer {
    fn new(
        tickets: Arc<dyn TicketPort>,
        generations: Arc<Mutex<ActiveGenerations>>,
        session: SessionId,
        generation: Generation,
    ) -> Self {
        Self {
            tickets,
            generations,
            session,
            generation,
            finalized: false,
        }
    }

    async fn finalize(&mut self, handle: Option<&mut TerminalProviderHandle>) {
        if self.finalized {
            return;
        }
        self.finalized = true;
        if let Some(handle) = handle {
            handle.close().await;
        }
        remove_active_generation(&self.generations, &self.session, self.generation).await;
        let _ = self
            .tickets
            .close(self.session.clone(), self.generation)
            .await;
    }
}

#[derive(Clone, Debug)]
pub struct TerminalContext {
    pub session: SessionId,
    pub target: TargetId,
    pub provider: ProviderId,
    pub generation: Generation,
    pub node: fleet::topology::NodeId,
    pub endpoint: platform::endpoint::EndpointId,
    pub rows: u16,
    pub cols: u16,
}

pub trait TicketPort: Send + Sync + 'static {
    fn consume(
        &self,
        ticket: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = Result<TerminalContext, TicketError>> + Send>>;

    fn close(
        &self,
        session: SessionId,
        generation: Generation,
    ) -> Pin<Box<dyn Future<Output = Result<(), TicketError>> + Send>>;
}

/// Host actor adapter for one-time terminal tickets and lifecycle closure.
///
/// Ticket redemption and close both execute through the Host actor, so the
/// transport never owns a second session map or fabricates authorization facts.
pub struct HostTicketPort {
    owner: crate::owner::Handle,
}

impl HostTicketPort {
    pub fn new(owner: crate::owner::Handle) -> Self {
        Self { owner }
    }
}

impl TicketPort for HostTicketPort {
    fn consume(
        &self,
        ticket: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = Result<TerminalContext, TicketError>> + Send>> {
        let owner = self.owner.clone();
        Box::pin(async move {
            let summary = owner
                .fleet_terminal_consume_ticket(ticket)
                .await
                .map_err(|_| TicketError::Unavailable)?
                .map_err(|_| TicketError::Invalid)?;
            let session = summary.id().clone();
            let generation = summary.generation();
            match owner.fleet_terminal_context(summary).await {
                Ok(Some(context)) => Ok(context),
                Ok(None) => {
                    let _ = owner.fleet_terminal_close_fenced(session, generation).await;
                    Err(TicketError::Invalid)
                }
                Err(_) => {
                    let _ = owner.fleet_terminal_close_fenced(session, generation).await;
                    Err(TicketError::Unavailable)
                }
            }
        })
    }

    fn close(
        &self,
        session: SessionId,
        generation: Generation,
    ) -> Pin<Box<dyn Future<Output = Result<(), TicketError>> + Send>> {
        let owner = self.owner.clone();
        Box::pin(async move {
            owner
                .fleet_terminal_close_fenced(session, generation)
                .await
                .map_err(|_| TicketError::Unavailable)?
                .map(|_| ())
                .map_err(|error| match error {
                    fleet::terminal::TerminalSessionError::InvalidState => TicketError::Fenced,
                    _ => TicketError::Unavailable,
                })
        })
    }
}

/// The construction seam for the Fleet terminal server.
///
/// The transport consumes one-time tickets and delegates target effects to the
/// Host-composed provider. It does not mint tickets or accept public target
/// configuration.
#[derive(Clone)]
pub struct ServerDependencies {
    tickets: Arc<dyn TicketPort>,
    provider: Arc<dyn TerminalProvider>,
    generations: Arc<Mutex<ActiveGenerations>>,
    shutdown: CancellationToken,
}

impl ServerDependencies {
    pub fn new(tickets: Arc<dyn TicketPort>, provider: Arc<dyn TerminalProvider>) -> Self {
        Self {
            tickets,
            provider,
            generations: Arc::new(Mutex::new(HashMap::new())),
            shutdown: CancellationToken::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TicketError {
    Invalid,
    Expired,
    Fenced,
    Unavailable,
}

#[derive(Debug)]
pub enum ServerError {
    Io(io::Error),
    AlreadyBound,
}
impl From<io::Error> for ServerError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub struct Server {
    listener: TcpListener,
    tickets: Arc<dyn TicketPort>,
    provider: Arc<dyn TerminalProvider>,
    generations: Arc<Mutex<ActiveGenerations>>,
    shutdown: CancellationToken,
}

impl Server {
    pub async fn bind(port: u16, dependencies: ServerDependencies) -> Result<Self, ServerError> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            tickets: dependencies.tickets,
            provider: dependencies.provider,
            generations: dependencies.generations,
            shutdown: dependencies.shutdown,
        })
    }

    pub async fn run(self) -> io::Result<()> {
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => return Ok(()),
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted?;
                    let tickets = Arc::clone(&self.tickets);
                    let provider = Arc::clone(&self.provider);
                    let generations = Arc::clone(&self.generations);
                    let shutdown = self.shutdown.clone();
                    tokio::spawn(async move {
                        let _ = serve(stream, tickets, provider, generations, shutdown).await;
                    });
                }
            }
        }
    }

    #[cfg(test)]
    pub fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("terminal listener address")
            .port()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

pub(crate) async fn serve_connection(
    stream: TcpStream,
    dependencies: ServerDependencies,
) -> io::Result<()> {
    serve(
        stream,
        dependencies.tickets,
        dependencies.provider,
        dependencies.generations,
        dependencies.shutdown,
    )
    .await
}

async fn serve(
    mut stream: TcpStream,
    tickets: Arc<dyn TicketPort>,
    provider: Arc<dyn TerminalProvider>,
    generations: Arc<Mutex<ActiveGenerations>>,
    shutdown: CancellationToken,
) -> io::Result<()> {
    let request = match timeout(HANDSHAKE_TIMEOUT, read_upgrade(&mut stream)).await {
        Ok(Ok(request)) => request,
        _ => return write_http_error(&mut stream, 400, "invalid terminal upgrade").await,
    };
    serve_upgrade_inner(
        stream,
        request.path,
        request.key,
        request.websocket,
        tickets,
        provider,
        generations,
        shutdown,
    )
    .await
}

pub(crate) async fn serve_upgrade(
    stream: TcpStream,
    path: String,
    key: String,
    websocket: bool,
    dependencies: ServerDependencies,
) -> io::Result<()> {
    serve_upgrade_inner(
        stream,
        path,
        key,
        websocket,
        dependencies.tickets,
        dependencies.provider,
        dependencies.generations,
        dependencies.shutdown,
    )
    .await
}

async fn serve_upgrade_inner(
    mut stream: TcpStream,
    path: String,
    key: String,
    websocket: bool,
    tickets: Arc<dyn TicketPort>,
    provider: Arc<dyn TerminalProvider>,
    generations: Arc<Mutex<ActiveGenerations>>,
    shutdown: CancellationToken,
) -> io::Result<()> {
    if path != PATH || !websocket {
        return write_http_error(&mut stream, 404, "terminal route is not available").await;
    }
    write_upgrade(&mut stream, &key).await?;
    let first = match timeout(HANDSHAKE_TIMEOUT, read_frame(&mut stream)).await {
        Ok(Ok(frame)) if frame.opcode == 1 => frame,
        _ => {
            let _ = write_json(
                &mut stream,
                serde_json::json!({"type":"terminal.error","code":"invalid_ticket_frame"}),
            )
            .await;
            let _ = write_frame(&mut stream, 8, &[]).await;
            return Ok(());
        }
    };
    let ticket = match parse_ticket(&first.payload) {
        Some(ticket) => ticket,
        None => {
            let _ = write_json(
                &mut stream,
                serde_json::json!({"type":"terminal.error","code":"invalid_ticket"}),
            )
            .await;
            let _ = write_frame(&mut stream, 8, &[]).await;
            return Ok(());
        }
    };
    let context = match tickets.consume(ticket).await {
        Ok(context) => context,
        Err(_) => {
            let _ = write_json(
                &mut stream,
                serde_json::json!({"type":"terminal.error","code":"invalid_ticket"}),
            )
            .await;
            let _ = write_frame(&mut stream, 8, &[]).await;
            return Ok(());
        }
    };
    let cancellation = {
        let mut active = generations.lock().await;
        if active
            .get(&context.session)
            .is_some_and(|entry| entry.generation >= context.generation)
        {
            None
        } else {
            let cancellation = CancellationToken::new();
            if let Some(previous) = active.insert(
                context.session.clone(),
                ActiveGeneration {
                    generation: context.generation,
                    cancellation: cancellation.clone(),
                },
            ) {
                previous.cancellation.cancel();
            }
            Some(cancellation)
        }
    };
    let cancellation = match cancellation {
        Some(cancellation) => cancellation,
        None => {
            let _ = write_frame(&mut stream, 8, &[]).await;
            return Ok(());
        }
    };
    let mut finalizer = SessionFinalizer::new(
        Arc::clone(&tickets),
        Arc::clone(&generations),
        context.session.clone(),
        context.generation,
    );
    let opened = tokio::select! {
        result = provider.open(context.clone()) => match result {
            Ok(opened) => opened,
            Err(_) => {
                finalizer.finalize(None).await;
                let _ = write_json(
                    &mut stream,
                    serde_json::json!({"type":"terminal.error","code":"provider_unavailable"}),
                )
                .await;
                let _ = write_frame(&mut stream, 8, &[]).await;
                return Ok(());
            }
        },
        _ = cancellation.cancelled() => {
            finalizer.finalize(None).await;
            let _ = write_frame(&mut stream, 8, &[]).await;
            return Ok(());
        },
        _ = shutdown.cancelled() => {
            finalizer.finalize(None).await;
            let _ = write_frame(&mut stream, 8, &[]).await;
            return Ok(());
        },
    };
    let mut handle = TerminalProviderHandle::new(opened.commands);
    if write_json(
        &mut stream,
        serde_json::json!({"type":"terminal.ready","sessionId":context.session.as_str()}),
    )
    .await
    .is_err()
    {
        finalizer.finalize(Some(&mut handle)).await;
        return Ok(());
    }
    let result = run_session(
        &mut stream,
        &mut handle,
        opened.events,
        cancellation,
        shutdown,
    )
    .await;
    finalizer.finalize(Some(&mut handle)).await;
    let _ = write_frame(&mut stream, 8, &[]).await;
    result
}

async fn run_session(
    stream: &mut TcpStream,
    handle: &mut TerminalProviderHandle,
    mut events: super::provider::TerminalStream,
    cancellation: CancellationToken,
    shutdown: CancellationToken,
) -> io::Result<()> {
    let pending_output = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Ok(()),
            _ = shutdown.cancelled() => return Ok(()),
            frame = read_frame(stream) => match frame {
                Ok(frame) if frame.opcode == 8 => return Ok(()),
                Ok(frame) if frame.opcode == 9 => { write_frame(stream, 10, &frame.payload).await?; },
                Ok(frame) if frame.opcode == 2 => {
                    handle.send(ProviderCommand::Input(frame.payload)).await.map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "provider unavailable"))?;
                },
                Ok(frame) if frame.opcode == 1 => {
                    if process_control(stream, handle, &frame.payload).await? {
                        return Ok(());
                    }
                }
                Ok(_) => return Ok(()),
                Err(_) => return Ok(()),
            },
            event = events.recv() => match event {
                Some(Ok(ProviderEvent::Output(payload))) => {
                    if payload.len() > MAX_PAYLOAD {
                        let _ = write_json(stream, serde_json::json!({"type":"terminal.error","code":"output_overflow"})).await;
                        return Ok(());
                    }
                    let previous = pending_output.fetch_add(payload.len(), std::sync::atomic::Ordering::AcqRel);
                    if previous.saturating_add(payload.len()) > MAX_SESSION_OUTPUT_BYTES {
                        pending_output.fetch_sub(payload.len(), std::sync::atomic::Ordering::AcqRel);
                        let _ = write_json(stream, serde_json::json!({"type":"terminal.error","code":"client_slow"})).await;
                        return Ok(());
                    }
                    let write = timeout(OUTPUT_QUEUE_WAIT, write_frame(stream, 2, &payload)).await;
                    pending_output.fetch_sub(payload.len(), std::sync::atomic::Ordering::AcqRel);
                    match write {
                        Ok(Ok(())) => {}
                        Ok(Err(_)) | Err(_) => {
                            let _ = write_json(stream, serde_json::json!({"type":"terminal.error","code":"client_slow"})).await;
                            return Ok(());
                        }
                    }
                },
                Some(Ok(ProviderEvent::Exit { code })) => {
                    write_json(stream, serde_json::json!({"type":"terminal.exit","code":code})).await?;
                    return Ok(());
                },
                Some(Err(_)) | None => {
                    let _ = write_json(stream, serde_json::json!({"type":"terminal.error","code":"provider_failed"})).await;
                    return Ok(());
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::websocket_accept;

    #[test]
    fn websocket_accept_matches_rfc6455_example() {
        assert_eq!(
            websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }
}

async fn process_control(
    stream: &mut TcpStream,
    handle: &TerminalProviderHandle,
    payload: &[u8],
) -> io::Result<bool> {
    if payload.len() > MAX_CONTROL {
        write_json(
            stream,
            serde_json::json!({"type":"error","code":"control_too_large"}),
        )
        .await?;
        return Ok(false);
    }
    let value = control(
        std::str::from_utf8(payload)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid control"))?,
    )
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid control"))?;
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("terminal.ping") => {
            let mut response = serde_json::Map::new();
            response.insert(
                "type".to_owned(),
                serde_json::Value::String("terminal.pong".to_owned()),
            );
            if let Some(nonce) = value.get("nonce").and_then(serde_json::Value::as_str) {
                response.insert(
                    "nonce".to_owned(),
                    serde_json::Value::String(nonce.to_owned()),
                );
            }
            write_json(stream, serde_json::Value::Object(response)).await?;
            Ok(false)
        }
        Some("terminal.close") => Ok(true),
        Some("terminal.resize") => {
            let rows = value
                .get("rows")
                .and_then(serde_json::Value::as_u64)
                .and_then(|v| u16::try_from(v).ok());
            let cols = value
                .get("cols")
                .and_then(serde_json::Value::as_u64)
                .and_then(|v| u16::try_from(v).ok());
            match (rows, cols) {
                (Some(rows @ 1..=1000), Some(cols @ 1..=1000)) => {
                    handle
                        .send(ProviderCommand::Resize { rows, cols })
                        .await
                        .map_err(|_| {
                            io::Error::new(io::ErrorKind::BrokenPipe, "provider unavailable")
                        })?;
                    Ok(false)
                }
                _ => {
                    write_json(
                        stream,
                        serde_json::json!({"type":"error","code":"invalid_resize"}),
                    )
                    .await?;
                    Ok(false)
                }
            }
        }
        _ => {
            write_json(
                stream,
                serde_json::json!({"type":"error","code":"unknown_control"}),
            )
            .await?;
            Ok(false)
        }
    }
}

async fn write_json(stream: &mut TcpStream, value: serde_json::Value) -> io::Result<()> {
    let body = value.to_string();
    write_frame(stream, 1, body.as_bytes()).await
}
fn parse_ticket(payload: &[u8]) -> Option<Vec<u8>> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let object = value.as_object()?;
    if object.len() != 1 || !object.contains_key("ticket") {
        return None;
    }
    BASE64.decode(object.get("ticket")?.as_str()?).ok()
}

async fn remove_active_generation(
    generations: &Mutex<ActiveGenerations>,
    session: &SessionId,
    generation: Generation,
) {
    let mut active = generations.lock().await;
    if active
        .get(session)
        .is_some_and(|entry| entry.generation == generation)
    {
        active.remove(session);
    }
}

struct UpgradeRequest {
    path: String,
    key: String,
    websocket: bool,
}
async fn read_upgrade(stream: &mut TcpStream) -> io::Result<UpgradeRequest> {
    let mut bytes = Vec::new();
    let mut b = [0; 512];
    loop {
        let n = stream.read(&mut b).await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "upgrade eof"));
        }
        bytes.extend_from_slice(&b[..n]);
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if bytes.len() > MAX_HEADER {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "headers too large",
            ));
        }
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid headers"))?;
    let mut lines = text.split("\r\n");
    let start = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request"))?;
    let mut parts = start.split_whitespace();
    if parts.next() != Some("GET") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid request",
        ));
    }
    let path = parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request path"))?
        .to_owned();
    if parts.next() != Some("HTTP/1.1") || parts.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid request",
        ));
    }
    let mut key = None;
    let mut websocket = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            match name.to_ascii_lowercase().as_str() {
                "sec-websocket-key" => key = Some(value.trim().to_owned()),
                "upgrade" => websocket = value.trim().eq_ignore_ascii_case("websocket"),
                _ => {}
            }
        }
    }
    Ok(UpgradeRequest {
        path,
        key: key
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing websocket key"))?,
        websocket,
    })
}
async fn write_upgrade(stream: &mut TcpStream, key: &str) -> io::Result<()> {
    let accept = websocket_accept(key);
    stream.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes()).await
}

fn websocket_accept(key: &str) -> String {
    // RFC 6455 uses SHA-1. Keep this tiny implementation local because Cargo.toml is frozen.
    let mut state = [
        0x67452301u32,
        0xefcdab89,
        0x98badcfe,
        0x10325476,
        0xc3d2e1f0,
    ];
    let mut input = key.as_bytes().to_vec();
    input.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let bit_len = (input.len() as u64) * 8;
    input.push(0x80);
    while input.len() % 64 != 56 {
        input.push(0);
    }
    input.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in input.chunks_exact(64) {
        let mut words = [0u32; 80];
        for (i, word) in chunk.chunks_exact(4).take(16).enumerate() {
            words[i] = u32::from_be_bytes(word.try_into().unwrap());
        }
        for i in 16..80 {
            words[i] = (words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) =
            (state[0], state[1], state[2], state[3], state[4]);
        for (i, w) in words.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*w);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
    }
    let mut digest = Vec::with_capacity(20);
    for word in state {
        digest.extend_from_slice(&word.to_be_bytes());
    }
    STANDARD.encode(digest)
}
pub(crate) async fn write_http_error(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
) -> io::Result<()> {
    let body = serde_json::json!({"error":message}).to_string();
    stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await
}
