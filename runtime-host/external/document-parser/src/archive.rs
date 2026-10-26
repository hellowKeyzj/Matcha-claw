use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use quick_xml::events::Event;

use crate::{FailureKind, ParseFailure};

pub(crate) type Archive<'a> = zip::ZipArchive<Cursor<&'a [u8]>>;

pub(crate) fn open(bytes: &[u8]) -> Result<Archive<'_>, ParseFailure> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    if archive.len() > 10_000 {
        return Err(ParseFailure::limit("archive_entries"));
    }
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
        if entry.encrypted() {
            return Err(ParseFailure::new(FailureKind::Encrypted));
        }
        if entry.enclosed_name().is_none() {
            return Err(ParseFailure::new(FailureKind::Corrupt));
        }
        expanded = expanded.saturating_add(entry.size());
        if entry.size() > 64 * 1024 * 1024 {
            return Err(ParseFailure::limit("archive_entry_bytes"));
        }
        if expanded > 512 * 1024 * 1024 {
            return Err(ParseFailure::limit("archive_expanded_bytes"));
        }
        if entry.size() > 1024 * 1024
            && entry.compressed_size() > 0
            && entry.size() / entry.compressed_size() > 200
        {
            return Err(ParseFailure::limit("archive_compression_ratio"));
        }
    }
    Ok(archive)
}

pub(crate) fn resolve_part(source: &str, target: &str) -> Option<String> {
    if target.contains(':') || target.contains('\\') {
        return None;
    }
    let mut components = if target.starts_with('/') {
        Vec::new()
    } else {
        source
            .rsplit_once('/')
            .map(|(directory, _)| directory.split('/').collect())
            .unwrap_or_default()
    };
    for component in target.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop()?;
            }
            component => components.push(component),
        }
    }
    Some(components.join("/"))
}

pub(crate) fn read(archive: &mut Archive<'_>, name: &str) -> Result<Vec<u8>, ParseFailure> {
    let mut entry = archive
        .by_name(name)
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
    Ok(bytes)
}

#[derive(Default)]
pub(crate) struct Element {
    pub name: String,
    pub attributes: BTreeMap<String, String>,
    pub text: String,
    pub children: Vec<Element>,
}

impl Element {
    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes.get(name).map(String::as_str)
    }
    pub fn child(&self, name: &str) -> Option<&Self> {
        self.children.iter().find(|child| child.name == name)
    }
    pub fn descendants<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> {
        let mut pending = vec![self];
        std::iter::from_fn(move || {
            while let Some(element) = pending.pop() {
                pending.extend(element.children.iter().rev());
                if element.name == name {
                    return Some(element);
                }
            }
            None
        })
    }
    pub fn text_content(&self) -> String {
        self.text.clone()
    }
}

pub(crate) fn xml(bytes: &[u8]) -> Result<Element, ParseFailure> {
    let mut reader = quick_xml::Reader::from_reader(bytes);
    reader.config_mut().expand_empty_elements = true;
    let mut version = quick_xml::XmlVersion::Implicit1_0;
    let mut stack = vec![Element::default()];
    let mut nodes = 0_usize;
    loop {
        match reader
            .read_event()
            .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?
        {
            Event::Decl(declaration) => {
                version = declaration
                    .xml_version()
                    .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
            }
            Event::Start(start) => {
                nodes += 1;
                if nodes > 1_000_000 {
                    return Err(ParseFailure::limit("xml_nodes"));
                }
                if stack.len() > 128 {
                    return Err(ParseFailure::limit("xml_depth"));
                }
                let mut element = Element {
                    name: String::from_utf8_lossy(start.local_name().as_ref()).into_owned(),
                    ..Element::default()
                };
                for attribute in start.attributes() {
                    let attribute = attribute
                        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
                    let name =
                        String::from_utf8_lossy(attribute.key.local_name().as_ref()).into_owned();
                    let value = attribute
                        .decoded_and_normalized_value(version, reader.decoder())
                        .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
                    element.attributes.insert(name, value.into_owned());
                }
                stack.push(element);
            }
            Event::End(_) => {
                if stack.len() <= 1 {
                    return Err(ParseFailure::new(FailureKind::Corrupt));
                }
                let element = stack.pop().unwrap();
                let parent = stack.last_mut().unwrap();
                parent.text.push_str(&element.text);
                parent.children.push(element);
            }
            Event::Text(text) => {
                let decoded = text
                    .xml_content(version)
                    .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
                stack.last_mut().unwrap().text.push_str(&decoded);
            }
            Event::GeneralRef(reference) => {
                let name = reference
                    .decode()
                    .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
                let entity = format!("&{name};");
                let decoded = quick_xml::escape::unescape(&entity)
                    .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
                stack.last_mut().unwrap().text.push_str(&decoded);
            }
            Event::CData(text) => {
                let decoded = text
                    .decode()
                    .map_err(|error| ParseFailure::caused(FailureKind::Corrupt, error))?;
                stack.last_mut().unwrap().text.push_str(&decoded);
            }
            Event::DocType(_) => return Err(ParseFailure::new(FailureKind::Unsupported)),
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err(ParseFailure::new(FailureKind::Corrupt));
    }
    Ok(stack.pop().unwrap())
}
