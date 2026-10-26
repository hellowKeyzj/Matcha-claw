use crate::{
    Anchor, Asset, CoverageReason, CoverageStatus, Document, FailureKind, ParseFailure,
    ParseRequest, SourceMapEntry, Target, archive, digest,
};

pub(crate) fn office(request: &ParseRequest<'_>) -> Result<Document, ParseFailure> {
    let mut package = archive::open(request.bytes)?;
    let names = package.file_names().map(str::to_owned).collect::<Vec<_>>();
    let mut references = std::collections::BTreeMap::<String, Vec<Anchor>>::new();
    let mut output = Document::default();
    for name in names
        .iter()
        .filter(|name| name.starts_with("ppt/slides/_rels/slide") && name.ends_with(".xml.rels"))
    {
        request.check_cancelled()?;
        let part = name
            .replace("/_rels/", "/")
            .trim_end_matches(".rels")
            .to_owned();
        match archive::read(&mut package, name).and_then(|bytes| archive::xml(&bytes)) {
            Ok(xml) => {
                for relation in xml.descendants("Relationship") {
                    if relation.attribute("TargetMode") == Some("External") {
                        continue;
                    }
                    if let Some(target) = relation
                        .attribute("Target")
                        .and_then(|target| archive::resolve_part(&part, target))
                    {
                        references
                            .entry(target)
                            .or_default()
                            .push(Anchor::PackagePart {
                                part: part.clone(),
                                element: relation.attribute("Id").map(str::to_owned),
                            });
                    }
                }
            }
            Err(error) => {
                output.diagnostics.push(error);
                output.coverage(
                    Some(Anchor::PackagePart {
                        part: name.clone(),
                        element: None,
                    }),
                    CoverageStatus::Failed,
                    CoverageReason::LocationUnavailable,
                );
            }
        }
    }
    for part in names.into_iter().filter(|name| {
        name.starts_with("ppt/media/")
            || name.starts_with("word/media/")
            || name.starts_with("xl/media/")
            || name.starts_with("Pictures/")
    }) {
        request.check_cancelled()?;
        let anchor = Anchor::PackagePart {
            part: part.clone(),
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
        let bytes = match archive::read(&mut package, &part) {
            Ok(bytes) => bytes,
            Err(error) => {
                output.diagnostics.push(error);
                output.coverage(
                    Some(anchor),
                    CoverageStatus::Failed,
                    CoverageReason::AssetDecodeFailed,
                );
                continue;
            }
        };
        let dimensions = image::load_from_memory(&bytes);
        let (width, height) = match dimensions {
            Ok(image) => (Some(image.width()), Some(image.height())),
            Err(error) => {
                output
                    .diagnostics
                    .push(ParseFailure::caused(FailureKind::Corrupt, error));
                output.coverage(
                    Some(anchor.clone()),
                    CoverageStatus::Missing,
                    CoverageReason::AssetDecodeFailed,
                );
                (None, None)
            }
        };
        if width.zip(height).is_some_and(|(width, height)| {
            width < request.options.images.min_width || height < request.options.images.min_height
        }) {
            output.coverage(
                Some(anchor),
                CoverageStatus::Missing,
                CoverageReason::AssetFiltered,
            );
            continue;
        }
        let id = output.assets.len() as u32;
        output.assets.push(Asset {
            id,
            media_type: mime(&part),
            sha256: digest(&bytes),
            bytes,
            width,
            height,
            derived_from: None,
        });
        output.source_map.push(SourceMapEntry {
            target: Target::Asset { asset_id: id },
            anchor,
        });
        if let Some(anchors) = references.remove(&part) {
            for anchor in anchors {
                output.source_map.push(SourceMapEntry {
                    target: Target::Asset { asset_id: id },
                    anchor,
                });
            }
        }
    }
    Ok(output)
}

fn mime(part: &str) -> String {
    match part
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "svg" => "image/svg+xml",
        "emf" => "image/emf",
        "wmf" => "image/wmf",
        _ => "application/octet-stream",
    }
    .into()
}
