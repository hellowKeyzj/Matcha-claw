use std::collections::BTreeMap;

use sha2::{Digest as _, Sha256};
use world_protocol::{
    ids::{BlockId, ContentId},
    materials::{
        DocumentAsset, DocumentBlock, DocumentChunk, DocumentChunkContent, DocumentTable,
        DocumentTarget, DocumentTextSlice, MaterialFailure, ParseArtifact, ReadNeed,
        SourceMapEntry,
    },
};

use super::Error;

pub(super) struct DocumentIndex<'a> {
    pub artifact: &'a ParseArtifact,
    pub blocks: BTreeMap<&'a BlockId, &'a DocumentBlock>,
    pub tables: BTreeMap<&'a BlockId, &'a DocumentTable>,
    assets: BTreeMap<&'a ContentId, &'a DocumentAsset>,
    cells: BTreeMap<(&'a BlockId, u32, u32), &'a world_protocol::materials::TableCell>,
    locations: BTreeMap<Key<'a>, Vec<&'a SourceMapEntry>>,
}

#[derive(Eq, PartialEq, Ord, PartialOrd)]
enum Key<'a> {
    Block(&'a BlockId),
    Cell(&'a BlockId, u32, u32),
    Asset(&'a ContentId),
}

impl<'a> DocumentIndex<'a> {
    pub fn new(artifact: &'a ParseArtifact) -> Result<Self, Error> {
        let mut index = Self {
            artifact,
            blocks: artifact
                .blocks
                .iter()
                .map(|block| (&block.id, block))
                .collect(),
            tables: artifact
                .tables
                .iter()
                .map(|table| (&table.id, table))
                .collect(),
            assets: artifact
                .assets
                .iter()
                .map(|asset| (&asset.id, asset))
                .collect(),
            cells: BTreeMap::new(),
            locations: BTreeMap::new(),
        };
        if index.blocks.len() != artifact.blocks.len()
            || index.tables.len() != artifact.tables.len()
            || index.assets.len() != artifact.assets.len()
        {
            return Err(invalid());
        }
        for table in &artifact.tables {
            for cell in &table.cells {
                if index
                    .cells
                    .insert((&table.id, cell.row, cell.column), cell)
                    .is_some()
                {
                    return Err(invalid());
                }
            }
        }
        for entry in &artifact.source_map {
            let key = match &entry.target {
                DocumentTarget::Block { block_id, .. } => Key::Block(block_id),
                DocumentTarget::Cell {
                    table_id,
                    row,
                    column,
                } => Key::Cell(table_id, *row, *column),
                DocumentTarget::Asset { asset_id } => Key::Asset(asset_id),
            };
            index.locations.entry(key).or_default().push(entry);
        }
        Ok(index)
    }

    pub fn select(
        &self,
        primary: Vec<DocumentTarget>,
        context: Vec<DocumentTarget>,
    ) -> Result<DocumentChunkContent, Error> {
        if primary.is_empty() {
            return Err(invalid());
        }
        let identity = serde_json::to_vec(&(
            &self.artifact.id,
            &self.artifact.source_version,
            &primary,
            &context,
        ))
        .map_err(|cause| Error::caused(MaterialFailure::InternalFault, cause))?;
        let id = BlockId::try_new(format!("chunk-{:x}", Sha256::digest(identity)))
            .map_err(|_| invalid())?;
        let mut content = DocumentChunkContent {
            chunk: DocumentChunk {
                id,
                source_version: self.artifact.source_version.clone(),
                parse_artifact_id: self.artifact.id.clone(),
                primary_targets: primary,
                context_targets: context,
                anchors: Vec::new(),
                token_estimate: 0,
            },
            blocks: Vec::new(),
            tables: Vec::new(),
            assets: Vec::new(),
            source_map: Vec::new(),
            coverage: Vec::new(),
        };
        for target in content
            .chunk
            .primary_targets
            .iter()
            .chain(&content.chunk.context_targets)
        {
            let key = match target {
                DocumentTarget::Block {
                    block_id,
                    start,
                    end,
                } => {
                    let block = self.blocks.get(block_id).ok_or_else(invalid)?;
                    let text = block
                        .text
                        .get(*start as usize..*end as usize)
                        .ok_or_else(invalid)?;
                    if !content.blocks.iter().any(|slice| {
                        slice.block_id == *block_id && slice.start == *start && slice.end == *end
                    }) {
                        content.blocks.push(DocumentTextSlice {
                            block_id: block_id.clone(),
                            start: *start,
                            end: *end,
                            text: text.to_owned(),
                            kind: block.kind.clone(),
                            parent: block.parent.clone(),
                        });
                    }
                    Key::Block(block_id)
                }
                DocumentTarget::Cell {
                    table_id,
                    row,
                    column,
                } => {
                    let table = self.tables.get(table_id).ok_or_else(invalid)?;
                    let cell = self
                        .cells
                        .get(&(table_id, *row, *column))
                        .ok_or_else(invalid)?;
                    let position = match content
                        .tables
                        .iter()
                        .position(|table| table.id == *table_id)
                    {
                        Some(position) => position,
                        None => {
                            content.tables.push(DocumentTable {
                                id: table.id.clone(),
                                name: table.name.clone(),
                                header_rows: table.header_rows,
                                cells: Vec::new(),
                            });
                            content.tables.len() - 1
                        }
                    };
                    if !content.tables[position]
                        .cells
                        .iter()
                        .any(|cell| cell.row == *row && cell.column == *column)
                    {
                        content.tables[position].cells.push((*cell).clone());
                    }
                    Key::Cell(table_id, *row, *column)
                }
                DocumentTarget::Asset { asset_id } => {
                    let asset = self.assets.get(asset_id).ok_or_else(invalid)?;
                    if !content.assets.iter().any(|asset| asset.id == *asset_id) {
                        content.assets.push((*asset).clone());
                    }
                    Key::Asset(asset_id)
                }
            };
            if let Some(entries) = self.locations.get(&key) {
                for entry in entries {
                    if overlaps(target, &entry.target) {
                        let entry = selected_mapping(target, entry);
                        if !content.source_map.contains(&entry) {
                            if !content.chunk.anchors.contains(&entry.anchor) {
                                content.chunk.anchors.push(entry.anchor.clone());
                            }
                            content.source_map.push(entry);
                        }
                    }
                }
            }
        }
        content.coverage = self
            .artifact
            .coverage
            .iter()
            .filter(|entry| {
                entry.anchor.as_ref().is_none_or(|anchor| {
                    content
                        .chunk
                        .anchors
                        .iter()
                        .any(|selected| same_location(anchor, selected))
                })
            })
            .cloned()
            .collect();
        // Conservative byte-based estimate, not a claim to use the remote model's tokenizer.
        content.chunk.token_estimate = u64::MAX;
        content.chunk.token_estimate = serialized_size(&content)?;
        Ok(content)
    }
}

pub(crate) fn read_targets(
    artifact: &ParseArtifact,
    need: &ReadNeed,
    max_bytes: u64,
    max_tokens: u64,
) -> Result<DocumentChunkContent, Error> {
    if artifact.source_version != need.source_version || artifact.id != need.parse_artifact_id {
        return Err(Error::new(MaterialFailure::DigestMismatch));
    }
    let content = DocumentIndex::new(artifact)?.select(need.targets.clone(), Vec::new())?;
    if !fits(&content, max_bytes, max_tokens)? {
        return Err(Error::new(MaterialFailure::SizeLimit));
    }
    Ok(content)
}

pub(super) fn fits(content: &DocumentChunkContent, bytes: u64, tokens: u64) -> Result<bool, Error> {
    let size = serialized_size(content)?;
    Ok(size <= bytes && content.chunk.token_estimate <= tokens)
}

pub(super) fn serialized_size(value: &impl serde::Serialize) -> Result<u64, Error> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len() as u64)
        .map_err(|cause| Error::caused(MaterialFailure::InternalFault, cause))
}

fn overlaps(selected: &DocumentTarget, mapped: &DocumentTarget) -> bool {
    match (selected, mapped) {
        (
            DocumentTarget::Block {
                block_id: left,
                start,
                end,
            },
            DocumentTarget::Block {
                block_id: right,
                start: mapped_start,
                end: mapped_end,
            },
        ) => {
            left == right
                && ((*start == *end && *start == *mapped_start && *mapped_start == *mapped_end)
                    || (*start < *mapped_end && *mapped_start < *end))
        }
        _ => selected == mapped,
    }
}

fn selected_mapping(selected: &DocumentTarget, mapped: &SourceMapEntry) -> SourceMapEntry {
    use world_protocol::materials::SourceAnchor;
    let (
        DocumentTarget::Block {
            block_id,
            start,
            end,
        },
        DocumentTarget::Block {
            start: mapped_start,
            end: mapped_end,
            ..
        },
    ) = (selected, &mapped.target)
    else {
        return mapped.clone();
    };
    let start = (*start).max(*mapped_start);
    let end = (*end).min(*mapped_end);
    let mut anchor = mapped.anchor.clone();
    match &mut anchor {
        SourceAnchor::Text {
            start: source_start,
            end: source_end,
        } if source_end.checked_sub(*source_start)
            == Some(u64::from(*mapped_end - *mapped_start)) =>
        {
            let original = *source_start;
            *source_start = original + u64::from(start - *mapped_start);
            *source_end = original + u64::from(end - *mapped_start);
        }
        SourceAnchor::Html {
            text_start,
            text_end,
            ..
        } if text_end.checked_sub(*text_start) == Some(u64::from(*mapped_end - *mapped_start)) => {
            let original = *text_start;
            *text_start = original + u64::from(start - *mapped_start);
            *text_end = original + u64::from(end - *mapped_start);
        }
        _ => {}
    }
    SourceMapEntry {
        target: DocumentTarget::Block {
            block_id: block_id.clone(),
            start,
            end,
        },
        anchor,
    }
}

fn same_location(
    left: &world_protocol::materials::SourceAnchor,
    right: &world_protocol::materials::SourceAnchor,
) -> bool {
    use world_protocol::materials::SourceAnchor;
    match (left, right) {
        (SourceAnchor::Pdf { page: left, .. }, SourceAnchor::Pdf { page: right, .. }) => {
            left == right
        }
        (SourceAnchor::Sheet { sheet: left, .. }, SourceAnchor::Sheet { sheet: right, .. }) => {
            left == right
        }
        (
            SourceAnchor::Text { start, end },
            SourceAnchor::Text {
                start: right_start,
                end: right_end,
            },
        ) => start <= right_end && right_start <= end,
        (
            SourceAnchor::Html {
                node_path: left, ..
            },
            SourceAnchor::Html {
                node_path: right, ..
            },
        ) => left == right,
        (
            SourceAnchor::PackagePart { part: left, .. },
            SourceAnchor::PackagePart { part: right, .. },
        ) => left == right,
        _ => left == right,
    }
}

fn invalid() -> Error {
    Error::new(MaterialFailure::CorruptContent)
}
