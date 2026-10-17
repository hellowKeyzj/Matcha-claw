use std::net::SocketAddr;

use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{WebSocketStream, tungstenite::protocol::WebSocketConfig};

use super::{Delivery, Error, REQUEST_DEADLINE};

pub(super) type Socket = WebSocketStream<TcpStream>;

pub(super) async fn connect(address: SocketAddr) -> Result<Socket, Error> {
    let stream = timeout(REQUEST_DEADLINE, TcpStream::connect(address))
        .await
        .map_err(|_| Error::local("deadline", Delivery::NotSent))?
        .map_err(|_| Error::local("connect_failed", Delivery::NotSent))?;
    // The management token belongs only in initialize, never the URL or upgrade headers.
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let (socket, _) = timeout(
        REQUEST_DEADLINE,
        tokio_tungstenite::client_async_with_config(
            format!("ws://{address}/ws"),
            stream,
            Some(config),
        ),
    )
    .await
    .map_err(|_| Error::local("deadline", Delivery::NotSent))?
    .map_err(|_| Error::local("upgrade_failed", Delivery::NotSent))?;
    Ok(socket)
}
