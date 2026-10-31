use std::io;

use serde_json::Value;
use tokio::io::{AsyncWrite, AsyncWriteExt};

use super::{DecodeError, Framing, RequestId, detect_framing};

pub(super) fn next_message(
    buffer: &[u8],
    eof: bool,
) -> Option<(Framing, Result<Vec<u8>, DecodeError>, usize)> {
    let framing = match detect_framing(buffer) {
        Ok(Some(framing)) => framing,
        Ok(None) => {
            return eof
                .then_some((
                    Framing::JsonLines,
                    Err(DecodeError::MalformedHeader),
                    buffer.len(),
                ))
                .filter(|_| !buffer.is_empty());
        }
        Err(error) => return Some((Framing::JsonLines, Err(error), buffer.len())),
    };
    match framing {
        Framing::JsonLines => match buffer.iter().position(|byte| *byte == b'\n') {
            Some(end) => Some((
                Framing::JsonLines,
                Ok(trim_line(&buffer[..end]).to_vec()),
                end + 1,
            )),
            None if eof => Some((
                Framing::JsonLines,
                Ok(trim_line(buffer).to_vec()),
                buffer.len(),
            )),
            None => None,
        },
        Framing::ContentLength { body_bytes } => {
            let header_end = buffer.windows(4).position(|window| window == b"\r\n\r\n")? + 4;
            let total = header_end.checked_add(body_bytes)?;
            if buffer.len() < total {
                return eof.then_some((framing, Err(DecodeError::MalformedJson), buffer.len()));
            }
            Some((framing, Ok(buffer[header_end..total].to_vec()), total))
        }
    }
}

fn trim_line(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

pub(super) fn extract_request_id(payload: &[u8]) -> Option<RequestId> {
    let value = serde_json::from_slice::<Value>(payload).ok()?;
    match value.as_object()?.get("id")? {
        Value::Null => Some(RequestId::Null),
        Value::String(value) => Some(RequestId::String(value.clone())),
        Value::Number(value) => Some(RequestId::Number(value.clone())),
        _ => None,
    }
}

pub(super) async fn write_message<W: AsyncWrite + Unpin>(
    output: &mut W,
    framing: Framing,
    response: &[u8],
) -> io::Result<()> {
    match framing {
        Framing::JsonLines => {
            output.write_all(response).await?;
            output.write_all(b"\n").await?;
        }
        Framing::ContentLength { .. } => {
            let header = format!("Content-Length: {}\r\n\r\n", response.len());
            output.write_all(header.as_bytes()).await?;
            output.write_all(response).await?;
        }
    }
    output.flush().await
}
