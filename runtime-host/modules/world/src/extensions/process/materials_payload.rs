use std::io::{self, Write};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};
use world_protocol::{
    ids::{Digest, Sequence, StreamId},
    process::{CallId, Credit, ProcessFailure, StreamEnd, StreamItem, StreamOpen, TerminalState},
};

use super::{
    error::ProcessError,
    materials_wire::{self, MaterialsFrame, Payload},
    streams::{Streams, WINDOW_BYTES, WINDOW_ITEMS},
};

/// Bound the complete private JSON before growing its assembly buffer; this is not business usage.
pub(super) fn encode(value: &impl Serialize, maximum: u64) -> Result<Vec<u8>, ProcessError> {
    struct Buffer { bytes: Vec<u8>, maximum: usize, exceeded: bool }
    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.bytes.len().checked_add(bytes.len()).is_none_or(|size| size > self.maximum) {
                self.exceeded = true;
                return Err(io::Error::other("materials payload limit"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    let mut buffer = Buffer { bytes: Vec::new(), maximum: usize::try_from(maximum).unwrap_or(usize::MAX), exceeded: false };
    let result = serde_json::to_writer(&mut buffer, value);
    if buffer.exceeded { return Err(ProcessFailure::FrameTooLarge.into()); }
    result.map_err(|_| super::frame::WireFailure::Codec(world_protocol::wire::CodecFailure::Encode))?;
    Ok(buffer.bytes)
}

pub(super) fn stream_id(id: &CallId) -> Result<StreamId, ProcessError> {
    StreamId::try_new(id.request_id.as_str()).map_err(|_| ProcessFailure::InvalidRequestId.into())
}

pub(super) struct Receiving {
    id: CallId,
    descriptor: Payload,
    streams: Streams,
    bytes: Vec<u8>,
}

impl Receiving {
    pub(super) fn new(id: CallId, descriptor: Payload, schema: &Digest, maximum: u64) -> Result<(Self, Credit), ProcessError> {
        if descriptor.schema != *schema || descriptor.size > maximum || descriptor.size > usize::MAX as u64 {
            return Err(ProcessFailure::FrameTooLarge.into());
        }
        let mut streams = Streams::new();
        let credit = streams.open(StreamOpen { id: id.clone(), stream_id: stream_id(&id)?, content_schema: schema.clone() })?;
        Ok((Self { id, descriptor, streams, bytes: Vec::new() }, credit))
    }

    pub(super) fn fragment(&mut self, item: StreamItem) -> Result<Credit, ProcessError> {
        if item.id != self.id || item.stream_id != stream_id(&self.id)?
            || self.bytes.len() as u64 + item.bytes.len() as u64 > self.descriptor.size {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        self.streams.push(item)?;
        let (chunk, credit) = self.streams.pop().ok_or(ProcessFailure::SequenceMismatch)?;
        self.bytes.extend_from_slice(&chunk.bytes);
        credit.ok_or_else(|| ProcessFailure::SequenceMismatch.into())
    }

    pub(super) fn finish(mut self, end: StreamEnd) -> Result<Vec<u8>, ProcessError> {
        if end.id != self.id || end.stream_id != stream_id(&self.id)? || end.state != TerminalState::Completed {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        self.streams.end(end)?;
        if !self.streams.completed() || !self.streams.consumed() || self.bytes.len() as u64 != self.descriptor.size
            || world_protocol::schema::hash(&self.bytes).map_err(|_| ProcessFailure::FrameMalformed)? != self.descriptor.digest {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        Ok(self.bytes)
    }
}

pub(super) struct Sending {
    id: CallId,
    bytes: Vec<u8>,
    offset: usize,
    next: u64,
    waiting: Option<(Sequence, u64)>,
    initial: bool,
}

impl Sending {
    pub(super) fn new(id: CallId, bytes: Vec<u8>) -> Self {
        Self { id, bytes, offset: 0, next: 0, waiting: None, initial: true }
    }

    /// Reuse the original bounded stream window; one acknowledged fragment is enough here.
    pub(super) fn credit(&mut self, credit: Credit, maximum: usize) -> Result<MaterialsFrame, ProcessError> {
        if credit.id != self.id || credit.stream_id != stream_id(&self.id)? {
            return Err(ProcessFailure::UnknownCorrelation.into());
        }
        if self.initial {
            if credit.consumed_sequence.is_some() || credit.bytes != WINDOW_BYTES || credit.items != WINDOW_ITEMS {
                return Err(ProcessFailure::CreditExceeded.into());
            }
            self.initial = false;
        } else {
            let (sequence, size) = self.waiting.take().ok_or(ProcessFailure::SequenceMismatch)?;
            if credit.consumed_sequence != Some(sequence) || credit.bytes != size || credit.items != 1 {
                return Err(ProcessFailure::CreditExceeded.into());
            }
        }
        if self.offset == self.bytes.len() {
            return Ok(MaterialsFrame::End(StreamEnd { id: self.id.clone(), stream_id: stream_id(&self.id)?,
                last_sequence: self.next.checked_sub(1).map(Sequence), state: TerminalState::Completed }));
        }
        let mut length = (self.bytes.len() - self.offset).min(WINDOW_BYTES as usize / 4);
        loop {
            let fragment = MaterialsFrame::Fragment(StreamItem { id: self.id.clone(), stream_id: stream_id(&self.id)?,
                sequence: Sequence(self.next), bytes: self.bytes[self.offset..self.offset + length].to_vec() });
            if materials_wire::encode(&fragment, maximum).is_ok() {
                self.waiting = Some((Sequence(self.next), length as u64));
                self.next = self.next.checked_add(1).ok_or(ProcessFailure::SequenceMismatch)?;
                self.offset += length;
                return Ok(fragment);
            }
            length /= 2;
            if length == 0 { return Err(ProcessFailure::FrameTooLarge.into()); }
        }
    }
}

pub(super) async fn receive(
    input: &mut (impl AsyncRead + Unpin), output: &mut (impl AsyncWrite + Unpin),
    id: CallId, descriptor: Payload, schema: &Digest, maximum_payload: u64, maximum_frame: usize,
) -> Result<Vec<u8>, ProcessError> {
    let (mut receiving, credit) = Receiving::new(id, descriptor, schema, maximum_payload)?;
    materials_wire::write(output, &MaterialsFrame::Credit(credit), maximum_frame).await?;
    loop {
        match materials_wire::read(input, false, maximum_frame).await? {
            Some(MaterialsFrame::Fragment(item)) => {
                let credit = receiving.fragment(item)?;
                materials_wire::write(output, &MaterialsFrame::Credit(credit), maximum_frame).await?;
            }
            Some(MaterialsFrame::End(end)) => return receiving.finish(end),
            _ => return Err(ProcessFailure::UnexpectedDirection.into()),
        }
    }
}

pub(super) async fn send(
    input: &mut (impl AsyncRead + Unpin), output: &mut (impl AsyncWrite + Unpin),
    id: CallId, bytes: Vec<u8>, maximum: usize, mut first: Option<MaterialsFrame>,
) -> Result<(), ProcessError> {
    let mut sending = Sending::new(id, bytes);
    loop {
        let incoming = match first.take() {
            Some(frame) => Some(frame),
            None => materials_wire::read(input, false, maximum).await?,
        };
        let Some(MaterialsFrame::Credit(credit)) = incoming else {
            return Err(ProcessFailure::UnexpectedDirection.into());
        };
        let next = sending.credit(credit, maximum)?;
        let done = matches!(next, MaterialsFrame::End(_));
        materials_wire::write(output, &next, maximum).await?;
        if done { return Ok(()); }
    }
}
