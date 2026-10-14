use base64::{Engine, engine::general_purpose::STANDARD};
use saphyr_parser::ScalarStyle::{self, *};

use super::{
    Scalar, core_scalar, number_text,
    yaml::{Document, Kind, Node},
};

#[derive(Default)]
pub(super) struct Notes {
    before: Vec<String>,
    after: String,
    blank: bool,
}

// Comments are presentation data in gaps between native event ranges, never grammar.
pub(super) fn notes(doc: &Document) -> Vec<Notes> {
    let mut notes: Vec<_> = doc
        .nodes
        .iter()
        .map(|node| Notes {
            before: node.property_comments.clone(),
            after: node.header_comment.clone(),
            ..Notes::default()
        })
        .collect();
    for node in &doc.nodes {
        let items = match &node.kind {
            Kind::Sequence(items) | Kind::Mapping(items) => items,
            _ => continue,
        };
        let mut previous = None;
        let mut end = node.body;
        for &id in items {
            gap(
                doc,
                &mut notes,
                end,
                doc.nodes[id].start,
                previous,
                Some(id),
                false,
            );
            previous = Some(id);
            end = doc.nodes[id].end;
        }
        let closing = if node.flow {
            node.end.saturating_sub(1)
        } else {
            node.end
        };
        gap(doc, &mut notes, end, closing, previous, None, true);
    }
    notes
}

fn gap(
    doc: &Document,
    notes: &mut [Notes],
    start: usize,
    end: usize,
    previous: Option<usize>,
    next: Option<usize>,
    closing: bool,
) {
    let Some(text) = doc.block.get(start..end) else {
        return;
    };
    if let Some(next) = next {
        notes[next].blank = text.contains("\n\n");
    }
    for (index, line) in text.split('\n').enumerate() {
        if let Some(hash) = line.find('#') {
            let comment = line[hash..].to_owned();
            if index == 0
                && previous.is_some()
                && !line[..hash].contains(':')
                && !(closing && line[..hash].contains(','))
            {
                let note = &mut notes[previous.unwrap()].after;
                if !note.is_empty() {
                    note.push('\n');
                }
                note.push_str(&comment);
            } else if let Some(next) = next {
                notes[next].before.push(comment);
            }
        }
    }
}

// Flat ropes retain children by index: deep keys neither recurse nor copy whole subtrees.
struct Rope {
    parts: Vec<Part>,
    width: usize,
    multiline: bool,
}
enum Part {
    Text(String),
    Rope(usize),
    Indent(usize),
}

fn rope(arena: &mut Vec<Rope>, parts: Vec<Part>) -> usize {
    let mut width = 0usize;
    let mut multiline = false;
    for part in &parts {
        match part {
            Part::Text(text) => {
                width = width.saturating_add(text.encode_utf16().count());
                multiline |= text.contains('\n');
            }
            Part::Rope(id) => {
                width = width.saturating_add(arena[*id].width);
                multiline |= arena[*id].multiline;
            }
            Part::Indent(size) => width = width.saturating_add(*size),
        }
    }
    let id = arena.len();
    arena.push(Rope {
        parts,
        width,
        multiline,
    });
    id
}

pub(super) fn uncommented(doc: &Document, id: usize) -> bool {
    doc.notes[id].before.is_empty() && doc.notes[id].after.is_empty()
}

fn prefix(parts: &mut Vec<Part>, note: &Notes, indent: usize) {
    if note.blank {
        parts.push(Part::Text(String::new()));
    }
    for comment in &note.before {
        parts.push(Part::Text(comment.clone()));
        parts.push(Part::Text("\n".to_owned()));
        parts.push(Part::Indent(indent));
    }
}

pub(super) fn key(doc: &Document, root: usize) -> Result<String, ()> {
    if let Kind::Scalar(value) = &doc.nodes[root].kind {
        return match value {
            Scalar::Binary(value) => Ok(String::from_utf8_lossy(value).into_owned()),
            Scalar::Timestamp(value) => {
                let value = chrono::DateTime::parse_from_rfc3339(value).map_err(|_| ())?;
                Ok(value
                    .format("%a %b %d %Y %H:%M:%S GMT%z (Coordinated Universal Time)")
                    .to_string())
            }
            _ => Err(()),
        };
    }
    enum Step {
        Node(usize, usize, bool, bool),
        Collection(usize, usize, bool),
        Pair(usize, usize, usize, bool),
    }
    let notes = &doc.notes;
    let mut arena = Vec::new();
    let mut results = Vec::new();
    let mut pending = vec![Step::Node(root, 0, false, false)];
    while let Some(step) = pending.pop() {
        match step {
            Step::Node(id, indent, implicit, props) => {
                let node = &doc.nodes[id];
                match &node.kind {
                    Kind::Scalar(_) | Kind::Alias(_, _) => {
                        let text = scalar(node, indent, implicit, props)?;
                        results.push(rope(&mut arena, vec![Part::Text(text)]));
                    }
                    Kind::Sequence(items) => {
                        pending.push(Step::Collection(id, indent, props));
                        for &child in items.iter().rev() {
                            pending.push(Step::Node(child, indent + 4, false, true));
                        }
                    }
                    Kind::Mapping(items) => {
                        pending.push(Step::Collection(id, indent, props));
                        let all_null = node.tag.as_deref() == Some("tag:yaml.org,2002:set")
                            || items
                                .chunks_exact(2)
                                .all(|pair| absent(doc, pair[0], pair[1]));
                        for pair in items.chunks_exact(2).rev() {
                            pending.push(Step::Pair(pair[0], pair[1], indent + 2, all_null));
                            pending.push(Step::Node(pair[1], indent + 4, false, true));
                            let explicit =
                                matches!(
                                    doc.nodes[pair[0]].kind,
                                    Kind::Sequence(_) | Kind::Mapping(_)
                                ) || matches!(doc.nodes[pair[0]].style, Literal | Folded);
                            pending.push(Step::Node(
                                pair[0],
                                indent + 4,
                                !explicit && !all_null,
                                true,
                            ));
                        }
                    }
                }
            }
            Step::Pair(key, value, indent, all_null) => {
                let value_rope = results.pop().ok_or(())?;
                let key_rope = results.pop().ok_or(())?;
                let explicit = matches!(doc.nodes[key].kind, Kind::Sequence(_) | Kind::Mapping(_))
                    || matches!(doc.nodes[key].style, Literal | Folded);
                let mut parts = Vec::new();
                if explicit {
                    parts.push(Part::Text("? ".to_owned()));
                }
                parts.push(Part::Rope(key_rope));
                if !(all_null || absent(doc, key, value)) {
                    if explicit {
                        parts.push(Part::Text("\n".to_owned()));
                        parts.push(Part::Indent(indent));
                    }
                    parts.push(Part::Text(":".to_owned()));
                    if !notes[key].after.is_empty() {
                        parts.push(Part::Text(format!(" {}", notes[key].after)));
                    }
                    if notes[value].blank
                        || !notes[value].before.is_empty()
                        || !notes[key].after.is_empty()
                    {
                        parts.push(Part::Text(
                            if notes[value].blank { "\n\n" } else { "\n" }.to_owned(),
                        ));
                        parts.push(Part::Indent(indent + 2));
                        prefix(&mut parts, &notes[value], indent + 2);
                    } else if !explicit
                        && matches!(doc.nodes[value].kind, Kind::Sequence(_) | Kind::Mapping(_))
                        && arena[value_rope].multiline
                    {
                        parts.push(Part::Text("\n".to_owned()));
                        parts.push(Part::Indent(indent + 2));
                    } else if arena[value_rope].width != 0 {
                        parts.push(Part::Text(" ".to_owned()));
                    }
                    parts.push(Part::Rope(value_rope));
                }
                results.push(rope(&mut arena, parts));
            }
            Step::Collection(id, indent, props) => {
                let node = &doc.nodes[id];
                let (items, map) = match &node.kind {
                    Kind::Sequence(items) => (items, false),
                    Kind::Mapping(items) => (items, true),
                    _ => unreachable!(),
                };
                let count = if map { items.len() / 2 } else { items.len() };
                let values = results.split_off(results.len() - count);
                let mut lines = Vec::new();
                let mut multiline = false;
                for (index, value) in values.into_iter().enumerate() {
                    let first = items[if map { index * 2 } else { index }];
                    let last = items[if map { index * 2 + 1 } else { index }];
                    if notes[first].blank {
                        lines.push(rope(&mut arena, Vec::new()));
                        multiline = true;
                    }
                    for comment in &notes[first].before {
                        lines.push(rope(&mut arena, vec![Part::Text(comment.clone())]));
                        multiline = true;
                    }
                    let mut parts = vec![Part::Rope(value)];
                    if index + 1 < count {
                        parts.push(Part::Text(",".to_owned()));
                    }
                    let comment = if map && absent(doc, first, last) {
                        &notes[first].after
                    } else {
                        &notes[last].after
                    };
                    if !comment.is_empty() {
                        parts.push(Part::Text(format!(" {comment}")));
                        multiline = true;
                    }
                    multiline |= arena[value].multiline;
                    if map && (!notes[first].after.is_empty() || !notes[last].before.is_empty()) {
                        multiline = true;
                    }
                    lines.push(rope(&mut arena, parts));
                }
                let (open, close) = if map { ("{", "}") } else { ("[", "]") };
                let width = lines
                    .iter()
                    .fold(2usize, |sum, id| sum.saturating_add(arena[*id].width + 2));
                multiline |= width > 80;
                let mut parts = Vec::new();
                if props {
                    let props = properties(node);
                    if !props.is_empty() {
                        parts.push(Part::Text(format!("{props} ")));
                    }
                }
                parts.push(Part::Text(open.to_owned()));
                if !lines.is_empty() {
                    for line in &lines {
                        if multiline {
                            parts.push(Part::Text("\n".to_owned()));
                            if arena[*line].width > 0 {
                                parts.push(Part::Indent(indent + 2));
                            }
                        } else {
                            parts.push(Part::Text(" ".to_owned()));
                        }
                        parts.push(Part::Rope(*line));
                    }
                    if multiline {
                        parts.push(Part::Text("\n".to_owned()));
                        parts.push(Part::Indent(indent));
                    } else {
                        parts.push(Part::Text(" ".to_owned()));
                    }
                }
                parts.push(Part::Text(close.to_owned()));
                results.push(rope(&mut arena, parts));
            }
        }
    }
    let root = results.pop().ok_or(())?;
    let mut output = String::new();
    let mut pending = vec![Part::Rope(root)];
    while let Some(part) = pending.pop() {
        match part {
            Part::Text(text) => output.push_str(&text),
            Part::Indent(size) => output.extend(std::iter::repeat_n(' ', size)),
            Part::Rope(id) => {
                let parts = std::mem::take(&mut arena[id].parts);
                pending.extend(parts.into_iter().rev());
            }
        }
    }
    Ok(output)
}

fn absent(doc: &Document, key: usize, value: usize) -> bool {
    doc.nodes[value].missing
        && !doc
            .block
            .get(doc.nodes[key].end..doc.nodes[value].start)
            .unwrap_or("")
            .contains(':')
}

fn properties(node: &Node) -> String {
    let mut props = Vec::new();
    if let Some(anchor) = &node.anchor {
        props.push(format!("&{anchor}"));
    }
    if let Some(tag) = &node.tag {
        if let Some(name) = tag.strip_prefix("tag:yaml.org,2002:") {
            props.push(format!("!!{name}"));
        } else if tag.starts_with('!') {
            props.push(tag.clone());
        } else {
            props.push(format!("!<{tag}>"));
        }
    }
    props.join(" ")
}

fn scalar(node: &Node, indent: usize, implicit: bool, props: bool) -> Result<String, ()> {
    if let Kind::Alias(_, name) = &node.kind {
        return Ok(format!("*{name}"));
    }
    let Kind::Scalar(value) = &node.kind else {
        return Err(());
    };
    let text = match value {
        Scalar::String(value) => string(value, node.style, indent, implicit, true),
        Scalar::Binary(value) => {
            string(&STANDARD.encode(value), node.style, indent, implicit, false)
        }
        Scalar::Timestamp(value) => value
            .strip_suffix("T00:00:00.000Z")
            .or_else(|| value.strip_suffix(".000Z"))
            .unwrap_or(value)
            .to_owned(),
        Scalar::Merge => "<<".to_owned(),
        Scalar::Null | Scalar::Bool(_) => node.value_source.clone(),
        Scalar::Number(value) => numeric(*value, &node.value_source),
    };
    let props = if props {
        properties(node)
    } else {
        String::new()
    };
    Ok(if props.is_empty() {
        text
    } else {
        format!("{props} {text}")
    })
}

fn numeric(value: f64, source: &str) -> String {
    if !value.is_finite() {
        return if value.is_nan() {
            ".nan"
        } else if value < 0.0 {
            "-.inf"
        } else {
            ".inf"
        }
        .to_owned();
    }
    if source.starts_with("0x") || source.starts_with("0o") {
        return source.to_ascii_lowercase();
    }
    let mut text = if value == 0.0 && value.is_sign_negative() {
        "-0".to_owned()
    } else {
        number_text(value)
    };
    if source.contains(['e', 'E']) && !text.contains('e') {
        let sign = if text.starts_with('-') { "-" } else { "" };
        let unsigned = text.trim_start_matches('-');
        let point = unsigned.find('.').unwrap_or(unsigned.len()) as isize;
        let digits: String = unsigned.chars().filter(|ch| *ch != '.').collect();
        let first = digits.find(|ch| ch != '0');
        if let Some(first) = first {
            let digits = digits[first..].trim_end_matches('0');
            let exponent = point - first as isize - 1;
            text = format!(
                "{sign}{}{}e{}{exponent}",
                &digits[..1],
                if digits.len() > 1 {
                    format!(".{}", &digits[1..])
                } else {
                    String::new()
                },
                if exponent >= 0 { "+" } else { "" }
            );
        } else {
            text = "0e+0".to_owned();
        }
    } else if !source.contains(['e', 'E'])
        && source.ends_with('0')
        && source.contains('.')
        && !text.contains('e')
    {
        let fraction = source.len() - source.find('.').unwrap() - 1;
        if !text.contains('.') {
            text.push('.');
        }
        let have = text.len() - text.find('.').unwrap() - 1;
        text.extend(std::iter::repeat_n('0', fraction.saturating_sub(have)));
    }
    text
}

fn string(value: &str, style: ScalarStyle, indent: usize, implicit: bool, actual: bool) -> String {
    let controls = value.chars().any(
        |ch| matches!(ch, '\0'..='\u{0008}' | '\u{000b}'..='\u{001f}' | '\u{007f}'..='\u{009f}'),
    );
    let plain = !value.is_empty()
        && !value.starts_with([
            '\n', '\t', ' ', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%',
            '@', '`',
        ])
        && !matches!(value, "-" | "?")
        && !["- ", "-\t", "? ", "?\t"]
            .iter()
            .any(|prefix| value.starts_with(prefix))
        && !value.contains(['[', ']', '{', '}', ','])
        && !value.contains(": ")
        && !value.contains(":\t")
        && !value.contains("\n ")
        && !value.contains("\n\t")
        && !value.contains(" \n")
        && !value.contains("\t\n")
        && !value.contains(" #")
        && !value.contains("\t#")
        && !value.contains("\n#")
        && !value.ends_with(['\n', '\t', ' ', ':'])
        && !(implicit && value.contains('\n'))
        && !(actual && !matches!(core_scalar(value, true, None), Scalar::String(_)));
    let single = !controls
        && (style == SingleQuoted
            || style != DoubleQuoted && value.contains('"') && !value.contains('\''))
        && !(implicit && value.contains('\n'))
        && !value.contains(" \n")
        && !value.contains("\t\n")
        && !value.contains("\n ")
        && !value.contains("\n\t");
    let text = if !controls && style == Plain && plain {
        value.replace('\n', &format!("\n\n{}", " ".repeat(indent)))
    } else if single {
        format!(
            "'{}'",
            value
                .replace('\'', "''")
                .replace('\n', &format!("\n\n{}", " ".repeat(indent)))
        )
    } else {
        quoted(value, indent, implicit)
    };
    if implicit {
        text
    } else {
        fold(
            &text,
            indent,
            !single && (controls || style != Plain || !plain),
        )
    }
}

fn quoted(value: &str, indent: usize, implicit: bool) -> String {
    let json = serde_json::to_string(value).unwrap();
    let chars: Vec<_> = json.chars().collect();
    let mut text = String::with_capacity(json.len());
    let (mut start, mut index) = (0, 0);
    while index < chars.len() {
        if chars[index] == ' ' && chars.get(index + 1..index + 3) == Some(&['\\', 'n']) {
            text.extend(chars[start..index].iter());
            text.push_str("\\ ");
            index += 1;
            start = index;
        }
        if chars[index] == '\\' {
            match chars.get(index + 1) {
                Some('u') => {
                    text.extend(chars[start..index].iter());
                    let code: String = chars[index + 2..index + 6].iter().collect();
                    match code.as_str() {
                        "0000" => text.push_str("\\0"),
                        "0007" => text.push_str("\\a"),
                        "000b" => text.push_str("\\v"),
                        "001b" => text.push_str("\\e"),
                        "0085" => text.push_str("\\N"),
                        "00a0" => text.push_str("\\_"),
                        "2028" => text.push_str("\\L"),
                        "2029" => text.push_str("\\P"),
                        _ if code.starts_with("00") => {
                            text.push_str("\\x");
                            text.push_str(&code[2..]);
                        }
                        _ => {
                            text.push_str("\\u");
                            text.push_str(&code);
                        }
                    }
                    index += 5;
                    start = index + 1;
                }
                Some('n')
                    if !implicit
                        && chars.get(index + 2) != Some(&'"')
                        && json.encode_utf16().count() >= 40 =>
                {
                    text.extend(chars[start..index].iter());
                    text.push_str("\n\n");
                    while chars.get(index + 2..index + 4) == Some(&['\\', 'n'])
                        && chars.get(index + 4) != Some(&'"')
                    {
                        text.push('\n');
                        index += 2;
                    }
                    text.extend(std::iter::repeat_n(' ', indent));
                    if chars.get(index + 2) == Some(&' ') {
                        text.push('\\');
                    }
                    index += 1;
                    start = index + 1;
                }
                _ => index += 1,
            }
        }
        index += 1;
    }
    text.extend(chars[start..].iter());
    text
}

fn fold(text: &str, indent: usize, quoted: bool) -> String {
    let text: Vec<u16> = text.encode_utf16().collect();
    let step = 81isize.saturating_sub(indent as isize).max(21);
    if text.len() as isize <= step {
        return String::from_utf16_lossy(&text);
    }
    let mut end = 80isize - indent as isize;
    let mut folds = Vec::<(usize, bool)>::new();
    let mut split = None;
    let mut previous = None;
    let (mut index, mut escape_start, mut escape_end) = (-1isize, -1isize, -1isize);
    while {
        index += 1;
        index < text.len() as isize
    } {
        let mut ch = text[index as usize];
        if quoted && ch == b'\\' as u16 {
            escape_start = index;
            index += match text.get(index as usize + 1).copied() {
                Some(120) => 3,
                Some(117) => 5,
                Some(85) => 9,
                _ => 1,
            };
            escape_end = index;
        }
        if ch == b'\n' as u16 {
            end = index + indent as isize + step;
            split = None;
        } else {
            if ch == b' ' as u16
                && previous.is_some_and(|ch| !matches!(ch, 32 | 10 | 9))
                && text
                    .get(index as usize + 1)
                    .is_some_and(|ch| !matches!(*ch, 32 | 10 | 9))
            {
                split = Some(index);
            }
            if index >= end {
                if let Some(at) = split.take() {
                    folds.push((at as usize, false));
                    end = at + step;
                } else if quoted {
                    while previous.is_some_and(|ch| matches!(ch, 32 | 9))
                        && index < text.len() as isize
                    {
                        previous = Some(ch);
                        index += 1;
                        ch = text.get(index as usize).copied().unwrap_or(0);
                    }
                    let at = if index > escape_end + 1 {
                        index - 2
                    } else {
                        escape_start - 1
                    };
                    if at < 0
                        || folds
                            .iter()
                            .any(|(fold, escaped)| *escaped && *fold == at as usize)
                    {
                        return String::from_utf16_lossy(&text);
                    }
                    folds.push((at as usize, true));
                    end = at + step;
                    split = None;
                }
            }
        }
        previous = Some(ch);
    }
    let mut output = Vec::new();
    let mut start = 0;
    for (at, escaped) in folds {
        output.extend_from_slice(&text[start..at]);
        if escaped {
            output.extend_from_slice(&[text[at], b'\\' as u16]);
        }
        output.push(b'\n' as u16);
        output.extend(std::iter::repeat_n(b' ' as u16, indent));
        start = at + 1;
    }
    output.extend_from_slice(&text[start..]);
    String::from_utf16_lossy(&output)
}
