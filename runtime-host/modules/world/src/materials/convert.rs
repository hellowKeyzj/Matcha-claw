use std::collections::{BTreeMap, BTreeSet};

use document_parser as parser;
use world_protocol::{
    ids::{BlockId, ContentId, Digest, ParseArtifactId},
    materials::{self as wire, MaterialFailure},
};

use super::Error;
use crate::content::ParseInput;

pub(super) fn digest(raw: &str) -> Result<Digest, Error> {
    Digest::try_new(format!("sha256:{raw}"))
        .map_err(|_| Error::new(MaterialFailure::CorruptContent))
}

fn block_id(artifact: &ParseArtifactId, kind: &str, id: u32) -> BlockId {
    use sha2::{Digest as _, Sha256};
    BlockId::try_new(format!(
        "{kind}-{:x}-{id}",
        Sha256::digest(artifact.as_str().as_bytes())
    ))
    .expect("bounded parser identifier")
}

pub(super) fn asset_id(artifact: &ParseArtifactId, id: u32) -> ContentId {
    ContentId::try_new(block_id(artifact, "asset", id).as_str()).expect("bounded parser identifier")
}

pub(super) fn project(
    document: parser::Document,
    mut input: ParseInput,
    blobs: &[wire::BlobRef],
) -> Result<ParseInput, Error> {
    let artifact = &input.id;
    let blocks = document
        .blocks
        .iter()
        .map(|block| (block.id, block))
        .collect::<BTreeMap<_, _>>();
    let tables = document
        .tables
        .iter()
        .map(|table| table.id)
        .collect::<BTreeSet<_>>();
    let assets = document
        .assets
        .iter()
        .map(|asset| asset.id)
        .collect::<BTreeSet<_>>();
    if blocks.len() != document.blocks.len()
        || tables.len() != document.tables.len()
        || assets.len() != document.assets.len()
        || blobs.len() != document.assets.len()
    {
        return Err(invalid());
    }
    for block in &document.blocks {
        if block
            .parent
            .is_some_and(|parent| parent == block.id || !blocks.contains_key(&parent))
        {
            return Err(invalid());
        }
    }
    for entry in &document.source_map {
        match &entry.target {
            parser::Target::Block {
                block_id,
                start,
                end,
            } => {
                let block = blocks.get(block_id).ok_or_else(invalid)?;
                let start = usize::try_from(*start).map_err(|_| invalid())?;
                let end = usize::try_from(*end).map_err(|_| invalid())?;
                if block.text.get(start..end).is_none() {
                    return Err(invalid());
                }
            }
            parser::Target::Cell {
                table_id,
                row,
                column,
            } => {
                if !document.tables.iter().any(|table| {
                    table.id == *table_id
                        && table
                            .cells
                            .iter()
                            .any(|cell| cell.row == *row && cell.column == *column)
                }) {
                    return Err(invalid());
                }
            }
            parser::Target::Asset { asset_id } if !assets.contains(asset_id) => {
                return Err(invalid());
            }
            parser::Target::Asset { .. } => {}
        }
    }
    input.blocks = document
        .blocks
        .into_iter()
        .map(|block| {
            let kind = match block.kind {
                parser::BlockKind::Paragraph => wire::BlockKind::Paragraph,
                parser::BlockKind::Heading { level } => wire::BlockKind::Heading { level },
                parser::BlockKind::ListItem => wire::BlockKind::ListItem,
                parser::BlockKind::Quote => wire::BlockKind::Quote,
                parser::BlockKind::Code { language } => wire::BlockKind::Code { language },
                parser::BlockKind::Rule => wire::BlockKind::Rule,
                parser::BlockKind::Table { table_id } => {
                    if !tables.contains(&table_id) {
                        return Err(invalid());
                    }
                    wire::BlockKind::Table {
                        table_id: block_id(artifact, "table", table_id),
                    }
                }
                parser::BlockKind::Note => wire::BlockKind::Note,
            };
            Ok(wire::DocumentBlock {
                id: block_id(artifact, "block", block.id),
                parent: block.parent.map(|id| block_id(artifact, "block", id)),
                kind,
                text: block.text,
            })
        })
        .collect::<Result<_, Error>>()?;
    input.tables = document
        .tables
        .into_iter()
        .map(|table| {
            let cells = table
                .cells
                .into_iter()
                .map(|cell| {
                    if cell.row == 0
                        || cell.column == 0
                        || cell.row_span == 0
                        || cell.column_span == 0
                    {
                        return Err(invalid());
                    }
                    let (value, precision) = cell_value(cell.value)?;
                    Ok(wire::TableCell {
                        row: cell.row,
                        column: cell.column,
                        row_span: cell.row_span,
                        column_span: cell.column_span,
                        raw: cell.raw,
                        value,
                        formula: cell.formula,
                        precision,
                    })
                })
                .collect::<Result<_, Error>>()?;
            Ok(wire::DocumentTable {
                id: block_id(artifact, "table", table.id),
                name: table.name,
                header_rows: table.header_rows,
                cells,
            })
        })
        .collect::<Result<_, Error>>()?;
    let source_map = document
        .source_map
        .into_iter()
        .map(|entry| {
            let target = match entry.target {
                parser::Target::Block {
                    block_id: id,
                    start,
                    end,
                } => wire::DocumentTarget::Block {
                    block_id: block_id(artifact, "block", id),
                    start: u32::try_from(start).map_err(|_| invalid())?,
                    end: u32::try_from(end).map_err(|_| invalid())?,
                },
                parser::Target::Cell {
                    table_id,
                    row,
                    column,
                } => wire::DocumentTarget::Cell {
                    table_id: block_id(artifact, "table", table_id),
                    row,
                    column,
                },
                parser::Target::Asset { asset_id: id } => wire::DocumentTarget::Asset {
                    asset_id: asset_id(artifact, id),
                },
            };
            Ok(wire::SourceMapEntry {
                target,
                anchor: anchor(entry.anchor)?,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    input.assets = document
        .assets
        .into_iter()
        .zip(blobs)
        .map(|(asset, blob)| {
            if blob.digest != digest(&asset.sha256)?
                || blob.byte_size != asset.bytes.len() as u64
            {
                return Err(Error::new(MaterialFailure::DigestMismatch));
            }
            let id = asset_id(artifact, asset.id);
            let source_anchor = source_map.iter().find_map(|entry| match &entry.target {
                wire::DocumentTarget::Asset { asset_id } if asset_id == &id => {
                    Some(entry.anchor.clone())
                }
                _ => None,
            });
            Ok(wire::DocumentAsset {
                id,
                blob: blob.clone(),
                media_type: asset.media_type,
                width: asset.width,
                height: asset.height,
                source_digest: asset.derived_from.as_deref().map(digest).transpose()?,
                source_anchor,
                derived_from: Vec::new(),
                derivation: None,
            })
        })
        .collect::<Result<_, Error>>()?;
    input.source_map = source_map;
    input.metadata = document.metadata;
    input.coverage = document
        .coverage
        .entries
        .into_iter()
        .map(|entry| {
            Ok(wire::CoverageEntry {
                anchor: entry.anchor.map(anchor).transpose()?,
                status: match entry.status {
                    parser::CoverageStatus::Processed => wire::CoverageStatus::Processed,
                    parser::CoverageStatus::Missing => wire::CoverageStatus::Missing,
                    parser::CoverageStatus::Failed => wire::CoverageStatus::Failed,
                    parser::CoverageStatus::Truncated => wire::CoverageStatus::Truncated,
                    parser::CoverageStatus::Fallback => wire::CoverageStatus::Fallback,
                },
                reason: Some(reason(entry.reason)?),
            })
        })
        .collect::<Result<_, Error>>()?;
    if input.coverage.is_empty() {
        return Err(invalid());
    }
    Ok(input)
}

fn cell_value(
    value: parser::CellValue,
) -> Result<(wire::DocumentCellValue, wire::ValuePrecision), Error> {
    use parser::CellValue as V;
    use wire::{DocumentCellValue as W, ValuePrecision as P};
    Ok(match value {
        V::Missing => (W::Missing, P::Unavailable),
        V::Null => (W::Null, P::Exact),
        V::Text(value) => (W::Text(value), P::Exact),
        V::Boolean(value) => (W::Boolean(value), P::Exact),
        V::Integer(value) => (W::Integer(value), P::Exact),
        V::Decimal(value) => (W::Decimal(value), P::Exact),
        V::Float(value) if value.is_finite() => (W::Float(value), P::Approximate),
        V::DateTime { serial, display } if serial.is_finite() => {
            (W::DateTime { serial, display }, P::Approximate)
        }
        V::DateTimeIso(value) => (W::DateTimeIso(value), P::Exact),
        V::DurationIso(value) => (W::DurationIso(value), P::Exact),
        V::Error(value) => (W::Error(value), P::Unavailable),
        V::Covered { row, column } => (W::Covered { row, column }, P::Unavailable),
        V::Float(_) | V::DateTime { .. } => return Err(invalid()),
    })
}

pub(super) fn anchor(value: parser::Anchor) -> Result<wire::SourceAnchor, Error> {
    Ok(match value {
        parser::Anchor::Text { start, end } if start <= end => {
            wire::SourceAnchor::Text { start, end }
        }
        parser::Anchor::Pdf { page, bbox } if page > 0 => wire::SourceAnchor::Pdf {
            page,
            bbox: bbox
                .map(|bbox| {
                    if ![bbox.left, bbox.bottom, bbox.right, bbox.top]
                        .iter()
                        .all(|value| value.is_finite())
                        || bbox.left > bbox.right
                        || bbox.bottom > bbox.top
                    {
                        return Err(invalid());
                    }
                    Ok(wire::BoundingBox {
                        left: bbox.left.into(),
                        bottom: bbox.bottom.into(),
                        right: bbox.right.into(),
                        top: bbox.top.into(),
                    })
                })
                .transpose()?,
        },
        parser::Anchor::Html {
            node_path,
            text_start,
            text_end,
        } if text_start <= text_end => wire::SourceAnchor::Html {
            node_path,
            text_start,
            text_end,
        },
        parser::Anchor::Sheet { sheet, row, column } if row > 0 && column > 0 => {
            wire::SourceAnchor::Sheet { sheet, row, column }
        }
        parser::Anchor::PackagePart { part, element } => {
            wire::SourceAnchor::PackagePart { part, element }
        }
        parser::Anchor::Media { start_ms, end_ms } if !matches!((start_ms, end_ms), (Some(start), Some(end)) if start > end) => {
            wire::SourceAnchor::Media { start_ms, end_ms }
        }
        _ => return Err(invalid()),
    })
}

fn reason(value: parser::CoverageReason) -> Result<wire::CoverageReason, Error> {
    use parser::CoverageReason as R;
    use wire::CoverageReason as W;
    Ok(match value {
        R::Parsed => W::Parsed,
        R::OcrUnavailable => W::OcrUnavailable,
        R::TranscriptionUnavailable => W::TranscriptionUnavailable,
        R::TimingUnavailable => W::TimingUnavailable,
        R::LocationUnavailable => W::LocationUnavailable,
        R::RawValueUnavailable => W::RawValueUnavailable,
        R::BinaryFloatPrecision => W::BinaryFloatPrecision,
        R::FormulaUnavailable => W::FormulaUnavailable,
        R::AssetExtractionDisabled => W::AssetExtractionDisabled,
        R::AssetFiltered => W::AssetFiltered,
        R::AssetDecodeFailed => W::AssetDecodeFailed,
        R::AssetEncodeFailed => W::AssetEncodeFailed,
        R::ImageLimit { limit } => W::ImageLimit {
            limit: u64::try_from(limit).map_err(|_| invalid())?,
        },
        R::TextUnavailable => W::TextUnavailable,
        R::ChapterUnavailable => W::ChapterUnavailable,
        R::ParserRecovery { parser, failure } => W::ParserRecovery {
            parser,
            failure: failure.map(|failure| {
                use parser::FailureKind as F;
                use wire::ParseFailureKind as G;
                match failure {
                    F::Unsupported => G::Unsupported,
                    F::Corrupt => G::Corrupt,
                    F::Encrypted => G::Encrypted,
                    F::ParserUnavailable => G::ParserUnavailable,
                    F::ResourceLimit => G::ResourceLimit,
                    F::Cancelled => G::Cancelled,
                    F::Internal => G::Internal,
                }
            }),
        },
        R::UpstreamRecoveryNotReported => W::UpstreamRecoveryNotReported,
        R::LossyTextDecoding => W::LossyTextDecoding,
        R::SheetReadFailed => W::SheetReadFailed,
    })
}

fn invalid() -> Error {
    Error::new(MaterialFailure::CorruptContent)
}
