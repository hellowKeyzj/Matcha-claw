use std::io;

use super::{MAX_FRAME_BYTES, invalid_frame, validate_payload};

pub(in super::super) const HEADER_BYTES: usize = 34;
const MAGIC: [u8; 4] = *b"MCGD";
const VERSION: u8 = 7;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(in super::super) enum Message {
    Hello = 1,
    Ready = 2,
    Launch = 3,
    Armed = 4,
    Terminate = 5,
    Disarm = 6,
    AuthorityLost = 7,
    Drain = 8,
    Pending = 9,
    Drained = 10,
    LaunchFailed = 11,
    CleanupUnconfirmed = 12,
}

impl TryFrom<u8> for Message {
    type Error = io::Error;

    fn try_from(value: u8) -> io::Result<Self> {
        match value {
            1 => Ok(Self::Hello),
            2 => Ok(Self::Ready),
            3 => Ok(Self::Launch),
            4 => Ok(Self::Armed),
            5 => Ok(Self::Terminate),
            6 => Ok(Self::Disarm),
            7 => Ok(Self::AuthorityLost),
            8 => Ok(Self::Drain),
            9 => Ok(Self::Pending),
            10 => Ok(Self::Drained),
            11 => Ok(Self::LaunchFailed),
            12 => Ok(Self::CleanupUnconfirmed),
            _ => Err(invalid_frame("unknown custody control message")),
        }
    }
}

#[derive(Debug)]
pub(in super::super) struct Frame {
    pub(in super::super) message: Message,
    pub(in super::super) nonce: [u8; 16],
    pub(in super::super) request_id: u64,
    pub(in super::super) payload: Vec<u8>,
}

impl Frame {
    pub(in super::super) fn new(
        message: Message,
        nonce: [u8; 16],
        request_id: u64,
        payload: Vec<u8>,
    ) -> io::Result<Self> {
        if request_id == 0 {
            return Err(invalid_frame("custody request id must be non-zero"));
        }
        if payload.len() > MAX_FRAME_BYTES {
            return Err(invalid_frame("custody control payload exceeds size limit"));
        }
        validate_payload(message, &payload)?;
        Ok(Self {
            message,
            nonce,
            request_id,
            payload,
        })
    }

    pub(in super::super) fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER_BYTES + self.payload.len());
        bytes.extend_from_slice(&MAGIC);
        bytes.push(VERSION);
        bytes.push(self.message as u8);
        bytes.extend_from_slice(&self.nonce);
        bytes.extend_from_slice(&self.request_id.to_be_bytes());
        bytes.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.payload);
        bytes
    }

    pub(in super::super) fn decode_header(header: &[u8; HEADER_BYTES]) -> io::Result<FrameHeader> {
        if header[..4] != MAGIC {
            return Err(invalid_frame("custody control magic does not match"));
        }
        if header[4] != VERSION {
            return Err(invalid_frame("custody control version is unsupported"));
        }
        let message = Message::try_from(header[5])?;
        let mut nonce = [0_u8; 16];
        nonce.copy_from_slice(&header[6..22]);
        let request_id = u64::from_be_bytes(header[22..30].try_into().expect("fixed header"));
        if request_id == 0 {
            return Err(invalid_frame("custody request id must be non-zero"));
        }
        let payload_len = u32::from_be_bytes(header[30..].try_into().expect("fixed header"));
        if payload_len as usize > MAX_FRAME_BYTES {
            return Err(invalid_frame("custody control payload exceeds size limit"));
        }
        Ok(FrameHeader {
            message,
            nonce,
            request_id,
            payload_len: payload_len as usize,
        })
    }

    pub(in super::super) fn from_header(header: FrameHeader, payload: Vec<u8>) -> io::Result<Self> {
        Self::new(header.message, header.nonce, header.request_id, payload)
    }
}

pub(in super::super) struct FrameHeader {
    message: Message,
    nonce: [u8; 16],
    request_id: u64,
    pub(in super::super) payload_len: usize,
}
