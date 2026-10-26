use anydoc::model::{self, CellSlot};

use crate::{
    Anchor, Asset, BlockKind, Cell, CellValue, CoverageReason, CoverageStatus, Document,
    FailureKind, ParseFailure, ParseRequest, SourceMapEntry, Table, Target, archive, digest,
};

pub(crate) fn anydoc_error(error: anydoc::ConvertError) -> ParseFailure {
    let kind = match &error {
        anydoc::ConvertError::Unsupported(_) => FailureKind::Unsupported,
        anydoc::ConvertError::Encrypted => FailureKind::Encrypted,
        anydoc::ConvertError::ResourceLimit { .. } => FailureKind::ResourceLimit,
        anydoc::ConvertError::Io(_)
        | anydoc::ConvertError::Malformed { .. }
        | anydoc::ConvertError::MissingPart { .. } => FailureKind::Corrupt,
        _ => FailureKind::Internal,
    };
    let limit = match &error {
        anydoc::ConvertError::ResourceLimit { limit, .. } => Some(*limit),
        _ => None,
    };
    let mut failure = ParseFailure::caused(kind, error);
    failure.limit = limit;
    failure
}

pub(crate) fn parse(request: &ParseRequest<'_>, extension: &str) -> Result<Document, ParseFailure> {
    if request.bytes.starts_with(b"PK") {
        archive::open(request.bytes)?;
    }
    let format = anydoc::Format::from_extension(extension)
        .ok_or_else(|| ParseFailure::new(FailureKind::Unsupported))?;
    let parsed = anydoc::to_document(request.bytes, format);
    let mut output = Document::default();
    match parsed {
        Ok(document) => {
            append_blocks(&mut output, &document.blocks, None);
            for note in &document.notes {
                let parent = output.push_block(None, BlockKind::Note, note.id.clone(), None);
                append_blocks(&mut output, &note.blocks, Some(parent));
            }
            if !request.bytes.starts_with(b"PK") {
                for asset in document.assets {
                    request.check_cancelled()?;
                    let anchor = Anchor::PackagePart {
                        part: asset.origin_part,
                        element: None,
                    };
                    if !request.options.extract_assets {
                        output.coverage(
                            Some(anchor),
                            CoverageStatus::Missing,
                            CoverageReason::AssetExtractionDisabled,
                        );
                        continue;
                    }
                    if output.assets.len() >= request.options.images.max_images {
                        output.coverage(
                            Some(anchor),
                            CoverageStatus::Truncated,
                            CoverageReason::ImageLimit {
                                limit: request.options.images.max_images,
                            },
                        );
                        continue;
                    }
                    let dimensions = image::load_from_memory(&asset.bytes)
                        .ok()
                        .map(|image| (image.width(), image.height()));
                    let id = output.assets.len() as u32;
                    output.assets.push(Asset {
                        id,
                        media_type: asset.media_type,
                        sha256: digest(&asset.bytes),
                        bytes: asset.bytes,
                        width: dimensions.map(|value| value.0),
                        height: dimensions.map(|value| value.1),
                        derived_from: None,
                    });
                    output.source_map.push(SourceMapEntry {
                        target: Target::Asset { asset_id: id },
                        anchor,
                    });
                }
            }
        }
        Err(
            error @ (anydoc::ConvertError::ResourceLimit { .. } | anydoc::ConvertError::Encrypted),
        ) => return Err(anydoc_error(error)),
        Err(error) => {
            let failure = anydoc_error(error);
            output.coverage(
                None,
                CoverageStatus::Fallback,
                CoverageReason::ParserRecovery {
                    parser: "office-compat".into(),
                    failure: Some(failure.kind),
                },
            );
            output.diagnostics.push(failure);
            let markdown =
                crate::office_markdown::extract_office_text(request.bytes, extension, &mut output)?;
            if usable(&markdown) {
                output.push_block(None, BlockKind::Paragraph, markdown.clone(), None);
            }
            output.markdown = markdown;
        }
    }
    if output.markdown.is_empty() {
        output.markdown =
            crate::office_markdown::extract_office_text(request.bytes, extension, &mut output)?;
    }
    if request.bytes.starts_with(b"PK") {
        let assets = crate::assets::office(request)?;
        output.assets = assets.assets;
        output.source_map.extend(assets.source_map);
        output.coverage.entries.extend(assets.coverage.entries);
        output.diagnostics.extend(assets.diagnostics);
    }
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::LocationUnavailable,
    );
    // AnyDoc explicitly recovers/skips optional content without a typed recovery receipt.
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::UpstreamRecoveryNotReported,
    );
    if output
        .blocks
        .iter()
        .all(|block| block.text.trim().is_empty())
        && output.tables.is_empty()
    {
        output.coverage(
            None,
            CoverageStatus::Missing,
            CoverageReason::TextUnavailable,
        );
        if !usable(&output.markdown) {
            output.markdown.clear();
        }
    }
    output
        .metadata
        .insert("format_parser".into(), "anydoc/0.1.9".into());
    Ok(output)
}

fn usable(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty()
        && !text.starts_with("[Could not extract")
        && !text.starts_with("[Document: no extractable")
}

fn append_blocks(output: &mut Document, blocks: &[model::Block], parent: Option<u32>) {
    for block in blocks {
        match block {
            model::Block::Heading { level, content, .. } => {
                output.push_block(
                    parent,
                    BlockKind::Heading { level: *level },
                    model::inlines_to_plain_text(content),
                    None,
                );
            }
            model::Block::Paragraph(content) => {
                output.push_block(
                    parent,
                    BlockKind::Paragraph,
                    model::inlines_to_plain_text(content),
                    None,
                );
            }
            model::Block::List(list) => {
                for item in &list.items {
                    let id = output.push_block(parent, BlockKind::ListItem, String::new(), None);
                    append_blocks(output, &item.blocks, Some(id));
                }
            }
            model::Block::BlockQuote(blocks) => {
                let id = output.push_block(parent, BlockKind::Quote, String::new(), None);
                append_blocks(output, blocks, Some(id));
            }
            model::Block::CodeBlock { lang, text } => {
                output.push_block(
                    parent,
                    BlockKind::Code {
                        language: lang.clone(),
                    },
                    text.clone(),
                    None,
                );
            }
            model::Block::Rule => {
                output.push_block(parent, BlockKind::Rule, String::new(), None);
            }
            model::Block::Table(table) => {
                let table_id = output.tables.len() as u32;
                let mut cells = Vec::new();
                for (row, slots) in table.grid.iter().enumerate() {
                    for (column, slot) in slots.iter().enumerate() {
                        let (row_span, column_span, value) = match slot {
                            CellSlot::Origin(cell) => (
                                cell.row_span,
                                cell.col_span,
                                CellValue::Text(block_text(&cell.blocks)),
                            ),
                            CellSlot::Covered {
                                origin_row,
                                origin_col,
                            } => (
                                1,
                                1,
                                CellValue::Covered {
                                    row: *origin_row as u32 + 1,
                                    column: *origin_col as u32 + 1,
                                },
                            ),
                        };
                        cells.push(Cell {
                            row: row as u32 + 1,
                            column: column as u32 + 1,
                            row_span,
                            column_span,
                            raw: None,
                            value,
                            formula: None,
                        });
                    }
                }
                output.tables.push(Table {
                    id: table_id,
                    name: None,
                    header_rows: table.header_rows as u32,
                    cells,
                });
                output.push_block(parent, BlockKind::Table { table_id }, String::new(), None);
            }
        }
    }
}

fn block_text(blocks: &[model::Block]) -> String {
    blocks
        .iter()
        .map(|block| match block {
            model::Block::Paragraph(content) | model::Block::Heading { content, .. } => {
                model::inlines_to_plain_text(content)
            }
            model::Block::CodeBlock { text, .. } => text.clone(),
            model::Block::BlockQuote(blocks) => block_text(blocks),
            model::Block::List(list) => list
                .items
                .iter()
                .map(|item| block_text(&item.blocks))
                .collect::<Vec<_>>()
                .join("\n"),
            model::Block::Table(table) => table
                .grid
                .iter()
                .map(|row| {
                    row.iter()
                        .filter_map(|slot| match slot {
                            CellSlot::Origin(cell) => Some(block_text(&cell.blocks)),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\t")
                })
                .collect::<Vec<_>>()
                .join("\n"),
            model::Block::Rule => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}
