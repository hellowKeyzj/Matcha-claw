use tokio::io::{AsyncRead, AsyncReadExt, Stdin};

pub(crate) async fn wait(input: &mut Stdin) {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM signal handler must install");
        tokio::select! {
            _ = control_signal(input) => {}
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(windows)]
    {
        tokio::select! {
            _ = control_signal(input) => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
}

async fn control_signal(input: &mut (impl AsyncRead + Unpin)) {
    let mut byte = [0; 1];
    let _ = input.read(&mut byte).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, duplex};

    #[tokio::test]
    async fn control_signal_returns_when_the_pipe_closes() {
        let (writer, mut reader) = duplex(1);
        drop(writer);

        control_signal(&mut reader).await;
    }

    #[tokio::test]
    async fn control_signal_returns_when_the_pipe_carries_unexpected_input() {
        let (mut writer, mut reader) = duplex(1);
        writer.write_all(&[1]).await.unwrap();

        control_signal(&mut reader).await;
    }
}
