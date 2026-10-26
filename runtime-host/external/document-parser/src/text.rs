use crate::{
    Anchor, Asset, BlockKind, Cell, CellValue, CoverageReason, CoverageStatus, Document,
    FailureKind, ParseFailure, ParseRequest, SourceMapEntry, Table, Target, digest,
};

pub(crate) fn plain(request: &ParseRequest<'_>, org: bool) -> Result<Document, ParseFailure> {
    let text = std::str::from_utf8(request.bytes)
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    let mut output = Document {
        markdown: if org {
            org_to_markdown(text)
        } else {
            text.to_owned()
        },
        ..Document::default()
    };
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        request.check_cancelled()?;
        let end = offset + line.len();
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if !trimmed.is_empty() {
            let depth = trimmed
                .bytes()
                .take_while(|byte| *byte == if org { b'*' } else { b'#' })
                .count();
            let kind = if depth > 0 && trimmed.as_bytes().get(depth) == Some(&b' ') {
                BlockKind::Heading {
                    level: depth.min(255) as u8,
                }
            } else {
                BlockKind::Paragraph
            };
            output.push_block(
                None,
                kind,
                trimmed.into(),
                Some(Anchor::Text {
                    start: offset as u64,
                    end: (offset + trimmed.len()) as u64,
                }),
            );
        }
        offset = end;
    }
    output.coverage(
        Some(Anchor::Text {
            start: 0,
            end: request.bytes.len() as u64,
        }),
        CoverageStatus::Processed,
        CoverageReason::Parsed,
    );
    Ok(output)
}

pub(crate) fn html(request: &ParseRequest<'_>) -> Result<Document, ParseFailure> {
    let configuration = html2text::config::plain();
    let dom = configuration
        .parse_html(request.bytes)
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    let markdown = html2text::from_read(request.bytes, 120)
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    let mut output = Document {
        markdown,
        ..Document::default()
    };
    let mut pending = vec![(dom.document.clone(), String::new(), 0_usize)];
    let mut nodes = 0;
    while let Some((node, path, depth)) = pending.pop() {
        request.check_cancelled()?;
        nodes += 1;
        if nodes > 1_000_000 {
            return Err(ParseFailure::limit("html_nodes"));
        }
        if depth > 128 {
            return Err(ParseFailure::limit("html_depth"));
        }
        let name = node.element_name().unwrap_or_else(|| "document".into());
        if matches!(
            name.as_str(),
            "script" | "style" | "template" | "noscript" | "head"
        ) {
            continue;
        }
        let children = node.children.borrow();
        if children.is_empty() {
            let mut bytes = Vec::new();
            node.serialize(&mut bytes)
                .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
            let text = std::str::from_utf8(&bytes)
                .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
            if !text.starts_with('<') {
                // html5ever serializes non-breaking spaces as the HTML-only &nbsp; entity.
                let escaped = text.replace("&nbsp;", "&#160;");
                let decoded = quick_xml::escape::unescape(&escaped)
                    .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?
                    .into_owned();
                if !decoded.trim().is_empty() {
                    output.push_block(
                        None,
                        BlockKind::Paragraph,
                        decoded.clone(),
                        Some(Anchor::Html {
                            node_path: Some(path),
                            text_start: 0,
                            text_end: decoded.len() as u64,
                        }),
                    );
                }
            }
        } else {
            for (index, child) in children.iter().enumerate().rev() {
                pending.push((child.clone(), format!("{path}/{}", index + 1), depth + 1));
            }
        }
    }
    if !dom.errors.borrow().is_empty() {
        output.coverage(
            None,
            CoverageStatus::Fallback,
            CoverageReason::ParserRecovery {
                parser: "html5ever".into(),
                failure: None,
            },
        );
    }
    output.coverage(None, CoverageStatus::Processed, CoverageReason::Parsed);
    Ok(output)
}

pub(crate) fn delimited(request: &ParseRequest<'_>, tsv: bool) -> Result<Document, ParseFailure> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(if tsv { b'\t' } else { b',' })
        .from_reader(request.bytes);
    let mut output = Document {
        markdown: std::str::from_utf8(request.bytes)
            .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?
            .into(),
        ..Document::default()
    };
    let mut cells = Vec::new();
    let mut record = csv::StringRecord::new();
    let mut row = 0_u32;
    while reader
        .read_record(&mut record)
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?
    {
        request.check_cancelled()?;
        row += 1;
        if cells.len().saturating_add(record.len()) > 1_000_000 {
            return Err(ParseFailure::limit("table_cells"));
        }
        let start = record
            .position()
            .map(|position| position.byte())
            .unwrap_or(0);
        let end = reader.position().byte();
        for (column, value) in record.iter().enumerate() {
            // Delimited text has no declared scalar types: empty string is not null and numeric-looking keys remain strings.
            cells.push(Cell {
                row,
                column: column as u32 + 1,
                row_span: 1,
                column_span: 1,
                raw: None,
                value: CellValue::Text(value.into()),
                formula: None,
            });
            output.source_map.push(SourceMapEntry {
                target: Target::Cell {
                    table_id: 0,
                    row,
                    column: column as u32 + 1,
                },
                anchor: Anchor::Text { start, end },
            });
        }
    }
    output.tables.push(Table {
        id: 0,
        name: None,
        header_rows: 0,
        cells,
    });
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::RawValueUnavailable,
    );
    output.push_block(None, BlockKind::Table { table_id: 0 }, String::new(), None);
    output.coverage(None, CoverageStatus::Processed, CoverageReason::Parsed);
    Ok(output)
}

pub(crate) fn json(request: &ParseRequest<'_>) -> Result<Document, ParseFailure> {
    use serde_json::value::RawValue;
    type Raw<'a> = &'a RawValue;
    type Object<'a> = std::collections::BTreeMap<String, Raw<'a>>;
    let root: Raw<'_> = serde_json::from_slice(request.bytes)
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    let rows: Vec<Raw<'_>> = if root.get().starts_with('[') {
        serde_json::from_str(root.get())
            .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?
    } else {
        vec![root]
    };
    let mut columns = Vec::new();
    let objects = rows
        .iter()
        .map(|row| {
            if row.get().starts_with('{') {
                let object: Object<'_> = serde_json::from_str(row.get())
                    .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
                for key in object.keys() {
                    if !columns.contains(key) {
                        columns.push(key.clone());
                    }
                }
                Ok(Some(object))
            } else {
                Ok(None)
            }
        })
        .collect::<Result<Vec<_>, ParseFailure>>()?;
    if columns.is_empty() {
        columns.push("value".into());
    }
    let mut output = plain(request, false)?;
    let mut cells = Vec::new();
    for (row_index, (row, object)) in rows.iter().zip(&objects).enumerate() {
        request.check_cancelled()?;
        if cells.len().saturating_add(columns.len()) > 1_000_000 {
            return Err(ParseFailure::limit("table_cells"));
        }
        for (column_index, column) in columns.iter().enumerate() {
            let source = match object {
                Some(object) => object.get(column).copied(),
                None => Some(*row),
            };
            let value = match source {
                None => CellValue::Missing,
                Some(raw) => match raw.get().as_bytes().first() {
                    Some(b'n') => CellValue::Null,
                    Some(b't') => CellValue::Boolean(true),
                    Some(b'f') => CellValue::Boolean(false),
                    Some(b'"') => CellValue::Text(
                        serde_json::from_str(raw.get())
                            .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?,
                    ),
                    Some(b'-' | b'0'..=b'9') => crate::spreadsheet::numeric(raw.get()),
                    _ => CellValue::Text(raw.get().to_owned()),
                },
            };
            let row = row_index as u32 + 1;
            let column = column_index as u32 + 1;
            cells.push(Cell {
                row,
                column,
                row_span: 1,
                column_span: 1,
                raw: source.map(|raw| raw.get().to_owned()),
                value,
                formula: None,
            });
            if let Some(source) = source {
                // RawValue borrows the exact validated input token, including numeric exponent and string escapes.
                let start = source.get().as_ptr() as usize - request.bytes.as_ptr() as usize;
                output.source_map.push(SourceMapEntry {
                    target: Target::Cell {
                        table_id: 0,
                        row,
                        column,
                    },
                    anchor: Anchor::Text {
                        start: start as u64,
                        end: (start + source.get().len()) as u64,
                    },
                });
            }
        }
    }
    output.tables.push(Table {
        id: 0,
        name: None,
        header_rows: 0,
        cells,
    });
    for (index, name) in columns.into_iter().enumerate() {
        output
            .metadata
            .insert(format!("column.{}", index + 1), name);
    }
    Ok(output)
}

pub(crate) fn image(request: &ParseRequest<'_>, extension: &str) -> Result<Document, ParseFailure> {
    let decoded = image::load_from_memory(request.bytes);
    let dimensions = decoded
        .as_ref()
        .ok()
        .map(|image| (image.width(), image.height()));
    let media_type = match extension {
        "jpg" | "jpeg" => "image/jpeg".into(),
        "svg" => "image/svg+xml".into(),
        "tif" => "image/tiff".into(),
        _ => format!("image/{extension}"),
    };
    let mut output = Document::default();
    if request.options.extract_assets {
        output.assets.push(Asset {
            id: 0,
            media_type,
            bytes: request.bytes.to_vec(),
            sha256: digest(request.bytes),
            width: dimensions.map(|value| value.0),
            height: dimensions.map(|value| value.1),
            derived_from: None,
        });
        output.source_map.push(SourceMapEntry {
            target: Target::Asset { asset_id: 0 },
            anchor: Anchor::Text {
                start: 0,
                end: request.bytes.len() as u64,
            },
        });
    } else {
        output.coverage(
            None,
            CoverageStatus::Missing,
            CoverageReason::AssetExtractionDisabled,
        );
    }
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::OcrUnavailable,
    );
    if let Err(error) = decoded {
        let kind = if matches!(&error, image::ImageError::Unsupported(_)) {
            FailureKind::ParserUnavailable
        } else {
            FailureKind::Corrupt
        };
        output.diagnostics.push(ParseFailure::caused(kind, error));
        output.coverage(
            None,
            CoverageStatus::Missing,
            CoverageReason::AssetDecodeFailed,
        );
    }
    Ok(output)
}

pub(crate) fn media(request: &ParseRequest<'_>, extension: &str) -> Result<Document, ParseFailure> {
    let video = matches!(
        extension,
        "mp4" | "webm" | "mov" | "avi" | "mkv" | "flv" | "wmv" | "m4v"
    );
    let mut output = Document::default();
    if request.options.extract_assets {
        output.assets.push(Asset {
            id: 0,
            media_type: format!("{}/{extension}", if video { "video" } else { "audio" }),
            bytes: request.bytes.to_vec(),
            sha256: digest(request.bytes),
            width: None,
            height: None,
            derived_from: None,
        });
        output.source_map.push(SourceMapEntry {
            target: Target::Asset { asset_id: 0 },
            anchor: Anchor::Media {
                start_ms: None,
                end_ms: None,
            },
        });
    } else {
        output.coverage(
            None,
            CoverageStatus::Missing,
            CoverageReason::AssetExtractionDisabled,
        );
    }
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::TranscriptionUnavailable,
    );
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::TimingUnavailable,
    );
    Ok(output)
}

fn org_to_markdown(content: &str) -> String {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut output = Vec::new();
    let mut block_end: Option<&'static str> = None;

    for line in normalized.lines() {
        let trimmed = line.trim();
        let upper = trimmed.to_ascii_uppercase();
        if let Some(end) = block_end {
            if upper == end {
                output.push("```".to_string());
                block_end = None;
            } else {
                output.push(line.to_string());
            }
            continue;
        }

        if upper.starts_with("#+BEGIN_SRC") {
            let language = trimmed[11..].split_whitespace().next().unwrap_or("");
            output.push(format!("```{language}"));
            block_end = Some("#+END_SRC");
            continue;
        }
        if upper == "#+BEGIN_EXAMPLE" {
            output.push("```text".to_string());
            block_end = Some("#+END_EXAMPLE");
            continue;
        }
        if upper == "#+BEGIN_QUOTE" {
            output.push("```text".to_string());
            block_end = Some("#+END_QUOTE");
            continue;
        }

        if let Some((key, value)) = parse_org_keyword(trimmed) {
            if key == "TITLE" {
                output.push(format!("# {value}"));
            } else if !matches!(key.as_str(), "OPTIONS" | "PROPERTY" | "SETUPFILE") {
                output.push(format!("**{}:** {}", title_case_ascii(&key), value));
            }
            continue;
        }

        if let Some((level, heading)) = parse_org_heading(line) {
            output.push(format!(
                "{} {}",
                "#".repeat(level.min(6)),
                convert_org_links(heading)
            ));
            continue;
        }

        if trimmed.starts_with('|')
            && trimmed.ends_with('|')
            && trimmed.contains('+')
            && trimmed
                .chars()
                .all(|character| matches!(character, '|' | '+' | '-' | ':' | ' '))
        {
            output.push(trimmed.replace('+', "|"));
            continue;
        }

        output.push(convert_org_links(line));
    }
    if block_end.is_some() {
        output.push("```".to_string());
    }
    output.join("\n")
}

fn parse_org_keyword(line: &str) -> Option<(String, &str)> {
    let rest = line.strip_prefix("#+")?;
    let (key, value) = rest.split_once(':')?;
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return None;
    }
    Some((key.to_ascii_uppercase(), value.trim()))
}

fn parse_org_heading(line: &str) -> Option<(usize, &str)> {
    let stars = line
        .chars()
        .take_while(|character| *character == '*')
        .count();
    if stars == 0 || line.as_bytes().get(stars) != Some(&b' ') {
        return None;
    }
    Some((stars, line[stars + 1..].trim()))
}

fn title_case_ascii(value: &str) -> String {
    let lower = value.replace('_', " ").to_ascii_lowercase();
    let mut chars = lower.chars();
    chars
        .next()
        .map(|character| character.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

fn convert_org_links(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        if let Some((target, description)) = inner.split_once("][") {
            out.push_str(&format!("[{}]({})", description, target));
        } else {
            out.push_str(&format!("<{}>", inner));
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}
