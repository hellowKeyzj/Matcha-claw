use std::{collections::HashMap, future::Future, io, pin::Pin, sync::Arc, time::Duration};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as BASE64},
};
use tokio::{io::AsyncWriteExt, net::TcpStream, sync::Mutex, time::timeout};
use tokio_util::sync::CancellationToken;

use super::provider::TerminalContext;
use super::{
    protocol::{MAX_CONTROL, MAX_PAYLOAD, control, read_frame, write_frame},
    provider::{ProviderCommand, ProviderEvent, TerminalProvider, TerminalProviderHandle},
};
use crate::terminal::{Generation, SessionId};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
pub const TERMINAL_WEBSOCKET_PATH: &str = "/api/remote-fleet/terminal/stream";
pub const PRIVATE_TERMINAL_WEBSOCKET_PATH: &str = "/api/fleet/terminal";
const MAX_SESSION_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const OUTPUT_QUEUE_WAIT: Duration = Duration::from_millis(100);

type TicketFuture<T> = Pin<Box<dyn Future<Output = Result<T, TicketError>> + Send>>;

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

    async fn close(&mut self, handle: Option<&mut TerminalProviderHandle>) {
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

    async fn fail(&mut self, handle: Option<&mut TerminalProviderHandle>) {
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
            .fail(self.session.clone(), self.generation)
            .await;
    }
}

pub trait TicketPort: Send + Sync + 'static {
    fn consume(&self, ticket: Vec<u8>) -> TicketFuture<TerminalContext>;

    fn close(&self, session: SessionId, generation: Generation) -> TicketFuture<()>;

    fn fail(&self, session: SessionId, generation: Generation) -> TicketFuture<()>;
}

pub type TicketSummaryFuture = Pin<
    Box<
        dyn Future<
                Output = Result<
                    Result<crate::terminal::SessionSummary, crate::terminal::TerminalSessionError>,
                    (),
                >,
            > + Send,
    >,
>;
pub type TerminalContextFuture = Pin<
    Box<
        dyn Future<Output = Result<Result<Option<TerminalContext>, crate::FleetDeliveryError>, ()>>
            + Send,
    >,
>;

pub trait FleetTerminalTicketPort: Send + Sync + 'static {
    fn consume_terminal_ticket(&self, ticket: Vec<u8>) -> TicketSummaryFuture;
    fn terminal_context(&self, summary: crate::terminal::SessionSummary) -> TerminalContextFuture;
    fn close_terminal_fenced(
        &self,
        session: SessionId,
        generation: Generation,
    ) -> TicketSummaryFuture;
    fn fail_terminal_fenced(
        &self,
        session: SessionId,
        generation: Generation,
    ) -> TicketSummaryFuture;
}

impl FleetTerminalTicketPort for crate::owner::handle::FleetHandle {
    fn consume_terminal_ticket(&self, ticket: Vec<u8>) -> TicketSummaryFuture {
        let owner = self.clone();
        Box::pin(async move { owner.terminal_consume_ticket(ticket).await.map_err(|_| ()) })
    }

    fn terminal_context(&self, summary: crate::terminal::SessionSummary) -> TerminalContextFuture {
        let owner = self.clone();
        Box::pin(async move { owner.terminal_context(summary).await.map_err(|_| ()) })
    }

    fn close_terminal_fenced(
        &self,
        session: SessionId,
        generation: Generation,
    ) -> TicketSummaryFuture {
        let owner = self.clone();
        Box::pin(async move {
            owner
                .terminal_close_fenced(session, generation)
                .await
                .map_err(|_| ())
        })
    }

    fn fail_terminal_fenced(
        &self,
        session: SessionId,
        generation: Generation,
    ) -> TicketSummaryFuture {
        let owner = self.clone();
        Box::pin(async move {
            owner
                .terminal_fail_fenced(session, generation)
                .await
                .map_err(|_| ())
        })
    }
}

/// Fleet owner adapter for one-time terminal tickets and lifecycle closure.
///
/// Ticket redemption and close execute through the injected owner port, so the
/// transport never owns a second session map or fabricates authorization facts.
pub struct OwnerTicketPort<P> {
    port: Arc<P>,
}

pub type HostTicketPort<P> = OwnerTicketPort<P>;

impl<P> OwnerTicketPort<P> {
    pub fn new(port: Arc<P>) -> Self {
        Self { port }
    }
}

impl<P> TicketPort for OwnerTicketPort<P>
where
    P: FleetTerminalTicketPort,
{
    fn consume(&self, ticket: Vec<u8>) -> TicketFuture<TerminalContext> {
        let port = Arc::clone(&self.port);
        Box::pin(async move {
            let summary = port
                .consume_terminal_ticket(ticket)
                .await
                .map_err(|_| TicketError::Unavailable)?
                .map_err(|_| TicketError::Invalid)?;
            let session = summary.id().clone();
            let generation = summary.generation();
            match port.terminal_context(summary).await {
                Ok(Ok(Some(context))) => Ok(context),
                Ok(Ok(None)) => {
                    let _ = port.close_terminal_fenced(session, generation).await;
                    Err(TicketError::Invalid)
                }
                Ok(Err(_)) | Err(_) => {
                    let _ = port.close_terminal_fenced(session, generation).await;
                    Err(TicketError::Unavailable)
                }
            }
        })
    }

    fn close(&self, session: SessionId, generation: Generation) -> TicketFuture<()> {
        let port = Arc::clone(&self.port);
        Box::pin(async move {
            port.close_terminal_fenced(session, generation)
                .await
                .map_err(|_| TicketError::Unavailable)?
                .map(|_| ())
                .map_err(|error| match error {
                    crate::terminal::TerminalSessionError::InvalidState => TicketError::Fenced,
                    _ => TicketError::Unavailable,
                })
        })
    }

    fn fail(&self, session: SessionId, generation: Generation) -> TicketFuture<()> {
        let port = Arc::clone(&self.port);
        Box::pin(async move {
            port.fail_terminal_fenced(session, generation)
                .await
                .map_err(|_| TicketError::Unavailable)?
                .map(|_| ())
                .map_err(|error| match error {
                    crate::terminal::TerminalSessionError::InvalidState => TicketError::Fenced,
                    _ => TicketError::Unavailable,
                })
        })
    }
}

/// The construction seam for the Fleet terminal server.
///
/// The transport consumes one-time tickets and delegates target effects to the
/// owner-composed provider. It does not mint tickets or accept public target
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

pub async fn serve_upgrade(
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
    if (path != TERMINAL_WEBSOCKET_PATH && path != PRIVATE_TERMINAL_WEBSOCKET_PATH) || !websocket {
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
                finalizer.fail(None).await;
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
            finalizer.close(None).await;
            let _ = write_frame(&mut stream, 8, &[]).await;
            return Ok(());
        },
        _ = shutdown.cancelled() => {
            finalizer.close(None).await;
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
        finalizer.close(Some(&mut handle)).await;
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
    match result {
        Ok(SessionEnd::Closed) => finalizer.close(Some(&mut handle)).await,
        Ok(SessionEnd::ProviderFailed) => finalizer.fail(Some(&mut handle)).await,
        Err(_) => finalizer.close(Some(&mut handle)).await,
    }
    let _ = write_frame(&mut stream, 8, &[]).await;
    result.map(|_| ())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionEnd {
    Closed,
    ProviderFailed,
}

async fn run_session(
    stream: &mut TcpStream,
    handle: &mut TerminalProviderHandle,
    mut events: super::provider::ProviderStream,
    cancellation: CancellationToken,
    shutdown: CancellationToken,
) -> io::Result<SessionEnd> {
    let pending_output = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Ok(SessionEnd::Closed),
            _ = shutdown.cancelled() => return Ok(SessionEnd::Closed),
            frame = read_frame(stream) => match frame {
                Ok(frame) if frame.opcode == 8 => return Ok(SessionEnd::Closed),
                Ok(frame) if frame.opcode == 9 => { write_frame(stream, 10, &frame.payload).await?; },
                Ok(frame) if frame.opcode == 2 => {
                    handle.send(ProviderCommand::Input(frame.payload)).await.map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "provider unavailable"))?;
                },
                Ok(frame) if frame.opcode == 1 => {
                    if process_control(stream, handle, &frame.payload).await? {
                        return Ok(SessionEnd::Closed);
                    }
                }
                Ok(_) => return Ok(SessionEnd::Closed),
                Err(_) => return Ok(SessionEnd::Closed),
            },
            event = events.recv() => match event {
                Some(Ok(ProviderEvent::Output(payload))) => {
                    if payload.len() > MAX_PAYLOAD {
                        let _ = write_json(stream, serde_json::json!({"type":"terminal.error","code":"output_overflow"})).await;
                        return Ok(SessionEnd::Closed);
                    }
                    let previous = pending_output.fetch_add(payload.len(), std::sync::atomic::Ordering::AcqRel);
                    if previous.saturating_add(payload.len()) > MAX_SESSION_OUTPUT_BYTES {
                        pending_output.fetch_sub(payload.len(), std::sync::atomic::Ordering::AcqRel);
                        let _ = write_json(stream, serde_json::json!({"type":"terminal.error","code":"client_slow"})).await;
                        return Ok(SessionEnd::Closed);
                    }
                    let write = timeout(OUTPUT_QUEUE_WAIT, write_frame(stream, 2, &payload)).await;
                    pending_output.fetch_sub(payload.len(), std::sync::atomic::Ordering::AcqRel);
                    match write {
                        Ok(Ok(())) => {}
                        Ok(Err(_)) | Err(_) => {
                            let _ = write_json(stream, serde_json::json!({"type":"terminal.error","code":"client_slow"})).await;
                            return Ok(SessionEnd::Closed);
                        }
                    }
                },
                Some(Ok(ProviderEvent::Exit { code })) => {
                    write_json(stream, terminal_exit_frame(code)).await?;
                    return Ok(SessionEnd::Closed);
                },
                Some(Err(_)) | None => {
                    let _ = write_json(stream, serde_json::json!({"type":"terminal.error","code":"provider_failed"})).await;
                    return Ok(SessionEnd::ProviderFailed);
                },
            }
        }
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

fn terminal_exit_frame(code: Option<i32>) -> serde_json::Value {
    match code {
        Some(code) => serde_json::json!({"type":"terminal.exit","exitCode":code}),
        None => serde_json::json!({"type":"terminal.exit"}),
    }
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

async fn write_upgrade(stream: &mut TcpStream, key: &str) -> io::Result<()> {
    let accept = websocket_accept(key);
    stream.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes()).await
}

fn websocket_accept(key: &str) -> String {
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

pub async fn write_http_error(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
) -> io::Result<()> {
    let body = serde_json::json!({"error":message}).to_string();
    stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use tokio::{io::AsyncReadExt, net::TcpListener, sync::mpsc};

    use super::super::provider::{ProviderError, ProviderOpen};
    use super::*;
    use crate::terminal::{ProviderId, TargetId};

    #[test]
    fn terminal_exit_projection_matches_renderer_fields() {
        assert_eq!(
            terminal_exit_frame(Some(7)),
            serde_json::json!({"type":"terminal.exit","exitCode":7})
        );
        assert_eq!(
            terminal_exit_frame(None),
            serde_json::json!({"type":"terminal.exit"})
        );
    }

    #[test]
    fn websocket_accept_matches_rfc6455_example() {
        assert_eq!(
            websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[tokio::test]
    async fn provider_open_failure_marks_failed_not_closed() {
        let tickets = Arc::new(FakeTickets::new(context()));
        let frames =
            run_fake_session(Arc::clone(&tickets), Arc::new(FakeProvider::open_error())).await;

        assert_eq!(tickets.failed(), 1);
        assert_eq!(tickets.closed(), 0);
        assert!(
            frames.contains(
                &serde_json::json!({"type":"terminal.error","code":"provider_unavailable"})
            )
        );
        assert!(!frames.iter().any(is_terminal_closed));
    }

    #[tokio::test]
    async fn provider_stream_failure_marks_failed_not_closed() {
        let tickets = Arc::new(FakeTickets::new(context()));
        let frames =
            run_fake_session(Arc::clone(&tickets), Arc::new(FakeProvider::stream_error())).await;

        assert_eq!(tickets.failed(), 1);
        assert_eq!(tickets.closed(), 0);
        assert!(
            frames.contains(&serde_json::json!({"type":"terminal.error","code":"provider_failed"}))
        );
        assert!(!frames.iter().any(is_terminal_closed));
    }

    #[tokio::test]
    async fn provider_exit_remains_normal_close() {
        let tickets = Arc::new(FakeTickets::new(context()));
        let frames =
            run_fake_session(Arc::clone(&tickets), Arc::new(FakeProvider::exit(Some(7)))).await;

        assert_eq!(tickets.closed(), 1);
        assert_eq!(tickets.failed(), 0);
        assert!(frames.contains(&serde_json::json!({"type":"terminal.exit","exitCode":7})));
        assert!(!frames.iter().any(is_terminal_closed));
    }

    fn context() -> TerminalContext {
        TerminalContext {
            session: SessionId::try_new("session").unwrap(),
            target: TargetId::try_new("target").unwrap(),
            provider: ProviderId::try_new("ssh").unwrap(),
            generation: Generation::FIRST,
            node: crate::topology::NodeId::try_new("node").unwrap(),
            endpoint: platform::endpoint::EndpointId::try_new("endpoint").unwrap(),
            rows: 24,
            cols: 80,
        }
    }

    async fn run_fake_session(
        tickets: Arc<FakeTickets>,
        provider: Arc<FakeProvider>,
    ) -> Vec<serde_json::Value> {
        let dependencies = ServerDependencies::new(tickets, provider);
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_upgrade(
                stream,
                TERMINAL_WEBSOCKET_PATH.to_owned(),
                "dGhlIHNhbXBsZSBub25jZQ==".to_owned(),
                true,
                dependencies,
            )
            .await
            .unwrap();
        });
        let mut client = TcpStream::connect(address).await.unwrap();
        read_upgrade_response(&mut client).await;
        write_client_frame(
            &mut client,
            1,
            serde_json::json!({"ticket": BASE64.encode(b"ticket")})
                .to_string()
                .as_bytes(),
        )
        .await;
        let frames = read_json_until_close(&mut client).await;
        server.await.unwrap();
        frames
    }

    async fn read_upgrade_response(stream: &mut TcpStream) {
        let mut bytes = Vec::new();
        let mut b = [0; 128];
        while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            let n = stream.read(&mut b).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&b[..n]);
        }
    }

    async fn write_client_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) {
        assert!(payload.len() <= 125);
        let mask = [1, 2, 3, 4];
        let mut frame = vec![0x80 | opcode, 0x80 | payload.len() as u8];
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        stream.write_all(&frame).await.unwrap();
    }

    async fn read_json_until_close(stream: &mut TcpStream) -> Vec<serde_json::Value> {
        let mut frames = Vec::new();
        loop {
            let mut head = [0; 2];
            stream.read_exact(&mut head).await.unwrap();
            let opcode = head[0] & 0x0f;
            let length = match head[1] & 0x7f {
                126 => {
                    let mut b = [0; 2];
                    stream.read_exact(&mut b).await.unwrap();
                    u16::from_be_bytes(b) as usize
                }
                127 => {
                    let mut b = [0; 8];
                    stream.read_exact(&mut b).await.unwrap();
                    u64::from_be_bytes(b) as usize
                }
                n => n as usize,
            };
            let mut payload = vec![0; length];
            stream.read_exact(&mut payload).await.unwrap();
            if opcode == 8 {
                break;
            }
            if opcode == 1 {
                frames.push(serde_json::from_slice(&payload).unwrap());
            }
        }
        frames
    }

    fn is_terminal_closed(value: &serde_json::Value) -> bool {
        value.get("type").and_then(serde_json::Value::as_str) == Some("terminal.closed")
    }

    struct FakeTickets {
        context: TerminalContext,
        closed: StdMutex<usize>,
        failed: StdMutex<usize>,
    }

    impl FakeTickets {
        fn new(context: TerminalContext) -> Self {
            Self {
                context,
                closed: StdMutex::new(0),
                failed: StdMutex::new(0),
            }
        }

        fn closed(&self) -> usize {
            *self.closed.lock().unwrap()
        }

        fn failed(&self) -> usize {
            *self.failed.lock().unwrap()
        }
    }

    impl TicketPort for FakeTickets {
        fn consume(&self, ticket: Vec<u8>) -> TicketFuture<TerminalContext> {
            let context = self.context.clone();
            Box::pin(async move {
                if ticket == b"ticket" {
                    Ok(context)
                } else {
                    Err(TicketError::Invalid)
                }
            })
        }

        fn close(&self, _session: SessionId, _generation: Generation) -> TicketFuture<()> {
            *self.closed.lock().unwrap() += 1;
            Box::pin(async { Ok(()) })
        }

        fn fail(&self, _session: SessionId, _generation: Generation) -> TicketFuture<()> {
            *self.failed.lock().unwrap() += 1;
            Box::pin(async { Ok(()) })
        }
    }

    enum FakeProviderMode {
        OpenError,
        StreamError,
        Exit(Option<i32>),
    }

    struct FakeProvider {
        mode: FakeProviderMode,
    }

    impl FakeProvider {
        fn open_error() -> Self {
            Self {
                mode: FakeProviderMode::OpenError,
            }
        }

        fn stream_error() -> Self {
            Self {
                mode: FakeProviderMode::StreamError,
            }
        }

        fn exit(code: Option<i32>) -> Self {
            Self {
                mode: FakeProviderMode::Exit(code),
            }
        }
    }

    impl TerminalProvider for FakeProvider {
        fn open(&self, _context: TerminalContext) -> super::super::provider::ProviderFuture {
            let mode = match self.mode {
                FakeProviderMode::OpenError => FakeProviderMode::OpenError,
                FakeProviderMode::StreamError => FakeProviderMode::StreamError,
                FakeProviderMode::Exit(code) => FakeProviderMode::Exit(code),
            };
            Box::pin(async move {
                match mode {
                    FakeProviderMode::OpenError => Err(ProviderError::message("open failed")),
                    FakeProviderMode::StreamError => {
                        let (command_tx, _) = mpsc::channel(1);
                        let (event_tx, events) = mpsc::channel(1);
                        event_tx
                            .send(Err(ProviderError::message("stream failed")))
                            .await
                            .unwrap();
                        Ok(ProviderOpen {
                            commands: command_tx,
                            events,
                        })
                    }
                    FakeProviderMode::Exit(code) => {
                        let (command_tx, _) = mpsc::channel(1);
                        let (event_tx, events) = mpsc::channel(1);
                        event_tx
                            .send(Ok(ProviderEvent::Exit { code }))
                            .await
                            .unwrap();
                        Ok(ProviderOpen {
                            commands: command_tx,
                            events,
                        })
                    }
                }
            })
        }
    }
}
