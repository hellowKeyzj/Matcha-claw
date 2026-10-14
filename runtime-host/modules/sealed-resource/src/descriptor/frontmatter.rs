use std::collections::BTreeMap;

#[path = "presentation.rs"]
mod presentation;
#[path = "tags.rs"]
mod tags;
#[path = "yaml.rs"]
mod yaml;
use yaml::{Document, Kind};

const FREEFORM_TEXT_FIELDS: [&str; 3] = ["description", "read_when", "summary"];
type Fields = BTreeMap<String, String>;

pub(super) fn parse(content: &str) -> Result<Fields, ()> {
    let Some(mut block) = extract(content)? else {
        return Ok(Fields::new());
    };
    if block.is_empty() {
        return Ok(Fields::new());
    }
    let fallback = line_fallback(&block);
    for attempt in 0..=FREEFORM_TEXT_FIELDS.len() {
        let doc = yaml::parse(&block)?;
        if doc.error.is_none() && doc.mapping().is_some() {
            if let Ok(mut result) = fields(&doc, &block, &fallback) {
                for (key, value) in &fallback {
                    result.entry(key.clone()).or_insert_with(|| value.clone());
                }
                return Ok(result);
            }
        }
        if attempt == FREEFORM_TEXT_FIELDS.len() {
            return Err(());
        }
        let start = if let Some(error) = &doc.error {
            let pos = error.start.min(block.len());
            block[..pos].rfind('\n').map_or(0, |index| index + 1)
        } else {
            doc.mapping().ok_or(())?.chunks_exact(2).find_map(|pair| {
                (matches!(&doc.nodes[pair[0]].kind, Kind::Scalar(Scalar::String(name)) if name == "description")
                    && matches!(doc.nodes[pair[1]].kind, Kind::Alias(_, _)))
                    .then_some(doc.nodes[pair[0]].start)
            }).ok_or(())?
        };
        let line = line_at(&block, start);
        let (key, raw) = simple_field(line, true).ok_or(())?;
        let top_level = doc.mapping().ok_or(())?.iter().step_by(2).any(|id| {
            doc.nodes[*id].start == start
                && matches!(&doc.nodes[*id].kind, Kind::Scalar(Scalar::String(name)) if name == key)
        });
        let raw = trim(raw);
        if !top_level
            || !FREEFORM_TEXT_FIELDS.contains(&key)
            || raw.is_empty()
            || is_block_indicator(raw)
            || (key != "description"
                && !(doc.error.as_ref().is_some_and(|error| error.colon_mapping)
                    && raw.contains(": ")))
        {
            return Err(());
        }
        let replacement = format!(
            "{key}: {}",
            serde_json::to_string(strip_quotes(raw)).map_err(|_| ())?
        );
        if replacement == line {
            return Err(());
        }
        let end = start + line.len();
        block.replace_range(start..end, &replacement);
    }
    Err(())
}

pub(super) fn trim(value: &str) -> &str {
    value.trim_matches(js_whitespace)
}

pub(super) fn boolean(value: Option<&String>, fallback: bool) -> bool {
    match value
        .map(|value| trim(value).to_ascii_lowercase())
        .as_deref()
    {
        Some("true" | "1" | "yes" | "on") => true,
        Some("false" | "0" | "no" | "off") => false,
        _ => fallback,
    }
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn extract(content: &str) -> Result<Option<String>, ()> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let (opening, mut next) = next_line(content, 0);
    if next == content.len() && opening.len() == content.len() || !delimiter(opening) {
        return Ok(None);
    }
    let start = next;
    while next < content.len() {
        let (line, end) = next_line(content, next);
        if delimiter(line) {
            let block = content[start..next]
                .replace("\r\n", "\n")
                .replace('\r', "\n");
            return Ok(Some(block.strip_suffix('\n').unwrap_or(&block).to_owned()));
        }
        next = end;
    }
    Err(())
}

fn next_line(content: &str, start: usize) -> (&str, usize) {
    let end = content[start..]
        .find(['\r', '\n'])
        .map_or(content.len(), |end| start + end);
    let next = if content[end..].starts_with("\r\n") {
        end + 2
    } else if end < content.len() {
        end + 1
    } else {
        end
    };
    (&content[start..end], next)
}

fn delimiter(line: &str) -> bool {
    line.strip_prefix("---")
        .is_some_and(|tail| tail.chars().all(js_whitespace))
}

fn simple_field(line: &str, quoted: bool) -> Option<(&str, &str)> {
    let (key, raw) = line.split_once(':')?;
    let key = if quoted { strip_quotes(key) } else { key };
    (!key.is_empty()
        && key
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'-'))
    .then_some((key, raw.trim_start_matches(js_whitespace)))
}

fn line_fallback(block: &str) -> Fields {
    let lines: Vec<_> = block.split('\n').collect();
    let mut fields = Fields::new();
    let mut index = 0;
    while index < lines.len() {
        if let Some((key, raw)) = simple_field(lines[index], false) {
            let mut value = trim(raw).to_owned();
            if value.is_empty()
                && lines
                    .get(index + 1)
                    .is_some_and(|line| line.starts_with([' ', '\t']))
            {
                let start = index + 1;
                while lines
                    .get(index + 1)
                    .is_some_and(|line| line.is_empty() || line.starts_with([' ', '\t']))
                {
                    index += 1;
                }
                value = trim(&lines[start..=index].join("\n")).to_owned();
            } else {
                value = strip_quotes(&value).to_owned();
            }
            if !value.is_empty() && key != "__proto__" {
                fields.insert(key.to_owned(), value);
            }
        }
        index += 1;
    }
    fields
}

fn strip_quotes(value: &str) -> &str {
    match value.as_bytes() {
        [quote @ (b'\'' | b'"'), .., end] if quote == end => &value[1..value.len() - 1],
        _ => value,
    }
}

fn is_block_indicator(value: &str) -> bool {
    matches!(
        value.as_bytes(),
        [b'|' | b'>']
            | [b'|' | b'>', b'+' | b'-' | b'1'..=b'9']
            | [b'|' | b'>', b'1'..=b'9', b'+' | b'-']
            | [b'|' | b'>', b'+' | b'-', b'1'..=b'9']
    )
}

fn line_at(block: &str, start: usize) -> &str {
    block[start..].split('\n').next().unwrap_or_default()
}

#[derive(PartialEq)]
enum Scalar {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Binary(Vec<u8>),
    Timestamp(String),
    Merge,
}

fn core_scalar(value: &str, plain: bool, tag: Option<&str>) -> Scalar {
    let resolved = if plain || tag.is_some() {
        match value {
            "" | "~" | "null" | "Null" | "NULL" => Scalar::Null,
            "true" | "True" | "TRUE" => Scalar::Bool(true),
            "false" | "False" | "FALSE" => Scalar::Bool(false),
            ".nan" | ".NaN" | ".NAN" => Scalar::Number(f64::NAN),
            ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => Scalar::Number(f64::INFINITY),
            "-.inf" | "-.Inf" | "-.INF" => Scalar::Number(f64::NEG_INFINITY),
            _ => {
                core_number(value).map_or_else(|| Scalar::String(value.to_owned()), Scalar::Number)
            }
        }
    } else {
        Scalar::String(value.to_owned())
    };
    let integer =
        value.starts_with("0x") || value.starts_with("0o") || !value.contains(['.', 'e', 'E']);
    let matches_tag = match tag {
        None => true,
        Some("tag:yaml.org,2002:null") => matches!(resolved, Scalar::Null),
        Some("tag:yaml.org,2002:bool") => matches!(resolved, Scalar::Bool(_)),
        Some("tag:yaml.org,2002:int") => matches!(resolved, Scalar::Number(_)) && integer,
        Some("tag:yaml.org,2002:float") => matches!(resolved, Scalar::Number(_)) && !integer,
        _ => false,
    };
    if matches_tag {
        resolved
    } else {
        Scalar::String(value.to_owned())
    }
}

fn core_number(value: &str) -> Option<f64> {
    for (prefix, radix) in [("0o", 8), ("0x", 16)] {
        if let Some(digits) = value.strip_prefix(prefix) {
            return (!digits.is_empty() && digits.chars().all(|ch| ch.is_digit(radix))).then(
                || {
                    digits.chars().fold(0.0, |number, ch| {
                        number * radix as f64 + ch.to_digit(radix).unwrap() as f64
                    })
                },
            );
        }
    }
    let unsigned = value.strip_prefix(['+', '-']).unwrap_or(value);
    let (mantissa, exponent) = unsigned
        .split_once(['e', 'E'])
        .map_or((unsigned, None), |(mantissa, exponent)| {
            (mantissa, Some(exponent))
        });
    let decimal = !mantissa.is_empty()
        && mantissa.bytes().all(|ch| ch.is_ascii_digit() || ch == b'.')
        && mantissa.bytes().any(|ch| ch.is_ascii_digit())
        && mantissa.bytes().filter(|ch| *ch == b'.').count() <= 1
        && exponent.is_none_or(|value| {
            let value = value.strip_prefix(['+', '-']).unwrap_or(value);
            !value.is_empty() && value.bytes().all(|ch| ch.is_ascii_digit())
        });
    decimal.then(|| value.parse::<f64>().ok()).flatten()
}

fn number_text(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

fn fields(doc: &Document, block: &str, fallback: &Fields) -> Result<Fields, ()> {
    // toJS fails the whole document for unresolved/excessive aliases; JSON cycles
    // only fail the affected field's coerce step.
    doc.validate_aliases()?;
    doc.validate_conversions()?;
    let mut result = Fields::new();
    let entries = if doc.nodes[0].tag.as_deref() == Some("tag:yaml.org,2002:set") {
        Vec::new()
    } else {
        object_entries(doc, doc.mapping().ok_or(())?)?
    };
    for (key, value) in entries {
        let key = trim(&key);
        if key.is_empty() || key == "__proto__" {
            continue;
        }
        let id = doc.resolve(value)?;
        let structured = matches!(
            doc.nodes[id].kind,
            Kind::Mapping(_)
                | Kind::Sequence(_)
                | Kind::Scalar(Scalar::Binary(_) | Scalar::Timestamp(_))
        );
        let text = match &doc.nodes[id].kind {
            Kind::Scalar(Scalar::Null) => continue,
            Kind::Scalar(Scalar::String(value)) => trim(value).to_owned(),
            Kind::Scalar(Scalar::Bool(value)) => value.to_string(),
            Kind::Scalar(Scalar::Number(value)) => number_text(*value),
            Kind::Scalar(Scalar::Merge) => continue,
            _ => match json_text(doc, id) {
                Ok(text) => text,
                Err(()) => continue,
            },
        };
        let inline_colon = doc.mapping().unwrap().chunks_exact(2).any(|pair| {
            simple_field(line_at(block, doc.nodes[pair[0]].start), false)
                .is_some_and(|(name, raw)| name == key && raw.contains(':'))
        });
        let text = if structured && inline_colon {
            fallback.get(key).cloned().unwrap_or(text)
        } else {
            text
        };
        result.insert(key.to_owned(), text);
    }
    Ok(result)
}

fn object_entries(doc: &Document, items: &[usize]) -> Result<Vec<(String, usize)>, ()> {
    let mut entries: Vec<(String, usize)> = Vec::new();
    let maps = merge_maps(doc, items)?;
    for pair in items.chunks_exact(2) {
        if matches!(doc.nodes[pair[0]].kind, Kind::Scalar(Scalar::Merge)) {
            for source in merge_sources(doc, pair[1])? {
                for (key, value) in maps.get(&source).ok_or(())? {
                    let key = js_key(doc, *key)?;
                    if !entries.iter().any(|entry| entry.0 == key) {
                        entries.push((key, *value));
                    }
                }
            }
        } else {
            let key = object_key(doc, pair[0])?;
            if let Some(entry) = entries.iter_mut().find(|entry| entry.0 == key) {
                entry.1 = pair[1];
            } else {
                entries.push((key, pair[1]));
            }
        }
    }
    // JavaScript enumerates array-index properties before insertion-ordered keys.
    entries.sort_by_key(|(key, _)| {
        let index = key
            .parse::<u32>()
            .ok()
            .filter(|index| *index != u32::MAX && index.to_string() == *key);
        (index.is_none(), index.unwrap_or_default())
    });
    Ok(entries)
}

fn merge_sources(doc: &Document, value: usize) -> Result<Vec<usize>, ()> {
    let source = doc.resolve(value)?;
    let sources = match &doc.nodes[source].kind {
        Kind::Sequence(items) => items.clone(),
        _ => vec![source],
    };
    sources
        .into_iter()
        .map(|source| {
            let source = doc.resolve(source)?;
            matches!(doc.nodes[source].kind, Kind::Mapping(_))
                .then_some(source)
                .ok_or(())
        })
        .collect()
}

fn map_key_equal(doc: &Document, a: usize, b: usize) -> Result<bool, ()> {
    let (a, b) = (doc.resolve(a)?, doc.resolve(b)?);
    Ok(a == b
        || match (&doc.nodes[a].kind, &doc.nodes[b].kind) {
            (Kind::Scalar(Scalar::Binary(_) | Scalar::Timestamp(_) | Scalar::Merge), _) => false,
            (Kind::Scalar(Scalar::Number(a)), Kind::Scalar(Scalar::Number(b)))
                if a.is_nan() && b.is_nan() =>
            {
                true
            }
            (Kind::Scalar(a), Kind::Scalar(b)) => a == b,
            _ => false,
        })
}

fn merge_maps(doc: &Document, items: &[usize]) -> Result<BTreeMap<usize, Vec<(usize, usize)>>, ()> {
    let mut maps: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
    let mut pending = Vec::new();
    for pair in items.chunks_exact(2) {
        if matches!(doc.nodes[pair[0]].kind, Kind::Scalar(Scalar::Merge)) {
            pending.extend(
                merge_sources(doc, pair[1])?
                    .into_iter()
                    .map(|id| (id, false)),
            );
        }
    }
    while let Some((id, exit)) = pending.pop() {
        if maps.contains_key(&id) {
            continue;
        }
        let Kind::Mapping(items) = &doc.nodes[id].kind else {
            return Err(());
        };
        if !exit {
            pending.push((id, true));
            for pair in items.chunks_exact(2) {
                if matches!(doc.nodes[pair[0]].kind, Kind::Scalar(Scalar::Merge)) {
                    pending.extend(
                        merge_sources(doc, pair[1])?
                            .into_iter()
                            .map(|id| (id, false)),
                    );
                }
            }
            continue;
        }
        let mut entries: Vec<(usize, usize)> = Vec::new();
        for pair in items.chunks_exact(2) {
            let merge = matches!(doc.nodes[pair[0]].kind, Kind::Scalar(Scalar::Merge));
            let values = if merge {
                let mut values = Vec::new();
                for source in merge_sources(doc, pair[1])? {
                    values.extend_from_slice(maps.get(&source).ok_or(())?);
                }
                values
            } else {
                vec![(pair[0], pair[1])]
            };
            for (key, value) in values {
                let mut found = None;
                for (index, (other, _)) in entries.iter().enumerate() {
                    if map_key_equal(doc, key, *other)? {
                        found = Some(index);
                        break;
                    }
                }
                if let Some(index) = found {
                    if !merge {
                        entries[index].1 = value;
                    }
                } else {
                    entries.push((key, value));
                }
            }
        }
        maps.insert(id, entries);
    }
    Ok(maps)
}

// Merge copies a native Map into an Object, whose property coercion is String(key).
fn js_key(doc: &Document, root: usize) -> Result<String, ()> {
    enum Step {
        Node(usize),
        End(usize),
        Text(&'static str),
    }
    let mut pending = vec![Step::Node(root)];
    let mut active = vec![false; doc.nodes.len()];
    let mut text = String::new();
    while let Some(step) = pending.pop() {
        let id = match step {
            Step::Text(value) => {
                text.push_str(value);
                continue;
            }
            Step::End(id) => {
                active[id] = false;
                continue;
            }
            Step::Node(id) => doc.resolve(id)?,
        };
        match &doc.nodes[id].kind {
            Kind::Scalar(Scalar::Null) => {
                if id == doc.resolve(root)? {
                    text.push_str("null");
                }
            }
            Kind::Scalar(Scalar::String(value)) => text.push_str(value),
            Kind::Scalar(Scalar::Number(value)) => text.push_str(&number_text(*value)),
            Kind::Scalar(Scalar::Bool(value)) => {
                text.push_str(if *value { "true" } else { "false" })
            }
            Kind::Scalar(Scalar::Merge) => return Err(()),
            Kind::Scalar(_) => text.push_str(&presentation::key(doc, id)?),
            Kind::Mapping(_) => text.push_str(
                if doc.nodes[id].tag.as_deref() == Some("tag:yaml.org,2002:set") {
                    "[object Set]"
                } else {
                    "[object Object]"
                },
            ),
            Kind::Sequence(items) => {
                if doc.nodes[id].tag.as_deref() == Some("tag:yaml.org,2002:omap") {
                    text.push_str("[object Map]");
                    continue;
                }
                if active[id] {
                    continue;
                }
                active[id] = true;
                pending.push(Step::End(id));
                for (index, item) in items.iter().enumerate().rev() {
                    pending.push(Step::Node(*item));
                    if index > 0 {
                        pending.push(Step::Text(","));
                    }
                }
            }
            Kind::Alias(_, _) => unreachable!(),
        }
    }
    Ok(text)
}

fn object_key(doc: &Document, id: usize) -> Result<String, ()> {
    let resolved = doc.resolve(id)?;
    match &doc.nodes[resolved].kind {
        Kind::Scalar(Scalar::Null) => Ok(String::new()),
        Kind::Scalar(Scalar::String(value)) => Ok(value.clone()),
        Kind::Scalar(Scalar::Bool(value)) => Ok(value.to_string()),
        Kind::Scalar(Scalar::Number(value)) => Ok(number_text(*value)),
        Kind::Scalar(Scalar::Merge) => Ok("Symbol(<<)".to_owned()),
        _ => presentation::key(doc, id),
    }
}

fn json_text(doc: &Document, id: usize) -> Result<String, ()> {
    enum Step {
        Node(usize),
        Text(String),
        End(usize, char),
    }
    let mut pending = vec![Step::Node(id)];
    let mut active = vec![false; doc.nodes.len()];
    let mut output = Vec::new();
    while let Some(step) = pending.pop() {
        let id = match step {
            Step::Text(text) => {
                output.extend_from_slice(text.as_bytes());
                continue;
            }
            Step::End(id, close) => {
                active[id] = false;
                output.push(close as u8);
                continue;
            }
            Step::Node(id) => doc.resolve(id)?,
        };
        match &doc.nodes[id].kind {
            Kind::Scalar(value) => match value {
                Scalar::Null | Scalar::Merge => output.extend_from_slice(b"null"),
                Scalar::Bool(value) => {
                    output.extend_from_slice(if *value { b"true" } else { b"false" })
                }
                Scalar::Number(value) => output.extend_from_slice(
                    if value.is_finite() {
                        number_text(*value)
                    } else {
                        "null".to_owned()
                    }
                    .as_bytes(),
                ),
                Scalar::String(value) | Scalar::Timestamp(value) => {
                    serde_json::to_writer(&mut output, value).map_err(|_| ())?
                }
                Scalar::Binary(value) => {
                    output.extend_from_slice(b"{\"type\":\"Buffer\",\"data\":");
                    serde_json::to_writer(&mut output, value).map_err(|_| ())?;
                    output.push(b'}');
                }
            },
            Kind::Sequence(items) | Kind::Mapping(items) => {
                if active[id] {
                    return Err(());
                }
                active[id] = true;
                let node = &doc.nodes[id];
                if matches!(node.tag.as_deref(), Some("tag:yaml.org,2002:set"))
                    && matches!(node.kind, Kind::Mapping(_))
                    || matches!(node.tag.as_deref(), Some("tag:yaml.org,2002:omap"))
                        && matches!(node.kind, Kind::Sequence(_))
                {
                    output.extend_from_slice(b"{}");
                    active[id] = false;
                } else if matches!(node.kind, Kind::Mapping(_)) {
                    output.push(b'{');
                    pending.push(Step::End(id, '}'));
                    let entries: Vec<_> = object_entries(doc, items)?
                        .into_iter()
                        .filter(|(_, value)| {
                            doc.resolve(*value).is_ok_and(|id| {
                                !matches!(doc.nodes[id].kind, Kind::Scalar(Scalar::Merge))
                            })
                        })
                        .collect();
                    for (index, (key, value)) in entries.into_iter().enumerate().rev() {
                        pending.push(Step::Node(value));
                        pending.push(Step::Text(format!(
                            "{}:",
                            serde_json::to_string(&key).map_err(|_| ())?
                        )));
                        if index > 0 {
                            pending.push(Step::Text(",".to_owned()));
                        }
                    }
                } else {
                    output.push(b'[');
                    pending.push(Step::End(id, ']'));
                    for (index, value) in items.iter().enumerate().rev() {
                        if node.tag.as_deref() == Some("tag:yaml.org,2002:pairs") {
                            let pair = match &doc.nodes[*value].kind {
                                Kind::Mapping(items) => {
                                    items.first().zip(items.get(1)).map(|(k, v)| (*k, Some(*v)))
                                }
                                _ => Some((*value, None)),
                            };
                            pending.push(Step::Text("}".to_owned()));
                            if let Some((key, value)) = pair {
                                if let Some(value) = value {
                                    pending.push(Step::Node(value));
                                } else {
                                    pending.push(Step::Text("null".to_owned()));
                                }
                                pending.push(Step::Text(format!(
                                    "{}:",
                                    serde_json::to_string(&object_key(doc, key)?)
                                        .map_err(|_| ())?
                                )));
                            } else {
                                pending.push(Step::Text("\"\":null".to_owned()));
                            }
                            pending.push(Step::Text("{".to_owned()));
                        } else {
                            pending.push(Step::Node(*value));
                        }
                        if index > 0 {
                            pending.push(Step::Text(",".to_owned()));
                        }
                    }
                }
            }
            Kind::Alias(_, _) => unreachable!(),
        }
    }
    String::from_utf8(output).map_err(|_| ())
}
