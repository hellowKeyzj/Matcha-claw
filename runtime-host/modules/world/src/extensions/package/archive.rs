use std::collections::BTreeMap;

use super::path::{PathIndex, PathIssue};

pub(super) struct ArchiveLimits {
    pub transport_bytes: u64,
    pub entries: usize,
    pub file_bytes: u64,
    pub expanded_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ArchiveIssue {
    Malformed,
    Unsupported,
    Encrypted,
    Path {
        index: usize,
        issue: PathIssue,
    },
    Link {
        index: usize,
    },
    Limit {
        index: Option<usize>,
        actual: u64,
        maximum: u64,
    },
}

pub(super) struct Entry {
    pub path: String,
    pub directory: bool,
    pub bytes: u64,
    pub compressed_bytes: u64,
    pub header_offset: u64,
    pub data_offset: u64,
    pub crc32: u32,
    flags: u16,
}

// zip 2.4 indexes central entries by filename and silently replaces duplicates.
// Inspect the original records before handing bounded payload decoding to zip.
pub(super) fn inspect(bytes: &[u8], limits: &ArchiveLimits) -> Result<Vec<Entry>, ArchiveIssue> {
    limit(bytes.len() as u64, limits.transport_bytes, None)?;
    let directory = directory(bytes)?;
    limit(directory.count, limits.entries as u64, None)?;
    let mut cursor = directory.start;
    let mut paths = PathIndex::default();
    let mut entries = Vec::with_capacity(directory.count as usize);
    let mut expanded = 0u64;
    for index in 0..directory.count as usize {
        let header = section(bytes, cursor, 46)?;
        if u32_at(header, 0)? != 0x02014b50 {
            return Err(ArchiveIssue::Malformed);
        }
        let flags = u16_at(header, 8)?;
        let compression = u16_at(header, 10)?;
        if flags & 0x0041 != 0 {
            return Err(ArchiveIssue::Encrypted);
        }
        if flags & !0x080e != 0 || !matches!(compression, 0 | 8) {
            return Err(ArchiveIssue::Unsupported);
        }
        let name_bytes = u16_at(header, 28)? as u64;
        let extra_bytes = u16_at(header, 30)? as u64;
        let comment_bytes = u16_at(header, 32)? as u64;
        let name = section(bytes, cursor + 46, name_bytes)?;
        let path = std::str::from_utf8(name).map_err(|_| ArchiveIssue::Path {
            index,
            issue: PathIssue::Invalid,
        })?;
        if !name.is_ascii() && flags & 0x0800 == 0 {
            return Err(ArchiveIssue::Path {
                index,
                issue: PathIssue::Invalid,
            });
        }
        let is_directory = path.ends_with('/');
        paths
            .insert(path, is_directory)
            .map_err(|issue| ArchiveIssue::Path { index, issue })?;
        let attributes = u32_at(header, 38)?;
        let mode = attributes >> 16;
        let kind = mode & 0o170000;
        if !matches!(kind, 0 | 0o040000 | 0o100000)
            || attributes & 0x0400 != 0
            || (kind == 0o040000 && !is_directory)
            || (kind == 0o100000 && is_directory)
        {
            return Err(ArchiveIssue::Link { index });
        }
        let extra = section(bytes, cursor + 46 + name_bytes, extra_bytes)?;
        let mut sizes = [
            u32_at(header, 24)? as u64,
            u32_at(header, 20)? as u64,
            u32_at(header, 42)? as u64,
        ];
        parse_extra(extra, name, &mut sizes, index)?;
        if u16_at(header, 34)? != 0 {
            return Err(ArchiveIssue::Unsupported);
        }
        limit(sizes[0], limits.file_bytes, Some(index))?;
        expanded = expanded
            .checked_add(sizes[0])
            .ok_or(ArchiveIssue::Malformed)?;
        limit(expanded, limits.expanded_bytes, Some(index))?;
        if is_directory && sizes[0] != 0 {
            return Err(ArchiveIssue::Malformed);
        }
        let local = section(bytes, sizes[2], 30)?;
        if u32_at(local, 0)? != 0x04034b50
            || u16_at(local, 6)? != flags
            || u16_at(local, 8)? != compression
            || u16_at(local, 26)? as u64 != name_bytes
        {
            return Err(ArchiveIssue::Malformed);
        }
        let local_extra_bytes = u16_at(local, 28)? as u64;
        if section(bytes, sizes[2] + 30, name_bytes)? != name {
            return Err(ArchiveIssue::Path {
                index,
                issue: PathIssue::Invalid,
            });
        }
        let mut local_sizes = [u32_at(local, 22)? as u64, u32_at(local, 18)? as u64, 0];
        parse_extra(
            section(bytes, sizes[2] + 30 + name_bytes, local_extra_bytes)?,
            name,
            &mut local_sizes,
            index,
        )?;
        if flags & 8 == 0
            && (sizes[..2] != local_sizes[..2] || u32_at(local, 14)? != u32_at(header, 16)?)
        {
            return Err(ArchiveIssue::Malformed);
        }
        let data_offset = sizes[2]
            .checked_add(30 + name_bytes + local_extra_bytes)
            .ok_or(ArchiveIssue::Malformed)?;
        section(bytes, data_offset, sizes[1])?;
        entries.push(Entry {
            path: path.to_owned(),
            directory: is_directory,
            bytes: sizes[0],
            compressed_bytes: sizes[1],
            header_offset: sizes[2],
            data_offset,
            crc32: u32_at(header, 16)?,
            flags,
        });
        cursor = cursor
            .checked_add(46 + name_bytes + extra_bytes + comment_bytes)
            .ok_or(ArchiveIssue::Malformed)?;
        if cursor > directory.end {
            return Err(ArchiveIssue::Malformed);
        }
    }
    if cursor != directory.end || entries.is_empty() {
        return Err(ArchiveIssue::Malformed);
    }
    let mut offsets = BTreeMap::new();
    for entry in &entries {
        if offsets.insert(entry.header_offset, entry).is_some() {
            return Err(ArchiveIssue::Malformed);
        }
    }
    let mut expected_offset = 0;
    let mut ordered = offsets.values().peekable();
    while let Some(entry) = ordered.next() {
        if entry.header_offset != expected_offset {
            return Err(ArchiveIssue::Malformed);
        }
        let next = ordered
            .peek()
            .map_or(directory.start, |entry| entry.header_offset);
        expected_offset = entry
            .data_offset
            .checked_add(entry.compressed_bytes)
            .ok_or(ArchiveIssue::Malformed)?;
        if entry.flags & 8 != 0 {
            descriptor(bytes, expected_offset, next, entry)?;
            expected_offset = next;
        }
        if expected_offset != next {
            return Err(ArchiveIssue::Malformed);
        }
    }
    if expected_offset != directory.start {
        return Err(ArchiveIssue::Malformed);
    }
    Ok(entries)
}

struct Directory {
    start: u64,
    end: u64,
    count: u64,
}

fn directory(bytes: &[u8]) -> Result<Directory, ArchiveIssue> {
    let end = bytes.len().checked_sub(22).ok_or(ArchiveIssue::Malformed)?;
    let lower = end.saturating_sub(u16::MAX as usize);
    let offset = (lower..=end)
        .rev()
        .find(|offset| {
            bytes.get(*offset..*offset + 4) == Some(&[0x50, 0x4b, 0x05, 0x06])
                && u16_at(bytes, *offset + 20)
                    .is_ok_and(|length| *offset + 22 + length as usize == bytes.len())
        })
        .ok_or(ArchiveIssue::Malformed)?;
    let header = section(bytes, offset as u64, 22)?;
    if u16_at(header, 4)? != 0
        || u16_at(header, 6)? != 0
        || u16_at(header, 8)? != u16_at(header, 10)?
    {
        return Err(ArchiveIssue::Unsupported);
    }
    let mut count = u16_at(header, 10)? as u64;
    let mut size = u32_at(header, 12)? as u64;
    let mut start = u32_at(header, 16)? as u64;
    let mut expected_end = offset as u64;
    if offset >= 20 && u32_at(bytes, offset - 20)? == 0x07064b50 {
        let locator = section(bytes, offset as u64 - 20, 20)?;
        if u32_at(locator, 4)? != 0 || u32_at(locator, 16)? != 1 {
            return Err(ArchiveIssue::Unsupported);
        }
        let record_offset = u64_at(locator, 8)?;
        let record = section(bytes, record_offset, 56)?;
        if u32_at(record, 0)? != 0x06064b50
            || u64_at(record, 4)? < 44
            || record_offset
                .checked_add(12)
                .and_then(|offset| offset.checked_add(u64_at(record, 4).ok()?))
                != Some(offset as u64 - 20)
            || u32_at(record, 16)? != 0
            || u32_at(record, 20)? != 0
            || u64_at(record, 24)? != u64_at(record, 32)?
        {
            return Err(ArchiveIssue::Malformed);
        }
        count = u64_at(record, 32)?;
        size = u64_at(record, 40)?;
        start = u64_at(record, 48)?;
        expected_end = record_offset;
    }
    let end = start.checked_add(size).ok_or(ArchiveIssue::Malformed)?;
    if end != expected_end || count > size / 46 {
        return Err(ArchiveIssue::Malformed);
    }
    section(bytes, start, size)?;
    Ok(Directory { start, end, count })
}

fn parse_extra(
    extra: &[u8],
    name: &[u8],
    sizes: &mut [u64; 3],
    index: usize,
) -> Result<(), ArchiveIssue> {
    let mut cursor = 0;
    let mut zip64_seen = false;
    while cursor < extra.len() {
        let tag = u16_at(extra, cursor)?;
        let length = u16_at(extra, cursor + 2)? as usize;
        let payload = section(extra, cursor as u64 + 4, length as u64)?;
        match tag {
            1 => {
                if zip64_seen {
                    return Err(ArchiveIssue::Malformed);
                }
                zip64_seen = true;
                let mut position = 0;
                for size in sizes.iter_mut() {
                    if *size == u32::MAX as u64 {
                        *size = u64_at(payload, position)?;
                        position += 8;
                    }
                }
            }
            0x000d if payload.len() > 12 => return Err(ArchiveIssue::Link { index }),
            0x756e if payload.len() > 14 || (u16_at(payload, 4)? & 0o170000) == 0o120000 => {
                return Err(ArchiveIssue::Link { index });
            }
            0x7075 if payload.get(5..) != Some(name) => {
                return Err(ArchiveIssue::Path {
                    index,
                    issue: PathIssue::Invalid,
                });
            }
            _ => {}
        }
        cursor += 4 + length;
    }
    if sizes.iter().any(|size| *size == u32::MAX as u64) && !zip64_seen {
        return Err(ArchiveIssue::Malformed);
    }
    Ok(())
}

fn descriptor(bytes: &[u8], offset: u64, end: u64, entry: &Entry) -> Result<(), ArchiveIssue> {
    let length = end.checked_sub(offset).ok_or(ArchiveIssue::Malformed)?;
    let data = section(bytes, offset, length)?;
    let start = match length {
        12 | 20 => 0,
        16 | 24 if u32_at(data, 0)? == 0x08074b50 => 4,
        _ => return Err(ArchiveIssue::Malformed),
    };
    if u32_at(data, start)? != entry.crc32 {
        return Err(ArchiveIssue::Malformed);
    }
    let valid = if length - start as u64 == 12 {
        u32_at(data, start + 4)? as u64 == entry.compressed_bytes
            && u32_at(data, start + 8)? as u64 == entry.bytes
    } else {
        u64_at(data, start + 4)? == entry.compressed_bytes
            && u64_at(data, start + 12)? == entry.bytes
    };
    if valid {
        Ok(())
    } else {
        Err(ArchiveIssue::Malformed)
    }
}

fn section(bytes: &[u8], offset: u64, length: u64) -> Result<&[u8], ArchiveIssue> {
    let end = offset.checked_add(length).ok_or(ArchiveIssue::Malformed)?;
    let start = usize::try_from(offset).map_err(|_| ArchiveIssue::Malformed)?;
    let end = usize::try_from(end).map_err(|_| ArchiveIssue::Malformed)?;
    bytes.get(start..end).ok_or(ArchiveIssue::Malformed)
}
fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, ArchiveIssue> {
    Ok(u16::from_le_bytes(
        section(bytes, offset as u64, 2)?
            .try_into()
            .map_err(|_| ArchiveIssue::Malformed)?,
    ))
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, ArchiveIssue> {
    Ok(u32::from_le_bytes(
        section(bytes, offset as u64, 4)?
            .try_into()
            .map_err(|_| ArchiveIssue::Malformed)?,
    ))
}
fn u64_at(bytes: &[u8], offset: usize) -> Result<u64, ArchiveIssue> {
    Ok(u64::from_le_bytes(
        section(bytes, offset as u64, 8)?
            .try_into()
            .map_err(|_| ArchiveIssue::Malformed)?,
    ))
}
fn limit(actual: u64, maximum: u64, index: Option<usize>) -> Result<(), ArchiveIssue> {
    if actual > maximum {
        Err(ArchiveIssue::Limit {
            index,
            actual,
            maximum,
        })
    } else {
        Ok(())
    }
}
