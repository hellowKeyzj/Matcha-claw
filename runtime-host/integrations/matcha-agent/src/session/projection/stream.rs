use super::{Message, id, message_with_event, payload, prefix, rejected, trace_shape};
use crate::{client::Event, session::rpc::Failure};
use serde_json::{Value, json};
use sessions_module::state::{
    ItemStatus, MAX_ITEMS, MAX_SEGMENTS, MAX_TEXT_BYTES, MAX_TOOLS, ToolPhase,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};

#[derive(Clone)]
struct Block {
    body: Arc<Value>,
    input_text: Arc<String>,
    item_id: String,
    open: bool,
    published: bool,
}
impl Block {
    fn meaningful(&self) -> bool {
        match self.body["type"].as_str() {
            Some("text") => self.body["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty()),
            Some("thinking") => self.body["thinking"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty()),
            _ => true,
        }
    }
    fn project(&self, native: &Event, status: ItemStatus) -> Result<Message, Failure> {
        let row = json!({"type":"assistant","uuid":self.item_id,"message":{"content":[self.body.as_ref()]}});
        let mut message = message_with_event(&row, status, Some(native))?
            .ok_or_else(|| rejected(&native.payload, "stream.preview_missing", Some(native)))?;
        if !self.input_text.is_empty() {
            for tool in &mut message.tools {
                tool.input_text = Some(self.input_text.as_ref().clone());
                tool.phase = ToolPhase::Updated;
            }
        }
        Ok(message)
    }
}

#[derive(Clone)]
struct Stream {
    parent: String,
    provider_id: String,
    identity: String,
    blocks: BTreeMap<usize, Block>,
    finals: Vec<Arc<Message>>,
}
impl Stream {
    fn trace_state(&self) -> Value {
        json!({
            "parentHash": platform::trace::identifier_hash(&self.parent),
            "providerMessageHash": platform::trace::identifier_hash(&self.provider_id),
            "bufferedBlockCount": self.blocks.len(),
            "bufferedIndices": self.blocks.keys().copied().collect::<Vec<_>>(),
            "openIndices": self.blocks.iter().filter_map(|(index, block)| block.open.then_some(*index)).collect::<Vec<_>>(),
            "finalCount": self.finals.len(),
        })
    }
}

// Only pending responses live here. Candidate clones share every body; mutation
// copies the bounded index and the one changed block, never completed history.
#[derive(Clone, Default)]
pub(crate) struct Streaming {
    instance: Option<Arc<str>>,
    streams: Vec<Arc<Stream>>,
    seen: Arc<VecDeque<String>>,
    stopped: Arc<VecDeque<(String, u64)>>,
    buffered_items: usize,
}
pub(crate) struct StreamMessage {
    pub messages: Vec<Message>,
    pub retired: Vec<String>,
}
impl Streaming {
    pub(crate) fn trace_state(&self, row: &Value) -> Value {
        let parent = row
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        json!({
            "instanceHash": self.instance.as_deref().map(platform::trace::identifier_hash),
            "streamCount": self.streams.len(),
            "bufferedItemCount": self.buffered_items,
            "stream": self.streams.iter().rev().find(|stream| stream.parent == parent).map(|stream| stream.trace_state()),
        })
    }
    fn rejected(&self, native: &Event, reason: &'static str) -> Failure {
        platform::trace::runtime_trace("matcha.session.projection.rejected", || {
            json!({
                "reason": reason,
                "row": trace_shape(&native.payload),
                "stream": self.trace_state(&native.payload),
                "sessionHash": platform::trace::identifier_hash(&native.session_id),
                "nativeSeq": native.seq,
            })
        });
        Failure::InvalidReadback
    }
    fn remember(&mut self, uuid: String) {
        let seen = Arc::make_mut(&mut self.seen);
        if seen.len() == MAX_ITEMS {
            seen.pop_front();
        }
        seen.push_back(uuid);
    }
    fn room(&self, native: &Event) -> Result<(), Failure> {
        if self.buffered_items >= MAX_ITEMS {
            return Err(self.rejected(native, "stream.buffered_item_limit"));
        }
        Ok(())
    }
    fn close(
        &mut self,
        index: usize,
        native: &Event,
        abnormal: Option<ItemStatus>,
    ) -> Result<StreamMessage, Failure> {
        let stream = self.streams.remove(index);
        self.buffered_items -= stream.blocks.len() + stream.finals.len();
        let mut messages = Vec::new();
        let mut retired = Vec::new();
        let mut indices = 0u64;
        for (index, block) in &stream.blocks {
            indices |= 1u64 << index;
            if block.published {
                retired.push(block.item_id.clone());
            }
            // No raw-index -> SDK-UUID correspondence exists. On abnormal close
            // retain all seen previews, including closed blocks, alongside finals.
            if let Some(status) = abnormal
                && block.meaningful()
            {
                messages.push(block.project(native, status)?);
            }
        }
        messages.extend(stream.finals.iter().map(|message| message.as_ref().clone()));
        if abnormal.is_none() {
            let stopped = Arc::make_mut(&mut self.stopped);
            if stopped.len() == MAX_TOOLS {
                stopped.pop_front();
            }
            stopped.push_back((stream.parent.clone(), indices));
        }
        platform::trace::runtime_trace("matcha.session.projection.sealed", || {
            json!({
                "reason": if abnormal.is_some() { "stream.abnormal_boundary" } else { "stream.message_stop" },
                "sessionHash": platform::trace::identifier_hash(&native.session_id),
                "nativeSeq": native.seq,
                "stream": stream.trace_state(),
                "retiredCount": retired.len(),
                "messageCount": messages.len(),
            })
        });
        Ok(StreamMessage { messages, retired })
    }
    fn seal(
        &mut self,
        native: &Event,
        status: ItemStatus,
    ) -> Result<Option<StreamMessage>, Failure> {
        let mut projected = StreamMessage {
            messages: Vec::new(),
            retired: Vec::new(),
        };
        while !self.streams.is_empty() {
            let closed = self.close(0, native, Some(status))?;
            projected.messages.extend(closed.messages);
            projected.retired.extend(closed.retired);
        }
        Arc::make_mut(&mut self.stopped).clear();
        Ok((!projected.messages.is_empty() || !projected.retired.is_empty()).then_some(projected))
    }
    pub fn observe(&mut self, native: &Event) -> Result<Option<StreamMessage>, Failure> {
        let row = &native.payload;
        if matches!(
            native.kind.as_str(),
            "cli.started" | "cli.exited" | "cli.fault"
        ) {
            let instance = row
                .get("instanceId")
                .and_then(Value::as_str)
                .ok_or_else(|| self.rejected(native, "stream.instance_id_missing"))?;
            id(instance).map_err(|_| self.rejected(native, "stream.instance_id_invalid"))?;
            if native.kind == "cli.started" {
                if self.instance.as_deref() == Some(instance) {
                    return Ok(None);
                }
                let projected = self.seal(native, ItemStatus::Streaming)?;
                self.instance = Some(Arc::from(instance));
                return Ok(projected);
            }
            if self
                .instance
                .as_deref()
                .is_some_and(|current| current != instance)
            {
                return Ok(None);
            }
            let projected = self.seal(
                native,
                if native.kind == "cli.fault" {
                    ItemStatus::Error
                } else {
                    ItemStatus::Streaming
                },
            )?;
            self.instance = None;
            return Ok(projected);
        }
        if native.kind != "native.message" {
            return Ok(None);
        }
        if row["type"] == "system"
            && row["subtype"] == "session_state_changed"
            && row["state"] == "idle"
        {
            // Idle seals the response, not its outcome. Missing stop leaves a
            // partial preview; only SDK records carry a known final/error state.
            return self.seal(native, ItemStatus::Streaming);
        }
        let parent = match row.get("parent_tool_use_id") {
            None | Some(Value::Null) => "",
            Some(Value::String(parent)) => {
                id(parent).map_err(|_| self.rejected(native, "stream.parent_id_invalid"))?
            }
            _ => return Err(self.rejected(native, "stream.parent_id_invalid")),
        };
        if row["type"] != "stream_event" {
            let Some(message) = message_with_event(
                row,
                if row.get("error").is_some_and(|error| !error.is_null()) {
                    ItemStatus::Error
                } else {
                    ItemStatus::Final
                },
                Some(native),
            )?
            else {
                return Ok(None);
            };
            let uuid = message.item.item_id();
            if self.seen.iter().any(|seen| seen == uuid)
                || self.streams.iter().any(|stream| {
                    stream
                        .finals
                        .iter()
                        .any(|message| message.item.item_id() == uuid)
                })
            {
                return Ok(None);
            }
            let matching = (row["type"] == "assistant")
                .then(|| row.pointer("/message/id").and_then(Value::as_str))
                .flatten()
                .and_then(|provider| {
                    self.streams.iter().position(|stream| {
                        stream.parent == parent && stream.provider_id == provider
                    })
                });
            if let Some(index) = matching {
                self.room(native)?;
                self.remember(uuid.to_owned());
                Arc::make_mut(&mut self.streams[index])
                    .finals
                    .push(Arc::new(message));
                self.buffered_items += 1;
                return Ok(None);
            }
            self.remember(uuid.to_owned());
            return Ok(Some(StreamMessage {
                messages: vec![message],
                retired: Vec::new(),
            }));
        }
        let event = row
            .get("event")
            .ok_or_else(|| self.rejected(native, "stream.event_missing"))?;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| self.rejected(native, "stream.event_type_invalid"))?;
        if kind == "message_start" {
            let provider = event
                .pointer("/message/id")
                .and_then(Value::as_str)
                .ok_or_else(|| self.rejected(native, "stream.provider_id_missing"))?;
            id(provider).map_err(|_| self.rejected(native, "stream.provider_id_invalid"))?;
            if self
                .streams
                .iter()
                .any(|stream| stream.parent == parent && stream.provider_id == provider)
            {
                return Err(self.rejected(native, "stream.message_start_existing"));
            }
            if self.streams.len() == MAX_TOOLS {
                return Err(self.rejected(native, "stream.count_limit"));
            }
            // Length-prefix scope fields: parent IDs and provider IDs are opaque.
            let mut hash = Sha256::new();
            for part in [self.instance.as_deref().unwrap_or(""), parent, provider] {
                hash.update((part.len() as u64).to_le_bytes());
                hash.update(part.as_bytes());
            }
            hash.update(native.seq.to_le_bytes());
            self.streams.push(Arc::new(Stream {
                parent: parent.to_owned(),
                provider_id: provider.to_owned(),
                identity: format!("{:x}", hash.finalize()),
                blocks: BTreeMap::new(),
                finals: Vec::new(),
            }));
            return Ok(None);
        }
        if !matches!(
            kind,
            "content_block_start" | "content_block_delta" | "content_block_stop" | "message_stop"
        ) {
            return Ok(None);
        }
        let index = if kind == "message_stop" {
            None
        } else {
            Some(
                event
                    .get("index")
                    .and_then(Value::as_u64)
                    .and_then(|index| usize::try_from(index).ok())
                    .filter(|index| *index < MAX_SEGMENTS)
                    .ok_or_else(|| self.rejected(native, "stream.index_invalid"))?,
            )
        };
        let Some(stream_index) = self
            .streams
            .iter()
            .rposition(|stream| stream.parent == parent)
        else {
            // Responses can emit a tool stop after response.completed/message_stop.
            if kind == "content_block_stop"
                && self
                    .stopped
                    .iter()
                    .rev()
                    .find(|(scope, _)| scope == parent)
                    .is_some_and(|(_, indices)| indices & (1u64 << index.unwrap()) != 0)
            {
                return Ok(None);
            }
            return Err(self.rejected(native, "stream.event_without_message"));
        };
        if kind == "message_stop" {
            return self.close(stream_index, native, None).map(Some);
        }
        let index = index.unwrap();
        if kind == "content_block_start" {
            self.room(native)?;
            if self.streams[stream_index].blocks.contains_key(&index) {
                return Err(self.rejected(native, "stream.block_start_duplicate"));
            }
            let body = event
                .get("content_block")
                .ok_or_else(|| self.rejected(native, "stream.block_missing"))?;
            let body = preview_body(body, native)?;
            let stream = Arc::make_mut(&mut self.streams[stream_index]);
            stream.blocks.insert(
                index,
                Block {
                    body: Arc::new(body),
                    input_text: Arc::default(),
                    item_id: format!("stream:{}:{index}", stream.identity),
                    open: true,
                    published: false,
                },
            );
            self.buffered_items += 1;
        } else {
            let block = self.streams[stream_index]
                .blocks
                .get(&index)
                .ok_or_else(|| self.rejected(native, "stream.event_without_block"))?;
            if !block.open {
                return Err(self.rejected(native, "stream.event_after_block_stop"));
            }
            if kind == "content_block_stop" {
                Arc::make_mut(&mut self.streams[stream_index])
                    .blocks
                    .get_mut(&index)
                    .unwrap()
                    .open = false;
                return Ok(None);
            }
            let delta = event
                .get("delta")
                .ok_or_else(|| self.rejected(native, "stream.delta_missing"))?;
            let (field, value, expected) = match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => ("text", delta.get("text"), "text"),
                Some("thinking_delta") => ("thinking", delta.get("thinking"), "thinking"),
                Some("input_json_delta") => ("input", delta.get("partial_json"), "tool_use"),
                _ => return Ok(None),
            };
            if block.body["type"] != expected
                && !(expected == "tool_use" && block.body["type"] == "server_tool_use")
            {
                return Err(self.rejected(native, "stream.delta_block_type_mismatch"));
            }
            let value = value
                .and_then(Value::as_str)
                .ok_or_else(|| self.rejected(native, "stream.delta_value_invalid"))?;
            let current = if field == "input" {
                block.input_text.as_str()
            } else {
                block.body[field].as_str().unwrap_or("")
            };
            let suffix = prefix(value, MAX_TEXT_BYTES.saturating_sub(current.len()));
            if suffix.is_empty() {
                return Ok(None);
            }
            let block = Arc::make_mut(&mut self.streams[stream_index])
                .blocks
                .get_mut(&index)
                .unwrap();
            if field == "input" {
                Arc::make_mut(&mut block.input_text).push_str(suffix);
            } else {
                let Value::String(text) = &mut Arc::make_mut(&mut block.body)[field] else {
                    unreachable!("preview text is validated")
                };
                text.push_str(suffix);
            }
        }
        let block = Arc::make_mut(&mut self.streams[stream_index])
            .blocks
            .get_mut(&index)
            .unwrap();
        if !block.meaningful() {
            return Ok(None);
        }
        let message = block.project(native, ItemStatus::Streaming)?;
        block.published = true;
        Ok(Some(StreamMessage {
            messages: vec![message],
            retired: Vec::new(),
        }))
    }
}

// Store only the bounded fields used by the projection, never raw media/signatures.
fn preview_body(block: &Value, native: &Event) -> Result<Value, Failure> {
    let rejected = |reason| rejected(&native.payload, reason, Some(native));
    Ok(match block.get("type").and_then(Value::as_str) {
        Some("text") => {
            json!({"type":"text","text":prefix(block.get("text").and_then(Value::as_str).ok_or_else(|| rejected("stream.text_invalid"))?, MAX_TEXT_BYTES)})
        }
        Some("thinking") => {
            json!({"type":"thinking","thinking":prefix(block.get("thinking").and_then(Value::as_str).ok_or_else(|| rejected("stream.thinking_invalid"))?, MAX_TEXT_BYTES)})
        }
        Some(kind @ ("tool_use" | "server_tool_use")) => {
            let tool = block
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| rejected("stream.tool_id_missing"))?;
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rejected("stream.tool_name_missing"))?;
            id(tool).map_err(|_| rejected("stream.tool_id_invalid"))?;
            id(name).map_err(|_| rejected("stream.tool_name_invalid"))?;
            json!({"type":kind,"id":tool,"name":name,"input":block.get("input").and_then(payload)})
        }
        Some(kind) => json!({"type":prefix(kind, MAX_TEXT_BYTES)}),
        None => return Err(rejected("stream.block_type_invalid")),
    })
}
