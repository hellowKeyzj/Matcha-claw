use std::collections::{BTreeMap, BTreeSet};

use saphyr_parser::{Event, Parser, ScalarStyle};

use super::{Scalar, core_scalar, tags};

fn scalar_key_equal(left: &Scalar, right: &Scalar) -> bool {
    match (left, right) {
        (Scalar::Binary(_) | Scalar::Timestamp(_) | Scalar::Merge, _) => false,
        (Scalar::Number(a), Scalar::Number(b)) if a.is_nan() && b.is_nan() => true,
        _ => left == right,
    }
}

pub(super) enum Kind {
    Scalar(Scalar),
    Sequence(Vec<usize>),
    Mapping(Vec<usize>),
    Alias(Option<usize>, String),
}

pub(super) struct Node {
    pub kind: Kind,
    pub start: usize,
    pub body: usize,
    pub value_source: String,
    pub style: ScalarStyle,
    pub end: usize,
    pub tag: Option<String>,
    pub anchor: Option<String>,
    pub property_comments: Vec<String>,
    pub header_comment: String,
    pub flow: bool,
    pub missing: bool,
}

pub(super) struct Error {
    pub start: usize,
    pub colon_mapping: bool,
}

#[derive(Default)]
pub(super) struct Document {
    pub nodes: Vec<Node>,
    pub error: Option<Error>,
    pub block: String,
    pub notes: Vec<super::presentation::Notes>,
}

impl Document {
    pub fn mapping(&self) -> Option<&[usize]> {
        match &self.nodes.first()?.kind {
            Kind::Mapping(items) => Some(items),
            _ => None,
        }
    }

    pub fn resolve(&self, mut id: usize) -> Result<usize, ()> {
        while let Kind::Alias(target, _) = self.nodes[id].kind {
            id = target.ok_or(())?;
        }
        Ok(id)
    }

    pub fn validate_aliases(&self) -> Result<(), ()> {
        let mut counts = vec![0usize; self.nodes.len()];
        let mut weights = vec![0usize; self.nodes.len()];
        for (id, node) in self.nodes.iter().enumerate() {
            if let Kind::Alias(target, _) = node.kind {
                let target = target.ok_or(())?;
                counts[target] += 1;
                if weights[target] == 0 {
                    weights[target] = self.alias_weight(target, &counts, &weights);
                }
                if counts[target].saturating_mul(weights[target]) > 100 {
                    return Err(());
                }
            } else {
                counts[id] = 1;
            }
        }
        Ok(())
    }

    pub fn validate_conversions(&self) -> Result<(), ()> {
        let mut edges = vec![Vec::new(); self.nodes.len()];
        for (id, node) in self.nodes.iter().enumerate() {
            if let Kind::Mapping(items) = &node.kind {
                for pair in items.chunks_exact(2) {
                    if matches!(self.nodes[pair[0]].kind, Kind::Scalar(Scalar::Merge)) {
                        let source = self.resolve(pair[1])?;
                        let sources = match &self.nodes[source].kind {
                            Kind::Sequence(items) => items.as_slice(),
                            _ => std::slice::from_ref(&source),
                        };
                        for source in sources {
                            let source = self.resolve(*source)?;
                            if !matches!(self.nodes[source].kind, Kind::Mapping(_)) {
                                return Err(());
                            }
                            edges[id].push(source);
                        }
                    }
                }
            }
            if node.tag.as_deref() == Some("tag:yaml.org,2002:omap") {
                if let Kind::Sequence(items) = &node.kind {
                    let mut seen: Vec<Option<usize>> = Vec::new();
                    for item in items {
                        let key = match &self.nodes[*item].kind {
                            Kind::Mapping(items) => items.first().copied(),
                            _ => Some(*item),
                        };
                        let key = key.map(|id| self.resolve(id)).transpose()?;
                        if seen.iter().any(|previous| match (key, *previous) {
                            (Some(a), Some(b)) => a == b || matches!((&self.nodes[a].kind, &self.nodes[b].kind), (Kind::Scalar(a), Kind::Scalar(b)) if scalar_key_equal(a, b)),
                            (None, None) => true,
                            _ => false,
                        }) { return Err(()); }
                        seen.push(key);
                    }
                }
            }
        }
        let mut state = vec![0u8; self.nodes.len()];
        for root in 0..self.nodes.len() {
            let mut pending = vec![(root, false)];
            while let Some((id, exit)) = pending.pop() {
                if exit {
                    state[id] = 2;
                    continue;
                }
                if state[id] == 1 {
                    return Err(());
                }
                if state[id] == 2 {
                    continue;
                }
                state[id] = 1;
                pending.push((id, true));
                pending.extend(edges[id].iter().rev().map(|id| (*id, false)));
            }
        }
        Ok(())
    }

    fn alias_weight(&self, id: usize, counts: &[usize], weights: &[usize]) -> usize {
        let mut pending = vec![id];
        let mut weight = 0;
        while let Some(id) = pending.pop() {
            match &self.nodes[id].kind {
                Kind::Alias(Some(target), _) => {
                    weight = weight.max(counts[*target].saturating_mul(weights[*target]))
                }
                Kind::Alias(None, _) => {}
                Kind::Scalar(_) => weight = weight.max(1),
                Kind::Sequence(items) | Kind::Mapping(items) => pending.extend(items),
            }
        }
        weight
    }

    fn validate_tag(&mut self, id: usize) {
        let node = &self.nodes[id];
        let valid = match (&node.kind, node.tag.as_deref()) {
            (Kind::Mapping(items), Some("tag:yaml.org,2002:set")) => {
                items.chunks_exact(2).all(|pair| {
                    let value = &self.nodes[pair[1]];
                    matches!(value.kind, Kind::Scalar(Scalar::Null))
                        && value.tag.is_none()
                        && super::presentation::uncommented(self, pair[1])
                })
            }
            (Kind::Sequence(items), Some("tag:yaml.org,2002:pairs" | "tag:yaml.org,2002:omap")) => {
                let mut keys: Vec<&Scalar> = Vec::new();
                let mut valid = true;
                for item in items {
                    let key = match &self.nodes[*item].kind {
                        Kind::Mapping(pairs) => {
                            valid &= pairs.len() <= 2;
                            pairs.first().copied()
                        }
                        _ => Some(*item),
                    };
                    if node.tag.as_deref() == Some("tag:yaml.org,2002:omap") {
                        if key.is_none() {
                            valid &= !keys.iter().any(|key| matches!(key, Scalar::Null));
                            keys.push(&Scalar::Null);
                        }
                        if let Some(key) = key {
                            if let Kind::Scalar(value) = &self.nodes[key].kind {
                                valid &= !keys.iter().any(|other| scalar_key_equal(value, other));
                                keys.push(value);
                            }
                        }
                    }
                }
                valid
            }
            _ => true,
        };
        if !valid && self.error.is_none() {
            self.error = Some(Error {
                start: node.start,
                colon_mapping: false,
            });
        }
    }
}

// saphyr uses NUL as EOF. Keep one character per input character, reserving a
// representation absent from both literal text and decoded YAML Unicode escapes.
fn nul_representation(block: &str) -> Result<Option<char>, ()> {
    if !block.contains('\0') {
        return Ok(None);
    }
    let mut used: BTreeSet<_> = block.chars().collect();
    for (index, _) in block.match_indices('\\') {
        let width = match block.as_bytes().get(index + 1) {
            Some(b'x') => 2,
            Some(b'u') => 4,
            Some(b'U') => 8,
            _ => continue,
        };
        if let Some(ch) = block
            .get(index + 2..index + 2 + width)
            .and_then(|digits| u32::from_str_radix(digits, 16).ok())
            .and_then(char::from_u32)
        {
            used.insert(ch);
        }
    }
    (0xe000..=0xf8ff)
        .chain(0xf0000..=0xffffd)
        .chain(0x100000..=0x10fffd)
        .filter_map(char::from_u32)
        .find(|ch| !used.contains(ch))
        .map(Some)
        .ok_or(())
}

fn restore_nul(value: String, representation: Option<char>) -> String {
    match representation {
        Some(ch) if value.contains(ch) => value.replace(ch, "\0"),
        _ => value,
    }
}

fn nul_tag_end(block: &str, start: usize) -> Option<usize> {
    let uri = block.get(start..)?.strip_prefix("!<")?;
    let boundary = uri.find(['>', ' ', '\t', '\r', '\n'])?;
    (uri.as_bytes()[boundary] == b'>' && uri[..boundary].contains('\0'))
        .then_some(start + 2 + boundary + 1)
}

// Recover only presentation metadata from the event prefix and block-scalar header.
// In particular, '&' in a comment or a verbatim tag is not an anchor.
fn properties(
    block: &str,
    from: usize,
    to: usize,
    limit: usize,
) -> (
    usize,
    usize,
    Option<String>,
    Vec<String>,
    String,
    Option<(usize, usize)>,
) {
    let mut index = from;
    let mut start = to;
    let mut end = to;
    let mut anchor = None;
    let mut comments = Vec::new();
    let mut header_comment = String::new();
    let mut original_tag = None;
    while index < limit {
        match block.as_bytes()[index] {
            b' ' | b'\t' | b'\r' | b'\n' | b':' | b',' | b'?' | b'-' => index += 1,
            b'#' => {
                let length = block[index..limit].find('\n').unwrap_or(limit - index);
                if start < to {
                    comments.push(block[index..index + length].to_owned());
                }
                index += length;
            }
            b'&' | b'!' => {
                let property = index;
                let is_anchor = block.as_bytes()[index] == b'&';
                index += 1;
                if !is_anchor && block.as_bytes().get(index) == Some(&b'<') {
                    index += block[index..limit]
                        .find('>')
                        .map_or(limit - index, |end| end + 1);
                    original_tag = Some((property, index));
                } else {
                    index += block[index..limit]
                        .find([' ', '\t', '\r', '\n', '[', ']', '{', '}', ','])
                        .unwrap_or(limit - index);
                }
                start = start.min(property);
                end = index;
                if is_anchor {
                    anchor = Some(block[property + 1..index].to_owned());
                }
            }
            b'|' | b'>' => {
                start = start.min(index);
                let line_end = block[index..]
                    .find('\n')
                    .map_or(block.len(), |end| index + end);
                if let Some(hash) = block[index..line_end].find('#') {
                    header_comment = block[index + hash..line_end].to_owned();
                }
                break;
            }
            _ => break,
        }
    }
    (start, end, anchor, comments, header_comment, original_tag)
}

fn flow_end(block: &str, start: usize) -> Result<usize, ()> {
    let mut index = start;
    while let Some(ch) = block.as_bytes().get(index) {
        match ch {
            b' ' | b'\t' | b'\r' | b'\n' | b',' => index += 1,
            b'#' => index += block[index..].find('\n').unwrap_or(block.len() - index),
            b']' | b'}' => return Ok(index + 1),
            _ => return Err(()),
        }
    }
    Err(())
}

pub(super) fn parse(block: &str) -> Result<Document, ()> {
    let representation = nul_representation(block)?;
    // Marker indices count Unicode scalars, including in saphyr-parser 0.1.2.
    let offsets: Vec<_> = block
        .char_indices()
        .map(|(index, _)| index)
        .chain([block.len()])
        .collect();
    let (doc, locate) = parse_once(block, &offsets, representation, &BTreeMap::new(), true)?;
    // The exceptional NUL-tag path uses at most three passes, never one retry per tag.
    if locate {
        drop(doc);
        let tags = locate_nul_tags(block, &offsets);
        parse_once(block, &offsets, representation, &tags, false).map(|(doc, _)| doc)
    } else {
        Ok(doc)
    }
}

fn locate_nul_tags(block: &str, offsets: &[usize]) -> BTreeMap<usize, usize> {
    let mut tags = BTreeMap::new();
    let mut cursor = 0;
    let mut documents = 0;
    let input = block.chars().map(|ch| if ch == '\0' { 'a' } else { ch });
    for event in Parser::new_from_iter(input) {
        let Ok((event, span)) = event else { break };
        let start = offsets[span.start.index()];
        let end = offsets[span.end.index()];
        match event {
            Event::DocumentStart(explicit) => {
                documents += 1;
                if documents > 1 {
                    break;
                }
                if explicit {
                    cursor = end;
                }
            }
            Event::DocumentEnd | Event::StreamEnd => break,
            Event::Scalar(_, style, _, tag) => {
                if tag.is_some() {
                    let limit = if matches!(style, ScalarStyle::Literal | ScalarStyle::Folded) {
                        end
                    } else {
                        start
                    };
                    if let Some((start, end)) = properties(block, cursor, start, limit).5 {
                        if nul_tag_end(block, start) == Some(end) {
                            tags.insert(start, end);
                        }
                    }
                }
                cursor = end;
            }
            Event::MappingStart(_, tag) | Event::SequenceStart(_, tag) => {
                if tag.is_some() {
                    if let Some((start, end)) = properties(block, cursor, start, start).5 {
                        if nul_tag_end(block, start) == Some(end) {
                            tags.insert(start, end);
                        }
                    }
                }
                cursor = start
                    + usize::from(
                        end > start && matches!(block.as_bytes().get(start), Some(b'[' | b'{')),
                    );
            }
            Event::MappingEnd | Event::SequenceEnd => {
                cursor = if matches!(block.as_bytes().get(start), Some(b',' | b']' | b'}')) {
                    let Ok(end) = flow_end(block, start) else {
                        break;
                    };
                    end
                } else {
                    start
                }
            }
            Event::Alias(_) => cursor = end,
            _ => {}
        }
    }
    tags
}

fn parse_once(
    block: &str,
    offsets: &[usize],
    representation: Option<char>,
    nul_tags: &BTreeMap<usize, usize>,
    locate: bool,
) -> Result<(Document, bool), ()> {
    let mut doc = Document::default();
    let mut parents = Vec::<usize>::new();
    let mut anchors = BTreeMap::new();
    let mut cursor = 0;
    let mut completed_end = 0;
    let mut documents = 0;
    let mut retry_tag = None;
    let mut ranges = nul_tags.iter().peekable();
    let input = block.char_indices().map(|(index, ch)| {
        while ranges.peek().is_some_and(|(_, end)| index >= **end) {
            ranges.next();
        }
        if ch == '\0' {
            if ranges.peek().is_some_and(|(start, _)| index >= **start) {
                'a'
            } else {
                representation.unwrap()
            }
        } else {
            ch
        }
    });
    for event in Parser::new_from_iter(input) {
        let (event, span) = match event {
            Ok(event) => event,
            Err(error) => {
                let problem = error.info();
                let mut start = *offsets.get(error.marker().index()).ok_or(())?;
                if locate
                    && problem == "while scanning a verbatim tag, did not find the expected '>'"
                    && !nul_tags.contains_key(&start)
                {
                    if let Some(end) = nul_tag_end(block, start) {
                        retry_tag = Some((start, end));
                        break;
                    }
                }
                // JS reports the last item's end for an unclosed flow collection.
                if start == block.len()
                    && (problem.contains("expected ',' or ']'")
                        || problem.contains("expected ',' or '}'"))
                {
                    start = completed_end;
                }
                if doc.error.is_none() {
                    doc.error = Some(Error {
                        start,
                        colon_mapping: problem == "mapping values are not allowed in this context",
                    });
                }
                break;
            }
        };
        if matches!(event, Event::StreamEnd) {
            break;
        }
        let token_start = *offsets.get(span.start.index()).ok_or(())?;
        let token_end = *offsets.get(span.end.index()).ok_or(())?;
        if let Event::DocumentStart(explicit) = event {
            documents += 1;
            if documents > 1 {
                return Err(());
            }
            if explicit {
                cursor = token_end;
            }
            continue;
        }
        if matches!(event, Event::MappingEnd | Event::SequenceEnd) {
            let id = parents.pop().ok_or(())?;
            // Flow token spans include trailing comments; those belong to the parent.
            let end = if doc.nodes[id].flow {
                flow_end(block, token_start)?
            } else {
                token_start
            };
            doc.nodes[id].end = end;
            cursor = end;
            completed_end = end;
            continue;
        }
        let (anchor_id, event_tag) = match &event {
            Event::Scalar(_, _, anchor, tag)
            | Event::MappingStart(anchor, tag)
            | Event::SequenceStart(anchor, tag) => (*anchor, tag.as_deref()),
            Event::Alias(_) => (0, None),
            _ => continue,
        };
        let tag = event_tag.map(|tag| format!("{}{}", tag.handle, tag.suffix));
        let properties_limit = if matches!(
            &event,
            Event::Scalar(_, ScalarStyle::Literal | ScalarStyle::Folded, _, _)
        ) {
            token_end
        } else {
            token_start
        };
        let (mut start, properties_end, anchor, property_comments, header_comment, original_tag) =
            properties(block, cursor, token_start, properties_limit);
        let tag = tag.map(|tag| {
            original_tag.map_or(tag, |(start, end)| block[start + 2..end - 1].to_owned())
        });
        let anchor = (anchor_id != 0).then_some(anchor).flatten();
        let mut end = token_end;
        let mut body = token_start;
        let mut style = ScalarStyle::Plain;
        let mut flow = false;
        let mut missing = false;
        let mut value_source = String::new();
        let node = match event {
            Event::Scalar(value, scalar_style, _, _) => {
                style = scalar_style;
                let value = restore_nul(value.into_owned(), representation);
                value_source = value.clone();
                if value.is_empty() && style == ScalarStyle::Plain {
                    missing = tag.is_none() && anchor_id == 0;
                    end = properties_end;
                    if missing {
                        // Empty-value spans may point at ':' or include the next token.
                        let value = parents.last().is_some_and(|id| matches!(&doc.nodes[*id].kind, Kind::Mapping(items) if items.len() % 2 == 1));
                        start = token_start
                            + usize::from(
                                value && block.as_bytes().get(token_start) == Some(&b':'),
                            );
                        end = start;
                    }
                }
                let value = if let Some(resolved) = tags::resolve(&value, tag.as_deref()) {
                    match resolved {
                        Ok(value) => value,
                        Err(()) => {
                            if doc.error.is_none() {
                                doc.error = Some(Error {
                                    start,
                                    colon_mapping: false,
                                });
                            }
                            Scalar::String(value)
                        }
                    }
                } else {
                    core_scalar(&value, style == ScalarStyle::Plain, tag.as_deref())
                };
                Kind::Scalar(value)
            }
            Event::Alias(target) => {
                let name = block.get(token_start + 1..token_end).ok_or(())?.to_owned();
                Kind::Alias(anchors.get(&target).copied(), name)
            }
            Event::MappingStart(_, _) | Event::SequenceStart(_, _) => {
                flow = token_end > token_start
                    && matches!(block.as_bytes().get(token_start), Some(b'[' | b'{'));
                body = token_start + usize::from(flow);
                end = body;
                if matches!(event, Event::MappingStart(_, _)) {
                    Kind::Mapping(Vec::new())
                } else {
                    Kind::Sequence(Vec::new())
                }
            }
            _ => unreachable!(),
        };
        let id = doc.nodes.len();
        if let Some(parent) = parents.last().copied() {
            let duplicate = match (&doc.nodes[parent].kind, &node) {
                (Kind::Mapping(items), Kind::Scalar(value)) if items.len() % 2 == 0 => items.iter().step_by(2).any(|key| {
                    !matches!(value, Scalar::Binary(_) | Scalar::Timestamp(_) | Scalar::Merge)
                        && matches!(&doc.nodes[*key].kind, Kind::Scalar(existing) if existing == value)
                }),
                _ => false,
            };
            if duplicate && doc.error.is_none() {
                doc.error = Some(Error {
                    start,
                    colon_mapping: false,
                });
            }
            match &mut doc.nodes[parent].kind {
                Kind::Mapping(items) | Kind::Sequence(items) => items.push(id),
                _ => unreachable!(),
            }
        }
        let collection = matches!(node, Kind::Mapping(_) | Kind::Sequence(_));
        doc.nodes.push(Node {
            kind: node,
            start,
            body,
            value_source,
            style,
            end,
            tag,
            anchor,
            property_comments,
            header_comment,
            flow,
            missing,
        });
        if anchor_id != 0 {
            anchors.insert(anchor_id, id);
        }
        cursor = end;
        if collection {
            parents.push(id);
        } else {
            completed_end = end;
        }
    }
    if retry_tag.is_some() {
        return Ok((doc, true));
    }
    doc.block = block.to_owned();
    doc.notes = super::presentation::notes(&doc);
    for id in (0..doc.nodes.len()).rev() {
        doc.validate_tag(id);
    }
    Ok((doc, false))
}
