use std::collections::{BTreeMap, VecDeque};

use world_protocol::{
    ids::{Digest, Sequence, StreamId},
    process::{self, Credit, StreamEnd, StreamItem, StreamOpen, TerminalState},
};

use super::error::ProcessError;

pub(super) const WINDOW_BYTES: u64 = 65_536;
pub(super) const WINDOW_ITEMS: u64 = 4;

pub(crate) struct ProcessChunk {
    pub stream_id: StreamId,
    pub content_schema: Digest,
    pub sequence: Sequence,
    pub bytes: Vec<u8>,
}

pub(super) struct Streams {
    streams: BTreeMap<StreamId, Stream>,
}

struct Stream {
    schema: Digest,
    next: u64,
    available_bytes: u64,
    available_items: u64,
    consumed: Option<Sequence>,
    queue: VecDeque<StreamItem>,
    end: Option<StreamEnd>,
}

impl Streams {
    pub(super) fn new() -> Self {
        Self {
            streams: BTreeMap::new(),
        }
    }

    pub(super) fn open(&mut self, open: StreamOpen) -> Result<Credit, ProcessError> {
        if self.streams.contains_key(&open.stream_id)
            || self.streams.len() >= process::MAX_STREAMS_PER_CALL
        {
            return Err(process::ProcessFailure::SequenceMismatch.into());
        }
        self.streams.insert(
            open.stream_id.clone(),
            Stream {
                schema: open.content_schema,
                next: 0,
                available_bytes: WINDOW_BYTES,
                available_items: WINDOW_ITEMS,
                consumed: None,
                queue: VecDeque::with_capacity(WINDOW_ITEMS as usize),
                end: None,
            },
        );
        Ok(Credit {
            id: open.id,
            stream_id: open.stream_id,
            consumed_sequence: None,
            bytes: WINDOW_BYTES,
            items: WINDOW_ITEMS,
        })
    }

    pub(super) fn push(&mut self, item: StreamItem) -> Result<(), ProcessError> {
        let stream = self
            .streams
            .get_mut(&item.stream_id)
            .ok_or(process::ProcessFailure::UnknownCorrelation)?;
        if stream.end.is_some() || item.sequence.0 != stream.next {
            return Err(process::ProcessFailure::SequenceMismatch.into());
        }
        let size = item.bytes.len() as u64;
        if size > stream.available_bytes || stream.available_items == 0 {
            return Err(process::ProcessFailure::CreditExceeded.into());
        }
        stream.next = stream
            .next
            .checked_add(1)
            .ok_or(process::ProcessFailure::SequenceMismatch)?;
        stream.available_bytes -= size;
        stream.available_items -= 1;
        stream.queue.push_back(item);
        Ok(())
    }

    pub(super) fn end(&mut self, end: StreamEnd) -> Result<(), ProcessError> {
        let stream = self
            .streams
            .get_mut(&end.stream_id)
            .ok_or(process::ProcessFailure::UnknownCorrelation)?;
        let expected = stream.next.checked_sub(1).map(Sequence);
        if stream.end.is_some() || end.last_sequence != expected {
            return Err(process::ProcessFailure::SequenceMismatch.into());
        }
        stream.end = Some(end);
        Ok(())
    }

    pub(super) fn pop(&mut self) -> Option<(ProcessChunk, Option<Credit>)> {
        for stream in self.streams.values_mut() {
            if let Some(item) = stream.queue.pop_front() {
                stream.consumed = Some(item.sequence);
                let credit = if stream.end.is_none() {
                    stream.available_bytes += item.bytes.len() as u64;
                    stream.available_items += 1;
                    Some(Credit {
                        id: item.id,
                        stream_id: item.stream_id.clone(),
                        consumed_sequence: stream.consumed,
                        bytes: item.bytes.len() as u64,
                        items: 1,
                    })
                } else {
                    None
                };
                return Some((
                    ProcessChunk {
                        stream_id: item.stream_id,
                        content_schema: stream.schema.clone(),
                        sequence: item.sequence,
                        bytes: item.bytes,
                    },
                    credit,
                ));
            }
        }
        None
    }

    pub(super) fn remote_ended(&self) -> bool {
        self.streams.values().all(|stream| stream.end.is_some())
    }
    pub(super) fn consumed(&self) -> bool {
        self.streams.values().all(|stream| stream.queue.is_empty())
    }
    pub(super) fn completed(&self) -> bool {
        self.streams.values().all(|stream| {
            stream
                .end
                .as_ref()
                .is_some_and(|end| end.state == TerminalState::Completed)
        })
    }
}
