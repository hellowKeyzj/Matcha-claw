use std::{fmt, io};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroize;

pub(crate) const MAX_CONTROL_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FrameError {
    EmptyFrame,
    FrameTooLarge,
    ReadPrefix(io::ErrorKind),
    ReadBody(io::ErrorKind),
    WritePrefix(io::ErrorKind),
    WriteBody(io::ErrorKind),
    Flush(io::ErrorKind),
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyFrame => formatter.write_str("control frame must not be empty"),
            Self::FrameTooLarge => write!(
                formatter,
                "control frame exceeds the {MAX_CONTROL_FRAME_BYTES}-byte limit"
            ),
            Self::ReadPrefix(kind) => {
                write!(
                    formatter,
                    "control frame length prefix read failed ({kind})"
                )
            }
            Self::ReadBody(kind) => write!(formatter, "control frame body read failed ({kind})"),
            Self::WritePrefix(kind) => {
                write!(
                    formatter,
                    "control frame length prefix write failed ({kind})"
                )
            }
            Self::WriteBody(kind) => write!(formatter, "control frame body write failed ({kind})"),
            Self::Flush(kind) => write!(formatter, "control frame flush failed ({kind})"),
        }
    }
}

impl std::error::Error for FrameError {}

pub(crate) async fn encode(
    output: &mut (impl AsyncWrite + Unpin),
    payload: &[u8],
) -> Result<(), FrameError> {
    let length = checked_length(payload.len())?;
    output
        .write_all(&length.to_be_bytes())
        .await
        .map_err(|error| FrameError::WritePrefix(error.kind()))?;
    output
        .write_all(payload)
        .await
        .map_err(|error| FrameError::WriteBody(error.kind()))?;
    output
        .flush()
        .await
        .map_err(|error| FrameError::Flush(error.kind()))
}

#[cfg(test)]
pub(crate) async fn decode(input: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>, FrameError> {
    decode_next(input)
        .await?
        .ok_or(FrameError::ReadPrefix(io::ErrorKind::UnexpectedEof))
}

pub(crate) async fn decode_next(
    input: &mut (impl AsyncRead + Unpin),
) -> Result<Option<Vec<u8>>, FrameError> {
    let mut prefix = [0_u8; size_of::<u32>()];
    let mut read = 0;
    while read < prefix.len() {
        let count = input
            .read(&mut prefix[read..])
            .await
            .map_err(|error| FrameError::ReadPrefix(error.kind()))?;
        if count == 0 {
            prefix.zeroize();
            return if read == 0 {
                Ok(None)
            } else {
                Err(FrameError::ReadPrefix(io::ErrorKind::UnexpectedEof))
            };
        }
        read += count;
    }
    let length = u32::from_be_bytes(prefix) as usize;
    prefix.zeroize();

    if length == 0 {
        return Err(FrameError::EmptyFrame);
    }
    if length > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameError::FrameTooLarge);
    }

    let mut payload = vec![0_u8; length];
    if let Err(error) = input.read_exact(&mut payload).await {
        payload.zeroize();
        return Err(FrameError::ReadBody(error.kind()));
    }
    Ok(Some(payload))
}

fn checked_length(length: usize) -> Result<u32, FrameError> {
    if length == 0 {
        return Err(FrameError::EmptyFrame);
    }
    if length > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameError::FrameTooLarge);
    }
    u32::try_from(length).map_err(|_| FrameError::FrameTooLarge)
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncWriteExt, duplex};

    use super::*;

    #[tokio::test]
    async fn round_trips_a_big_endian_length_prefixed_frame() {
        let payload = br#"{"kind":"ready","version":1}"#;
        let (mut output, mut input) = duplex(1024);

        encode(&mut output, payload).await.unwrap();

        assert_eq!(decode(&mut input).await.unwrap(), payload);
    }

    #[tokio::test]
    async fn rejects_a_zero_length_prefix() {
        let (mut output, mut input) = duplex(1024);
        output.write_all(&0_u32.to_be_bytes()).await.unwrap();

        assert_eq!(decode(&mut input).await, Err(FrameError::EmptyFrame));
    }

    #[tokio::test]
    async fn rejects_a_prefix_larger_than_the_fixed_bound() {
        let (mut output, mut input) = duplex(1024);
        let oversized_length = (MAX_CONTROL_FRAME_BYTES as u32) + 1;
        output
            .write_all(&oversized_length.to_be_bytes())
            .await
            .unwrap();

        assert_eq!(decode(&mut input).await, Err(FrameError::FrameTooLarge));
    }

    #[tokio::test]
    async fn rejects_a_truncated_body() {
        let (mut output, mut input) = duplex(1024);
        output.write_all(&5_u32.to_be_bytes()).await.unwrap();
        output.write_all(b"cut").await.unwrap();
        drop(output);

        assert_eq!(
            decode(&mut input).await,
            Err(FrameError::ReadBody(io::ErrorKind::UnexpectedEof))
        );
    }

    #[tokio::test]
    async fn leaves_json_validation_to_the_higher_layer() {
        let invalid_json = br#"{"kind": "unterminated"#;
        let (mut output, mut input) = duplex(1024);

        encode(&mut output, invalid_json).await.unwrap();

        assert_eq!(decode(&mut input).await.unwrap(), invalid_json);
    }
}
