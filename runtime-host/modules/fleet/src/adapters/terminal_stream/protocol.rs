use std::{fmt, io};

pub const MAX_PAYLOAD: usize = 1024 * 1024;
pub const MAX_CONTROL: usize = 64 * 1024;
const MAX_WEBSOCKET_CONTROL: usize = 125;

const fn is_supported_opcode(opcode: u8) -> bool {
    matches!(opcode, 0x1 | 0x2 | 0x8..=0xA)
}

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    Invalid,
    TooLarge,
}
impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug)]
pub struct Frame {
    pub opcode: u8,
    pub payload: Vec<u8>,
}

pub async fn read_frame<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Frame, FrameError> {
    use tokio::io::AsyncReadExt;
    let mut head = [0u8; 2];
    reader.read_exact(&mut head).await?;
    let fin = head[0] & 0x80 != 0;
    let opcode = head[0] & 0x0f;
    let masked = head[1] & 0x80 != 0;
    let marker = (head[1] & 0x7f) as usize;
    if !fin
        || !masked
        || head[0] & 0x70 != 0
        || !is_supported_opcode(opcode)
        || (opcode >= 8 && marker > 125)
    {
        return Err(FrameError::Invalid);
    }
    let length = match marker {
        126 => {
            let mut b = [0; 2];
            reader.read_exact(&mut b).await?;
            u16::from_be_bytes(b) as usize
        }
        127 => {
            let mut b = [0; 8];
            reader.read_exact(&mut b).await?;
            usize::try_from(u64::from_be_bytes(b)).map_err(|_| FrameError::TooLarge)?
        }
        n => n,
    };
    let limit = if opcode == 1 || opcode == 2 {
        MAX_PAYLOAD
    } else {
        MAX_CONTROL
    };
    if length > limit {
        return Err(FrameError::TooLarge);
    }
    let mut mask = [0; 4];
    reader.read_exact(&mut mask).await?;
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await?;
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    Ok(Frame { opcode, payload })
}

pub async fn write_frame<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    opcode: u8,
    payload: &[u8],
) -> io::Result<()> {
    use tokio::io::AsyncWriteExt;
    if !is_supported_opcode(opcode) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsupported websocket opcode",
        ));
    }
    let limit = if opcode == 1 || opcode == 2 {
        MAX_PAYLOAD
    } else {
        MAX_CONTROL
    };
    if payload.len() > limit || (opcode >= 8 && payload.len() > MAX_WEBSOCKET_CONTROL) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "websocket payload too large",
        ));
    }
    let mut head = Vec::with_capacity(10);
    head.push(0x80 | opcode);
    match payload.len() {
        n @ 0..=125 => head.push(n as u8),
        n @ 126..=65535 => {
            head.push(126);
            head.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            head.push(127);
            head.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    writer.write_all(&head).await?;
    writer.write_all(payload).await
}

pub fn control(value: &str) -> Result<serde_json::Value, FrameError> {
    if value.len() > MAX_CONTROL {
        return Err(FrameError::TooLarge);
    }
    serde_json::from_str(value).map_err(|_| FrameError::Invalid)
}

pub fn error_message(code: &str) -> Vec<u8> {
    serde_json::json!({"type":"error","code":code})
        .to_string()
        .into_bytes()
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid terminal websocket frame")
    }
}
impl std::error::Error for FrameError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_control_frames_use_the_rfc_maximum_on_write() {
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(write_frame(&mut tokio::io::sink(), 8, &[0; 126]))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}
