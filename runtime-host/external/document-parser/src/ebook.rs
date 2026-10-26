use std::io::Cursor;
use std::path::Path;

use epub::doc::EpubDoc;
use mobi::headers::Encryption;

use crate::{
    Anchor, Asset, CoverageReason, CoverageStatus, Document, FailureKind, ParseFailure,
    ParseRequest, SourceMapEntry, Target, archive, digest,
};

const MAX_CHAPTER_BYTES: usize = 16 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn parse(request: &ParseRequest<'_>, extension: &str) -> Result<Document, ParseFailure> {
    match extension {
        "epub" => epub(request),
        "mobi" => mobi(request),
        _ => Err(ParseFailure::new(FailureKind::Unsupported)),
    }
}

fn epub(request: &ParseRequest<'_>) -> Result<Document, ParseFailure> {
    let mut package = archive::open(request.bytes)?;
    for index in 0..package.len() {
        request.check_cancelled()?;
        let entry = package
            .by_index_raw(index)
            .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
        if matches!(
            Path::new(entry.name())
                .extension()
                .and_then(|value| value.to_str()),
            Some("html" | "htm" | "xhtml" | "xml")
        ) && entry.size() > MAX_CHAPTER_BYTES as u64
        {
            return Err(ParseFailure::limit("epub_chapter_bytes"));
        }
    }
    if package
        .file_names()
        .any(|name| name == "META-INF/encryption.xml")
    {
        let encryption = archive::xml(&archive::read(&mut package, "META-INF/encryption.xml")?)?;
        // EPUB font obfuscation does not encrypt readable chapters.
        if encryption.descendants("EncryptionMethod").any(|element| {
            !matches!(
                element.attribute("Algorithm"),
                Some("http://www.idpf.org/2008/embedding" | "http://ns.adobe.com/pdf/enc#RC")
            )
        }) {
            return Err(ParseFailure::new(FailureKind::Encrypted));
        }
    }
    let mut book = EpubDoc::from_reader(Cursor::new(request.bytes))
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    if book.spine.len() > 10_000 {
        return Err(ParseFailure::limit("ebook_chapters"));
    }
    let title = book
        .mdata("title")
        .map(|item| item.value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_title(request));
    let author = book
        .mdata("creator")
        .map(|item| item.value.trim().to_owned());
    let language = book
        .mdata("language")
        .map(|item| item.value.trim().to_owned());
    let publisher = book
        .mdata("publisher")
        .map(|item| item.value.trim().to_owned());
    let mut output = Document {
        markdown: header(
            &title,
            author.as_deref(),
            language.as_deref(),
            publisher.as_deref(),
            "epub",
        ),
        ..Document::default()
    };
    output.metadata.insert("title".into(), title);
    let chapter_count = book.spine.len();
    for index in 0..chapter_count {
        request.check_cancelled()?;
        let id = book.spine[index].idref.clone();
        let part = book
            .resources
            .get(&id)
            .map(|resource| resource.path.to_string_lossy().replace('\\', "/"));
        let anchor = part.as_ref().map(|part| Anchor::PackagePart {
            part: part.clone(),
            element: None,
        });
        if !book.set_current_chapter(index) {
            output.coverage(
                anchor,
                CoverageStatus::Failed,
                CoverageReason::ChapterUnavailable,
            );
            continue;
        }
        let Some((bytes, mime)) = book.get_current() else {
            output.coverage(
                anchor,
                CoverageStatus::Failed,
                CoverageReason::ChapterUnavailable,
            );
            continue;
        };
        if !mime.contains("html") && !mime.contains("xml") {
            output.coverage(
                anchor,
                CoverageStatus::Missing,
                CoverageReason::TextUnavailable,
            );
            continue;
        }
        if bytes.len() > MAX_CHAPTER_BYTES {
            return Err(ParseFailure::limit("epub_chapter_bytes"));
        }
        let chapter_request = ParseRequest {
            bytes: &bytes,
            extension: "html",
            display_name: None,
            options: request.options,
            cancellation: request.cancellation,
        };
        let chapter = match crate::text::html(&chapter_request) {
            Ok(chapter) => chapter,
            Err(error) => {
                output.diagnostics.push(error);
                output.coverage(
                    anchor,
                    CoverageStatus::Failed,
                    CoverageReason::ChapterUnavailable,
                );
                continue;
            }
        };
        if chapter.blocks.is_empty() {
            output.coverage(
                anchor.clone(),
                CoverageStatus::Missing,
                CoverageReason::TextUnavailable,
            );
        }
        let path = part.unwrap_or_else(|| id.clone());
        if !chapter.markdown.trim().is_empty() {
            push_bounded(
                &mut output.markdown,
                &format!(
                    "\n\n## Chapter {} · {}\n\n{}",
                    index + 1,
                    safe_inline(&path, 240),
                    chapter.markdown.replace("\r\n", "\n").trim()
                ),
            )?;
        }
        let offset = output.blocks.len() as u32;
        for block in chapter.blocks {
            let block_id = output.push_block(
                block.parent.map(|parent| parent + offset),
                block.kind,
                block.text,
                anchor.clone(),
            );
            // DOM paths are scoped by their actual EPUB package part, not the outer ZIP bytes.
            for entry in chapter.source_map.iter().filter(|entry| matches!(entry.target, Target::Block { block_id: id, .. } if id == block.id)) {
                if let Anchor::Html { node_path, .. } = &entry.anchor {
                    output.source_map.push(SourceMapEntry { target: match entry.target { Target::Block { start, end, .. } => Target::Block { block_id, start, end }, _ => unreachable!() },
                        anchor: Anchor::PackagePart { part: path.clone(), element: node_path.clone() } });
                }
            }
        }
        output
            .coverage
            .entries
            .extend(chapter.coverage.entries.into_iter().map(|mut entry| {
                entry.anchor = anchor.clone();
                entry
            }));
        output.diagnostics.extend(chapter.diagnostics);
    }
    let mut resources = book
        .resources
        .iter()
        .filter(|(_, resource)| resource.mime.starts_with("image/"))
        .map(|(id, resource)| {
            (
                id.clone(),
                resource.path.to_string_lossy().replace('\\', "/"),
                resource.mime.clone(),
            )
        })
        .collect::<Vec<_>>();
    resources.sort_by(|left, right| left.1.cmp(&right.1));
    for (id, part, mime) in resources {
        request.check_cancelled()?;
        let anchor = Anchor::PackagePart {
            part,
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
        if let Some((bytes, _)) = book.get_resource(&id) {
            let dimensions = image::load_from_memory(&bytes)
                .ok()
                .map(|image| (image.width(), image.height()));
            let id = output.assets.len() as u32;
            output.assets.push(Asset {
                id,
                media_type: mime,
                sha256: digest(&bytes),
                bytes,
                width: dimensions.map(|value| value.0),
                height: dimensions.map(|value| value.1),
                derived_from: None,
            });
            output.source_map.push(SourceMapEntry {
                target: Target::Asset { asset_id: id },
                anchor,
            });
        } else {
            output.coverage(
                Some(anchor),
                CoverageStatus::Failed,
                CoverageReason::AssetDecodeFailed,
            );
        }
    }
    if output.blocks.is_empty() {
        output.coverage(
            None,
            CoverageStatus::Missing,
            CoverageReason::TextUnavailable,
        );
    }
    Ok(output)
}

fn mobi(request: &ParseRequest<'_>) -> Result<Document, ParseFailure> {
    let book = mobi::Mobi::from_read(request.bytes)
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    if book.encryption() != Encryption::No {
        return Err(ParseFailure::new(FailureKind::Encrypted));
    }
    if book.metadata.palmdoc.text_length as usize > MAX_TEXT_BYTES {
        return Err(ParseFailure::limit("ebook_declared_text_bytes"));
    }
    request.check_cancelled()?;
    let (raw, decoding_failure) = match book.content_as_string() {
        Ok(text) => (text, None),
        Err(error) => (
            book.content_as_string_lossy(),
            Some(ParseFailure::caused(FailureKind::Corrupt, error)),
        ),
    };
    if raw.len() > MAX_TEXT_BYTES {
        return Err(ParseFailure::limit("ebook_text_bytes"));
    }
    let inner = ParseRequest {
        bytes: raw.as_bytes(),
        extension: "html",
        display_name: None,
        options: request.options,
        cancellation: request.cancellation,
    };
    let mut output = if raw.contains('<') {
        crate::text::html(&inner)?
    } else {
        crate::text::plain(&inner, false)?
    };
    // Decompressed MOBI text offsets are not offsets into the original binary snapshot.
    output.source_map.clear();
    for block in &output.blocks {
        output.source_map.push(SourceMapEntry {
            target: Target::Block {
                block_id: block.id,
                start: 0,
                end: block.text.len() as u64,
            },
            anchor: Anchor::PackagePart {
                part: "mobi:text".into(),
                element: None,
            },
        });
    }
    if let Some(error) = decoding_failure {
        output.diagnostics.push(error);
        output.coverage(
            None,
            CoverageStatus::Fallback,
            CoverageReason::LossyTextDecoding,
        );
    }
    let title = book.title();
    let title = if title.trim().is_empty() {
        fallback_title(request)
    } else {
        title.trim().to_owned()
    };
    let text = output.markdown.replace("\r\n", "\n");
    output.markdown = header(
        &title,
        book.author().as_deref(),
        Some(&format!("{:?}", book.language())),
        book.publisher().as_deref(),
        "mobi",
    );
    push_bounded(&mut output.markdown, &format!("\n\n{}", text.trim()))?;
    output.metadata.insert("title".into(), title);
    if output.blocks.is_empty() {
        output.coverage(
            None,
            CoverageStatus::Missing,
            CoverageReason::TextUnavailable,
        );
    }
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::LocationUnavailable,
    );
    for record in book.image_records() {
        request.check_cancelled()?;
        let Ok(format) = image::guess_format(record.content) else {
            continue;
        };
        let anchor = Anchor::Text {
            start: record.record.offset as u64,
            end: record.record.offset as u64 + record.content.len() as u64,
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
        let dimensions = image::load_from_memory(record.content)
            .ok()
            .map(|image| (image.width(), image.height()));
        let id = output.assets.len() as u32;
        output.assets.push(Asset {
            id,
            media_type: format.to_mime_type().into(),
            bytes: record.content.to_vec(),
            sha256: digest(record.content),
            width: dimensions.map(|value| value.0),
            height: dimensions.map(|value| value.1),
            derived_from: None,
        });
        output.source_map.push(SourceMapEntry {
            target: Target::Asset { asset_id: id },
            anchor,
        });
    }
    output.coverage(
        None,
        CoverageStatus::Missing,
        CoverageReason::UpstreamRecoveryNotReported,
    );
    Ok(output)
}

fn fallback_title(request: &ParseRequest<'_>) -> String {
    request
        .display_name
        .and_then(|name| Path::new(name).file_stem())
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled ebook")
        .to_owned()
}

fn header(
    title: &str,
    author: Option<&str>,
    language: Option<&str>,
    publisher: Option<&str>,
    format: &str,
) -> String {
    let mut output = format!(
        "# {}\n\n## Book metadata\n\n- Format: {}\n",
        safe_inline(title, 500),
        format.to_uppercase()
    );
    for (name, value, limit) in [
        ("Author", author, 1_000),
        ("Language", language, 100),
        ("Publisher", publisher, 1_000),
    ] {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            output.push_str(&format!("- {name}: {}\n", safe_inline(value, limit)));
        }
    }
    output.push_str("\n## Contents");
    output
}

fn push_bounded(output: &mut String, value: &str) -> Result<(), ParseFailure> {
    if output.len().saturating_add(value.len()) > MAX_TEXT_BYTES {
        return Err(ParseFailure::limit("ebook_text_bytes"));
    }
    output.push_str(value);
    Ok(())
}

fn safe_inline(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(max_chars)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
