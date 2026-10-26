use std::{fmt, io};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use world_protocol::{
    process::{self, Frame, ProcessFailure},
    wire::CodecFailure,
};
use zeroize::Zeroizing;

#[derive(Debug)]
pub(super) enum WireFailure {
    Protocol(ProcessFailure),
    Codec(CodecFailure),
    Read(io::Error),
    Write(io::Error),
    Flush(io::Error),
}

impl fmt::Display for WireFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Protocol(_) => "process frame violated its transport contract",
            Self::Codec(_) => "process frame violated its payload contract",
            Self::Read(_) => "process protocol read failed",
            Self::Write(_) => "process protocol write failed",
            Self::Flush(_) => "process protocol flush failed",
        })
    }
}

impl std::error::Error for WireFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Codec(cause) => Some(cause),
            Self::Read(cause) | Self::Write(cause) | Self::Flush(cause) => Some(cause),
            Self::Protocol(_) => None,
        }
    }
}

/// Cancellation of this read closes the session; never resume a partially read frame.
pub(super) async fn read(
    input: &mut (impl AsyncRead + Unpin),
    handshake: bool,
    maximum: usize,
) -> Result<Option<Frame>, WireFailure> {
    let Some(body) = read_body(input, handshake, maximum).await? else { return Ok(None) };
    process::decode_frame(&body, handshake).map(Some).map_err(WireFailure::Codec)
}

pub(super) async fn read_body(
    input: &mut (impl AsyncRead + Unpin),
    handshake: bool,
    maximum: usize,
) -> Result<Option<Zeroizing<Vec<u8>>>, WireFailure> {
    let mut header = [0_u8; 4];
    if input
        .read(&mut header[..1])
        .await
        .map_err(WireFailure::Read)?
        == 0
    {
        return Ok(None);
    }
    read_exact(input, &mut header[1..], ProcessFailure::PartialHeader).await?;
    let length = process::frame_length(header, handshake).map_err(WireFailure::Protocol)?;
    if length > maximum {
        return Err(WireFailure::Protocol(ProcessFailure::FrameTooLarge));
    }
    let mut body = Zeroizing::new(vec![0; length]);
    read_exact(input, &mut body, ProcessFailure::PartialBody).await?;
    Ok(Some(body))
}

async fn read_exact(
    input: &mut (impl AsyncRead + Unpin),
    bytes: &mut [u8],
    partial: ProcessFailure,
) -> Result<(), WireFailure> {
    input.read_exact(bytes).await.map(|_| ()).map_err(|cause| {
        if cause.kind() == io::ErrorKind::UnexpectedEof {
            WireFailure::Protocol(partial)
        } else {
            WireFailure::Read(cause)
        }
    })
}

pub(super) fn encode(
    frame: &Frame,
    handshake: bool,
    maximum: usize,
) -> Result<Zeroizing<Vec<u8>>, WireFailure> {
    let bytes =
        Zeroizing::new(process::encode_frame(frame, handshake).map_err(WireFailure::Codec)?);
    if bytes.len() - 4 > maximum {
        return Err(WireFailure::Protocol(ProcessFailure::FrameTooLarge));
    }
    Ok(bytes)
}

/// Once attempted, any error poisons the ordered pipe; no partial-frame retry.
pub(super) async fn write(
    output: &mut (impl AsyncWrite + Unpin),
    bytes: &[u8],
) -> Result<(), WireFailure> {
    output.write_all(bytes).await.map_err(WireFailure::Write)?;
    output.flush().await.map_err(WireFailure::Flush)
}
