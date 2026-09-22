use std::io;

use platform::loopback::RouteOutcome;
use tokio::net::TcpStream;

pub(super) async fn write_response(outcome: RouteOutcome, stream: TcpStream) -> io::Result<()> {
    outcome.write(stream).await
}
