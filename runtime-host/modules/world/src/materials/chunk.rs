use std::collections::{BTreeMap, BTreeSet};

use std::sync::atomic::{AtomicBool, Ordering};
use world_protocol::{
    ids::BlockId,
    materials::{
        BlockKind, DocumentChunkContent, DocumentTable, DocumentTarget, MaterialFailure,
        ParseArtifact,
    },
};

use super::{
    Error,
    selection::{DocumentIndex, fits},
};

pub(crate) struct ChunkLimits {
    pub max_bytes: u64,
    pub max_tokens: u64,
    pub max_chunks: u64,
}

/// Covers every parse block, typed cell and asset without flattening tables or truncating text.
/// Limits apply to serialized content; the generation owner separately accounts for prompt/context overhead.
pub(crate) fn chunk_document(
    artifact: &ParseArtifact,
    limits: &ChunkLimits,
    cancellation: &AtomicBool,
) -> Result<Vec<DocumentChunkContent>, Error> {
    if limits.max_bytes == 0 || limits.max_tokens == 0 || limits.max_chunks == 0 {
        return Err(Error::new(MaterialFailure::InputInvalid));
    }
    let index = DocumentIndex::new(artifact)?;
    let mut chunks = Chunks {
        index,
        limits,
        cancellation,
        primary: Vec::new(),
        context: Vec::new(),
        output: Vec::new(),
    };
    let mut heading = Vec::new();
    let mut seen_tables = BTreeSet::new();
    for block in &artifact.blocks {
        chunks.check_cancelled()?;
        let length = u32::try_from(block.text.len()).map_err(|_| size_limit())?;
        let target = DocumentTarget::Block {
            block_id: block.id.clone(),
            start: 0,
            end: length,
        };
        let context = if matches!(block.kind, BlockKind::Heading { .. }) {
            Vec::new()
        } else {
            heading.clone()
        };
        if chunks.accept(std::slice::from_ref(&target), &context)? {
            if matches!(block.kind, BlockKind::Heading { .. }) {
                heading = vec![target];
            }
        } else {
            chunks.split_block(&block.id, &block.text, &context)?;
            // A heading larger than a chunk remains fully covered, but cannot be repeated whole as context.
            if matches!(block.kind, BlockKind::Heading { .. }) {
                heading.clear();
            }
        }
        if let BlockKind::Table { table_id } = &block.kind {
            if seen_tables.insert(table_id.clone()) {
                let table = *chunks.index.tables.get(table_id).ok_or_else(corrupt)?;
                chunks.table(table, &heading)?;
            }
        }
    }
    for table in &artifact.tables {
        if seen_tables.insert(table.id.clone()) {
            chunks.table(table, &[])?;
        }
    }
    for asset in &artifact.assets {
        chunks.check_cancelled()?;
        if !chunks.accept(
            &[DocumentTarget::Asset {
                asset_id: asset.id.clone(),
            }],
            &[],
        )? {
            return Err(size_limit());
        }
    }
    chunks.flush()?;
    Ok(chunks.output)
}

struct Chunks<'a> {
    index: DocumentIndex<'a>,
    limits: &'a ChunkLimits,
    cancellation: &'a AtomicBool,
    primary: Vec<DocumentTarget>,
    context: Vec<DocumentTarget>,
    output: Vec<DocumentChunkContent>,
}

impl Chunks<'_> {
    fn check_cancelled(&self) -> Result<(), Error> {
        if self.cancellation.load(Ordering::Acquire) {
            Err(Error::new(MaterialFailure::Cancelled))
        } else {
            Ok(())
        }
    }

    fn fits(
        &self,
        primary: Vec<DocumentTarget>,
        context: Vec<DocumentTarget>,
    ) -> Result<bool, Error> {
        fits(
            &self.index.select(primary, context)?,
            self.limits.max_bytes,
            self.limits.max_tokens,
        )
    }

    fn accept(
        &mut self,
        targets: &[DocumentTarget],
        context: &[DocumentTarget],
    ) -> Result<bool, Error> {
        self.check_cancelled()?;
        if self.context != context {
            self.flush()?;
        }
        let mut combined = self.primary.clone();
        combined.extend_from_slice(targets);
        if self.fits(combined.clone(), context.to_vec())? {
            self.primary = combined;
            self.context = context.to_vec();
            return Ok(true);
        }
        self.flush()?;
        if self.fits(targets.to_vec(), context.to_vec())? {
            self.primary = targets.to_vec();
            self.context = context.to_vec();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn flush(&mut self) -> Result<(), Error> {
        if self.primary.is_empty() {
            return Ok(());
        }
        if self.output.len() as u64 >= self.limits.max_chunks {
            return Err(size_limit());
        }
        let content = self.index.select(
            std::mem::take(&mut self.primary),
            std::mem::take(&mut self.context),
        )?;
        self.output.push(content);
        Ok(())
    }

    fn split_block(
        &mut self,
        id: &BlockId,
        text: &str,
        context: &[DocumentTarget],
    ) -> Result<(), Error> {
        let mut start = 0;
        while start < text.len() {
            self.check_cancelled()?;
            let mut low = start + 1;
            let available = self
                .limits
                .max_bytes
                .min(self.limits.max_tokens)
                .min(usize::MAX as u64) as usize;
            let mut high = text.len().min(start.saturating_add(available));
            let mut best = None;
            while low <= high {
                let middle = low + (high - low) / 2;
                let mut end = middle;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                let target = DocumentTarget::Block {
                    block_id: id.clone(),
                    start: start as u32,
                    end: end as u32,
                };
                if end == start {
                    low = middle + 1;
                } else if self.fits(vec![target], context.to_vec())? {
                    best = Some(end);
                    low = middle + 1;
                } else {
                    high = middle - 1;
                }
            }
            let mut end = best.ok_or_else(size_limit)?;
            if end < text.len() {
                let minimum = (end - start) / 2;
                if let Some((offset, character)) = text[start..end]
                    .char_indices()
                    .rev()
                    .find(|(offset, character)| *offset >= minimum && character.is_whitespace())
                {
                    end = start + offset + character.len_utf8();
                }
            }
            let target = DocumentTarget::Block {
                block_id: id.clone(),
                start: start as u32,
                end: end as u32,
            };
            if !self.accept(&[target], context)? {
                return Err(size_limit());
            }
            start = end;
        }
        if text.is_empty() {
            return Err(size_limit());
        }
        Ok(())
    }

    fn table(&mut self, table: &DocumentTable, heading: &[DocumentTarget]) -> Result<(), Error> {
        let mut rows = BTreeMap::<u32, Vec<DocumentTarget>>::new();
        let mut headers = Vec::new();
        for cell in &table.cells {
            let target = DocumentTarget::Cell {
                table_id: table.id.clone(),
                row: cell.row,
                column: cell.column,
            };
            if cell.row <= table.header_rows {
                headers.push(target.clone());
            }
            rows.entry(cell.row).or_default().push(target);
        }
        for (row, cells) in rows {
            self.check_cancelled()?;
            let mut context = heading.to_vec();
            if row > table.header_rows {
                context.extend_from_slice(&headers);
            }
            if super::selection::serialized_size(&cells)?
                <= self.limits.max_bytes.min(self.limits.max_tokens)
                && self.accept(&cells, &context)?
            {
                continue;
            }
            for cell in cells {
                if !self.accept(&[cell], &context)? {
                    return Err(size_limit());
                }
            }
        }
        Ok(())
    }
}

fn size_limit() -> Error {
    Error::new(MaterialFailure::SizeLimit)
}
fn corrupt() -> Error {
    Error::new(MaterialFailure::CorruptContent)
}
