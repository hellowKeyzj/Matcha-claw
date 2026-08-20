mod config;
mod gateway_token;
mod stdin;
mod webhook_token;

pub(crate) use config::{Bootstrap, BootstrapError};

use tokio::io::Stdin;

pub(crate) async fn read(input: &mut Stdin) -> Result<Bootstrap, BootstrapError> {
    let frame = stdin::read_frame(input).await.map_err(|_| BootstrapError)?;
    config::decode(frame)
}
