use std::{fmt, io};

use tokio::io::{AsyncRead, AsyncReadExt, Stdin};
use zeroize::Zeroize;

const MAX_FRAME_BYTES: usize = 16 * 1024;

pub(super) async fn read_frame(input: &mut Stdin) -> Result<Vec<u8>, Error> {
    read(input).await
}

async fn read(input: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>, Error> {
    let length = input.read_u32().await.map_err(Error::read)? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(Error::invalid());
    }

    let mut frame = vec![0; length];
    if let Err(error) = input.read_exact(&mut frame).await {
        frame.zeroize();
        return Err(Error::read(error));
    }
    Ok(frame)
}

#[derive(Debug)]
pub(super) struct Error {
    kind: ErrorKind,
}

#[derive(Debug)]
enum ErrorKind {
    Read(io::Error),
    Invalid,
}

impl Error {
    fn read(error: io::Error) -> Self {
        Self {
            kind: ErrorKind::Read(error),
        }
    }

    fn invalid() -> Self {
        Self {
            kind: ErrorKind::Invalid,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            ErrorKind::Read(_) => {
                formatter.write_str("runtime-host bootstrap input could not be read")
            }
            ErrorKind::Invalid => formatter.write_str("runtime-host bootstrap input is invalid"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.kind {
            ErrorKind::Read(error) => Some(error),
            ErrorKind::Invalid => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, duplex};

    #[tokio::test]
    async fn reads_one_bounded_frame_without_consuming_following_control_bytes() {
        let (mut writer, mut reader) = duplex(16);
        writer.write_all(&[0, 0, 0, 3, 1, 2, 3, 4]).await.unwrap();

        assert_eq!(read(&mut reader).await.unwrap(), [1, 2, 3]);
        let mut control = [0; 1];
        reader.read_exact(&mut control).await.unwrap();
        assert_eq!(control, [4]);
    }

    #[tokio::test]
    async fn rejects_empty_and_oversized_frames_before_reading_payloads() {
        for header in [[0, 0, 0, 0], ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes()] {
            let (mut writer, mut reader) = duplex(8);
            writer.write_all(&header).await.unwrap();

            assert!(matches!(
                read(&mut reader).await.unwrap_err().kind,
                ErrorKind::Invalid
            ));
        }
    }

    #[tokio::test]
    async fn rejects_truncated_frame_payloads() {
        let (mut writer, mut reader) = duplex(8);
        writer.write_all(&[0, 0, 0, 3, 1, 2]).await.unwrap();
        writer.shutdown().await.unwrap();

        assert!(matches!(
            read(&mut reader).await.unwrap_err().kind,
            ErrorKind::Read(_)
        ));
    }
}
