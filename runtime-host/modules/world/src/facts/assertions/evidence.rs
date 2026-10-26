use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    facts::{Evidence, EvidenceAvailability, EvidenceStatus, FactFailure},
    ids::{EvidenceRef, Revision},
    materials::{
        CoverageEntry, CoverageReason, CoverageStatus, DocumentCellValue, DocumentTarget,
        ParseArtifact, SourceAnchor, SourceVersion, ValuePrecision,
    },
};

pub(crate) fn validate_evidence(
    evidence: &Evidence,
    source: &SourceVersion,
    artifact: Option<&ParseArtifact>,
    previous: Option<&Evidence>,
) -> Result<(), FactFailure> {
    let incomplete = || FactFailure::EvidenceIncomplete {
        reference: evidence.reference.clone(),
    };
    if evidence.reference.world != evidence.locator.source_version.world
        || evidence.reference.world != source.reference.world
        || artifact.is_some_and(|artifact| artifact.world != evidence.reference.world)
    {
        return Err(FactFailure::CrossWorld);
    }
    if evidence.locator.source_version != source.reference
        || evidence.origin_family != source.origin_family
        || evidence.access != source.access
        || evidence.retention != source.retention
        || evidence.access.revision.0 == 0
        || evidence.retention.revision.0 == 0
    {
        return Err(incomplete());
    }
    validate_revision(evidence, previous)?;
    if !anchor_valid(&evidence.locator.anchor) {
        return Err(FactFailure::InvalidEvidenceLocator {
            reference: evidence.reference.clone(),
        });
    }
    match (evidence.locator.parse_artifact_id.as_ref(), artifact) {
        (None, None) if matches!(evidence.locator.anchor, SourceAnchor::Record { .. }) => Ok(()),
        (Some(id), Some(artifact))
            if id == &artifact.id && artifact.source_version == source.reference =>
        {
            let anchor = &evidence.locator.anchor;
            let covered = artifact.coverage.iter().any(|entry| {
                entry.status == CoverageStatus::Processed
                    && entry
                        .anchor
                        .as_ref()
                        .is_none_or(|covered| coverage_contains(covered, anchor))
            });
            if !covered
                || !artifact.source_map.iter().any(|entry| {
                    anchor_valid(&entry.anchor)
                        && anchor_contains(&entry.anchor, anchor)
                        && target_exists(artifact, &entry.target)
                        && !artifact.coverage.iter().any(|coverage| {
                            coverage_blocks(coverage, anchor, &entry.target, artifact)
                        })
                })
            {
                return Err(incomplete());
            }
            Ok(())
        }
        _ => Err(incomplete()),
    }
}

pub(super) fn validate_revision(
    evidence: &Evidence,
    previous: Option<&Evidence>,
) -> Result<(), FactFailure> {
    let incomplete = || FactFailure::EvidenceIncomplete {
        reference: evidence.reference.clone(),
    };
    let expected = match previous {
        Some(previous) => {
            if previous.reference.world != evidence.reference.world
                || previous.reference.id != evidence.reference.id
                || previous.locator != evidence.locator
                || previous.origin_family != evidence.origin_family
                || previous.derived_from != evidence.derived_from
                || previous.digest != evidence.digest
                || previous.observed_at != evidence.observed_at
                || previous.authority != evidence.authority
                || previous.access != evidence.access
                || previous.retention != evidence.retention
                || previous.status == EvidenceStatus::ContentDeleted
                || (previous.status == EvidenceStatus::Withdrawn
                    && evidence.status != EvidenceStatus::ContentDeleted)
            {
                return Err(incomplete());
            }
            previous.reference.revision.0.checked_add(1)
        }
        None => Some(1),
    };
    if expected != Some(evidence.reference.revision.0) {
        return Err(FactFailure::RevisionConflict {
            expected: Revision(expected.unwrap_or(u64::MAX)),
            actual: evidence.reference.revision,
        });
    }
    let parents: BTreeSet<_> = evidence.derived_from.iter().collect();
    if parents.len() != evidence.derived_from.len()
        || parents.contains(&evidence.reference)
        || parents
            .iter()
            .any(|parent| parent.world != evidence.reference.world)
    {
        return Err(incomplete());
    }
    if !anchor_valid(&evidence.locator.anchor) {
        return Err(FactFailure::InvalidEvidenceLocator {
            reference: evidence.reference.clone(),
        });
    }
    Ok(())
}

/// Traverses exact revision edges. Copies retain their ancestors; no vote or independence is inferred.
pub(crate) fn validate_lineage(
    evidence: &Evidence,
    ancestors: &BTreeMap<EvidenceRef, Evidence>,
) -> Result<(), FactFailure> {
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut pending = vec![(&evidence.reference, false)];
    while let Some((reference, exit)) = pending.pop() {
        if exit {
            visiting.remove(reference);
            visited.insert(reference);
            continue;
        }
        if visited.contains(reference) {
            continue;
        }
        if !visiting.insert(reference) {
            return Err(FactFailure::EvidenceCycle {
                references: visiting.into_iter().cloned().collect(),
            });
        }
        let current = if reference == &evidence.reference {
            evidence
        } else {
            ancestors
                .get(reference)
                .ok_or_else(|| FactFailure::EvidenceMissing {
                    reference: reference.clone(),
                })?
        };
        if current.reference != *reference || reference.world != evidence.reference.world {
            return Err(FactFailure::CrossWorld);
        }
        pending.push((reference, true));
        pending.extend(current.derived_from.iter().map(|parent| (parent, false)));
    }
    Ok(())
}

pub(super) fn require_active(evidence: &Evidence) -> Result<(), FactFailure> {
    match evidence.status {
        EvidenceStatus::ContentDeleted => {
            return Err(FactFailure::EvidenceDeleted {
                reference: evidence.reference.clone(),
            });
        }
        EvidenceStatus::Withdrawn => {
            return Err(FactFailure::EvidenceIncomplete {
                reference: evidence.reference.clone(),
            });
        }
        EvidenceStatus::Active => {}
    }
    if evidence.availability == EvidenceAvailability::Unavailable {
        return Err(FactFailure::EvidenceUnavailable {
            reference: evidence.reference.clone(),
        });
    }
    Ok(())
}

fn anchor_valid(anchor: &SourceAnchor) -> bool {
    match anchor {
        SourceAnchor::Text { start, end } => start < end,
        SourceAnchor::Pdf { page, bbox } => {
            *page > 0
                && bbox.as_ref().is_none_or(|bbox| {
                    [bbox.left, bbox.bottom, bbox.right, bbox.top]
                        .iter()
                        .all(|value| value.is_finite())
                        && bbox.left < bbox.right
                        && bbox.bottom < bbox.top
                })
        }
        SourceAnchor::Html {
            node_path,
            text_start,
            text_end,
        } => {
            text_start < text_end
                && node_path
                    .as_ref()
                    .is_none_or(|path| !path.trim().is_empty())
        }
        SourceAnchor::Sheet { sheet, row, column } => {
            !sheet.trim().is_empty() && *row > 0 && *column > 0
        }
        SourceAnchor::PackagePart { part, element } => {
            !part.trim().is_empty()
                && element
                    .as_ref()
                    .is_none_or(|element| !element.trim().is_empty())
        }
        SourceAnchor::Media {
            start_ms: Some(start),
            end_ms: Some(end),
        } => start < end,
        SourceAnchor::Media { .. } => false,
        SourceAnchor::Record {
            namespace,
            native_key,
            fields,
        } => {
            !namespace.trim().is_empty()
                && !native_key.trim().is_empty()
                && !fields.is_empty()
                && fields.iter().all(|field| !field.trim().is_empty())
                && fields.iter().collect::<BTreeSet<_>>().len() == fields.len()
        }
    }
}

fn target_exists(artifact: &ParseArtifact, target: &DocumentTarget) -> bool {
    match target {
        DocumentTarget::Block {
            block_id,
            start,
            end,
        } => {
            start < end
                && artifact.blocks.iter().any(|block| {
                    &block.id == block_id
                        && block.text.get(*start as usize..*end as usize).is_some()
                })
        }
        DocumentTarget::Cell {
            table_id,
            row,
            column,
        } => {
            *row > 0
                && *column > 0
                && artifact.tables.iter().any(|table| {
                    &table.id == table_id
                        && table
                            .cells
                            .iter()
                            .any(|cell| cell.row == *row && cell.column == *column)
                })
        }
        DocumentTarget::Asset { asset_id } => {
            artifact.assets.iter().any(|asset| &asset.id == asset_id)
        }
    }
}

fn coverage_contains(outer: &SourceAnchor, inner: &SourceAnchor) -> bool {
    match (outer, inner) {
        (
            SourceAnchor::Sheet {
                sheet: a,
                row: 1,
                column: 1,
            },
            SourceAnchor::Sheet { sheet: b, .. },
        ) => a == b,
        _ => anchor_valid(outer) && anchor_contains(outer, inner),
    }
}

fn coverage_blocks(
    entry: &CoverageEntry,
    anchor: &SourceAnchor,
    target: &DocumentTarget,
    artifact: &ParseArtifact,
) -> bool {
    if entry.status == CoverageStatus::Processed
        || entry.anchor.as_ref().is_some_and(|failed| {
            !coverage_contains(failed, anchor) && !anchor_overlaps(failed, anchor)
        })
    {
        return false;
    }
    let cell = match target {
        DocumentTarget::Cell {
            table_id,
            row,
            column,
        } => artifact
            .tables
            .iter()
            .find(|table| &table.id == table_id)
            .and_then(|table| {
                table
                    .cells
                    .iter()
                    .find(|cell| cell.row == *row && cell.column == *column)
            }),
        _ => None,
    };
    match &entry.reason {
        Some(
            CoverageReason::AssetExtractionDisabled
            | CoverageReason::AssetFiltered
            | CoverageReason::AssetDecodeFailed
            | CoverageReason::AssetEncodeFailed
            | CoverageReason::ImageLimit { .. },
        ) => matches!(target, DocumentTarget::Asset { .. }),
        Some(CoverageReason::OcrUnavailable) => matches!(target, DocumentTarget::Asset { .. }),
        // Exact source-map anchors prove available location; absent coordinates are never invented.
        Some(CoverageReason::LocationUnavailable) => false,
        Some(CoverageReason::TimingUnavailable) => matches!(anchor, SourceAnchor::Media { .. }),
        Some(CoverageReason::RawValueUnavailable) => cell.is_some_and(|cell| {
            cell.raw.is_none()
                && !matches!(
                    cell.value,
                    DocumentCellValue::Text(_)
                        | DocumentCellValue::Boolean(_)
                        | DocumentCellValue::Null
                )
        }),
        Some(CoverageReason::PrecisionUnavailable | CoverageReason::BinaryFloatPrecision) => {
            cell.is_some_and(|cell| cell.precision != ValuePrecision::Exact)
        }
        Some(CoverageReason::FormulaUnavailable) => cell.is_some_and(|cell| {
            cell.formula.is_none()
                && !matches!(
                    cell.value,
                    DocumentCellValue::Text(_)
                        | DocumentCellValue::Boolean(_)
                        | DocumentCellValue::Null
                )
        }),
        Some(CoverageReason::UpstreamRecoveryNotReported) => false,
        Some(CoverageReason::ParserRecovery { failure: None, .. }) => false,
        _ => true,
    }
}

pub(crate) fn anchor_contains(outer: &SourceAnchor, inner: &SourceAnchor) -> bool {
    match (outer, inner) {
        (SourceAnchor::Text { start: a, end: b }, SourceAnchor::Text { start: c, end: d }) => {
            a <= c && d <= b
        }
        (
            SourceAnchor::Html {
                node_path: a,
                text_start: b,
                text_end: c,
            },
            SourceAnchor::Html {
                node_path: d,
                text_start: e,
                text_end: f,
            },
        ) => a == d && b <= e && f <= c,
        (
            SourceAnchor::Pdf {
                page: a,
                bbox: outer,
            },
            SourceAnchor::Pdf {
                page: b,
                bbox: inner,
            },
        ) => {
            a == b
                && match (outer, inner) {
                    (None, _) => true,
                    (Some(outer), Some(inner)) => {
                        outer.left <= inner.left
                            && outer.bottom <= inner.bottom
                            && inner.right <= outer.right
                            && inner.top <= outer.top
                    }
                    _ => false,
                }
        }
        (
            SourceAnchor::Media {
                start_ms: Some(a),
                end_ms: Some(b),
            },
            SourceAnchor::Media {
                start_ms: Some(c),
                end_ms: Some(d),
            },
        ) => a <= c && d <= b,
        (
            SourceAnchor::Record {
                namespace: a,
                native_key: b,
                fields: c,
            },
            SourceAnchor::Record {
                namespace: d,
                native_key: e,
                fields: f,
            },
        ) => a == d && b == e && f.iter().all(|field| c.contains(field)),
        _ => outer == inner,
    }
}

fn anchor_overlaps(left: &SourceAnchor, right: &SourceAnchor) -> bool {
    match (left, right) {
        (SourceAnchor::Text { start: a, end: b }, SourceAnchor::Text { start: c, end: d }) => {
            a < d && c < b
        }
        (
            SourceAnchor::Html {
                node_path: a,
                text_start: b,
                text_end: c,
            },
            SourceAnchor::Html {
                node_path: d,
                text_start: e,
                text_end: f,
            },
        ) => a == d && b < f && e < c,
        (
            SourceAnchor::Pdf {
                page: a,
                bbox: left,
            },
            SourceAnchor::Pdf {
                page: b,
                bbox: right,
            },
        ) => {
            a == b
                && match (left, right) {
                    (Some(left), Some(right)) => {
                        left.left < right.right
                            && right.left < left.right
                            && left.bottom < right.top
                            && right.bottom < left.top
                    }
                    _ => true,
                }
        }
        (
            SourceAnchor::Media {
                start_ms: Some(a),
                end_ms: Some(b),
            },
            SourceAnchor::Media {
                start_ms: Some(c),
                end_ms: Some(d),
            },
        ) => a < d && c < b,
        (
            SourceAnchor::Record {
                namespace: a,
                native_key: b,
                fields: c,
            },
            SourceAnchor::Record {
                namespace: d,
                native_key: e,
                fields: f,
            },
        ) => a == d && b == e && c.iter().any(|field| f.contains(field)),
        _ => left == right,
    }
}
