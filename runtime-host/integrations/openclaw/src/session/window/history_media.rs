use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{MessageContent, explicit_media_type, infer_media_type, safe_native_media_reference};
use crate::session::operation::media::{SourceSlot, content_source, fact_source, inline_image_type, media_file_name, media_size_bytes, media_reference, resource_id};

pub(super) fn bind_sources(
    message: &Map<String, Value>,
    native: Option<&Map<String, Value>>,
    native_session: Option<&str>,
    message_id: Option<&str>,
    sequence: Option<u64>,
    content: &mut Vec<MessageContent>,
) {
    let facts = native.and_then(|meta| meta.get("media")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let blocks = message.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let inline_slots = image_slots(native, blocks, facts);
    let mut inline_index = 0;
    let mut used_facts = HashSet::new();
    let mut removed_blocks = HashSet::new();
    for (block_index, block) in blocks.iter().enumerate() {
        let Some(block) = block.as_object() else { continue; };
        let Some(MessageContent::Media { media_type, reference, file_name, size_bytes, resource_id: identity, .. }) = content.get_mut(block_index) else { continue; };
        let source = content_source(block);
        let image_slot = matches!(block.get("type").and_then(Value::as_str), Some("image" | "omitted_media"));
        let slot = if image_slot {
            let slot = inline_slots.as_ref().and_then(|slots| slots.get(inline_index)).copied();
            inline_index += 1;
            slot
        } else { None };
        let fact_index = slot.or_else(|| source.and_then(|source| facts.iter().enumerate()
            .find(|(index, fact)| !used_facts.contains(index) && fact.as_object().is_some_and(|fact|
                ["path", "url"].into_iter().any(|field| fact.get(field).and_then(Value::as_str) == Some(source))))
            .map(|(index, _)| index)));
        if let Some(fact_index) = fact_index {
            used_facts.insert(fact_index);
            let Some(fact) = facts.get(fact_index).and_then(Value::as_object) else { continue; };
            if suppressed(fact) {
                removed_blocks.insert(block_index);
                continue;
            }
            *reference = source_reference(fact_source(fact), SourceSlot::Fact(fact_index), native_session, message_id, sequence);
            *media_type = fact_media_type(fact).or_else(|| media_type.take());
            *file_name = media_file_name(fact).or_else(|| file_name.take());
            *size_bytes = media_size_bytes(fact).or(*size_bytes);
            *identity = source.or_else(|| fact_source(fact)).map(resource_id);
        } else {
            if source.is_some_and(|source| facts.iter().filter_map(Value::as_object).any(|fact|
                suppressed(fact) && ["path", "url"].into_iter().any(|field| fact.get(field).and_then(Value::as_str) == Some(source)))) {
                removed_blocks.insert(block_index);
                continue;
            }
            if let Some(source) = source {
                *reference = source_reference(Some(source), SourceSlot::Content(block_index), native_session, message_id, sequence)
                    .or_else(|| reference.take());
                *media_type = inline_image_type(source).map(str::to_owned).or_else(|| media_type.take());
            }
            if reference.is_none() && image_slot
                && (block.get("omitted").and_then(Value::as_bool) == Some(true) || block.get("type").and_then(Value::as_str) == Some("omitted_media")) {
                removed_blocks.insert(block_index);
            }
        }
    }
    let mut index = 0;
    content.retain(|_| { let retain = !removed_blocks.contains(&index); index += 1; retain });
    for (fact_index, fact) in facts.iter().enumerate() {
        if used_facts.contains(&fact_index) { continue; }
        let Some(fact) = fact.as_object().filter(|fact| !suppressed(fact)) else { continue; };
        let Some(source) = fact_source(fact) else { continue; };
        let reference = source_reference(Some(source), SourceSlot::Fact(fact_index), native_session, message_id, sequence);
        content.push(MessageContent::Media {
            media_type: fact_media_type(fact), reference, bytes: None,
            file_name: media_file_name(fact), size_bytes: media_size_bytes(fact),
            resource_id: Some(resource_id(source)),
        });
    }
}

fn source_reference(
    source: Option<&str>,
    slot: SourceSlot,
    native_session: Option<&str>,
    message_id: Option<&str>,
    sequence: Option<u64>,
) -> Option<String> {
    let source = source?;
    media_reference(native_session, message_id, sequence, slot, source)
        .or_else(|| safe_native_media_reference(source))
}

fn suppressed(fact: &Map<String, Value>) -> bool {
    fact.get("hydrationSuppressed").and_then(Value::as_bool) == Some(true)
}

fn fact_media_type(fact: &Map<String, Value>) -> Option<String> {
    fact.get("contentType").and_then(Value::as_str)
        .filter(|mime| !mime.is_empty() && mime.len() <= 256 && !mime.chars().any(char::is_control)).map(str::to_owned)
        .or_else(|| explicit_media_type(fact))
        .or_else(|| fact_source(fact).and_then(infer_media_type))
        .or_else(|| match fact.get("kind").and_then(Value::as_str) {
            Some("image") => Some("image/*".to_owned()),
            Some("audio") => Some("audio/*".to_owned()),
            Some("video") => Some("video/*".to_owned()),
            Some("document") => Some("application/octet-stream".to_owned()),
            _ => None,
        })
}

fn image_slots(native: Option<&Map<String, Value>>, blocks: &[Value], facts: &[Value]) -> Option<Vec<usize>> {
    let layout = native?.get("mediaImageLayout")?.as_object()?;
    if layout.get("suppressedFactIndexes").and_then(Value::as_array).is_some_and(|indexes| !indexes.is_empty()) { return None; }
    let slots = layout.get("slots")?.as_array()?;
    if slots.is_empty() { return None; }
    let mut used = HashSet::new();
    let mut inline = Vec::new();
    for slot in slots {
        let kind = slot.get("kind")?.as_str()?;
        let index = usize::try_from(slot.get("factIndex")?.as_u64()?).ok().filter(|index| *index < (1 << 31))?;
        fact_source(facts.get(index)?.as_object()?)?;
        if !used.insert(index) { return None; }
        match kind { "inline" => inline.push(index), "offloaded" => {}, _ => return None }
    }
    let image_count = blocks.iter().filter(|block| matches!(block.get("type").and_then(Value::as_str), Some("image" | "omitted_media"))).count();
    (inline.len() == image_count).then_some(inline)
}
