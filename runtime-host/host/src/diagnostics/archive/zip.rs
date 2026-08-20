//! Store-only ZIP container encoding for the diagnostics archive.

use super::{DiagnosticsArchiveError, bundle::ArchiveEntry};

const LOCAL_HEADER_SIGNATURE: u32 = 0x0403_4b50;
const CENTRAL_HEADER_SIGNATURE: u32 = 0x0201_4b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE: u32 = 0x0605_4b50;
const VERSION_DEFLATE: u16 = 20;
const METHOD_DEFLATE: u16 = 8;
const LOCAL_HEADER_LEN: usize = 30;
const CENTRAL_HEADER_LEN: usize = 46;
const END_OF_CENTRAL_DIRECTORY_LEN: usize = 22;
const STORED_BLOCK_HEADER_LEN: usize = 5;
const MAX_STORED_BLOCK: usize = u16::MAX as usize;

/// Encodes the collected entries into a single ZIP image held in memory.
///
/// Deflate is declared but only stored blocks are emitted: the archive is bounded by
/// [`super::ARCHIVE_BYTE_LIMIT`], so compression would trade CPU for no useful headroom while
/// forcing a third-party dependency into the Host.
pub(super) fn encode(entries: &[ArchiveEntry]) -> Result<Vec<u8>, DiagnosticsArchiveError> {
    let entry_count =
        u16::try_from(entries.len()).map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
    let mut image = Vec::with_capacity(encoded_len(entries));
    let mut central = Vec::with_capacity(central_directory_len(entries));

    for entry in entries {
        let name = entry.name.as_bytes();
        let name_len =
            u16::try_from(name.len()).map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        let uncompressed_len = u32::try_from(entry.content.len())
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        let compressed_len = u32::try_from(deflated_len(entry.content.len()))
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        let local_offset =
            u32::try_from(image.len()).map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        let checksum = crc32(&entry.content);

        push_local_header(
            &mut image,
            name_len,
            checksum,
            compressed_len,
            uncompressed_len,
        );
        image.extend_from_slice(name);
        push_stored_blocks(&mut image, &entry.content);

        push_central_header(
            &mut central,
            name,
            checksum,
            compressed_len,
            uncompressed_len,
            local_offset,
        );
    }

    let central_offset =
        u32::try_from(image.len()).map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
    let central_len =
        u32::try_from(central.len()).map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
    image.extend_from_slice(&central);
    push_end_of_central_directory(&mut image, entry_count, central_len, central_offset);
    Ok(image)
}

/// Stored-block output size is fully determined by the payload size, so the local header can carry
/// the true compressed length on the first write instead of being patched afterwards.
fn deflated_len(content_len: usize) -> usize {
    content_len + content_len.div_ceil(MAX_STORED_BLOCK).max(1) * STORED_BLOCK_HEADER_LEN
}

fn encoded_len(entries: &[ArchiveEntry]) -> usize {
    entries
        .iter()
        .map(|entry| LOCAL_HEADER_LEN + entry.name.len() + deflated_len(entry.content.len()))
        .sum::<usize>()
        + central_directory_len(entries)
        + END_OF_CENTRAL_DIRECTORY_LEN
}

fn central_directory_len(entries: &[ArchiveEntry]) -> usize {
    entries
        .iter()
        .map(|entry| CENTRAL_HEADER_LEN + entry.name.len())
        .sum()
}

fn push_local_header(
    image: &mut Vec<u8>,
    name_len: u16,
    checksum: u32,
    compressed_len: u32,
    uncompressed_len: u32,
) {
    push_u32(image, LOCAL_HEADER_SIGNATURE);
    push_u16(image, VERSION_DEFLATE);
    push_u16(image, 0);
    push_u16(image, METHOD_DEFLATE);
    push_u16(image, 0);
    push_u16(image, 0);
    push_u32(image, checksum);
    push_u32(image, compressed_len);
    push_u32(image, uncompressed_len);
    push_u16(image, name_len);
    push_u16(image, 0);
}

fn push_central_header(
    central: &mut Vec<u8>,
    name: &[u8],
    checksum: u32,
    compressed_len: u32,
    uncompressed_len: u32,
    local_offset: u32,
) {
    push_u32(central, CENTRAL_HEADER_SIGNATURE);
    push_u16(central, VERSION_DEFLATE);
    push_u16(central, VERSION_DEFLATE);
    push_u16(central, 0);
    push_u16(central, METHOD_DEFLATE);
    push_u16(central, 0);
    push_u16(central, 0);
    push_u32(central, checksum);
    push_u32(central, compressed_len);
    push_u32(central, uncompressed_len);
    push_u16(central, name.len() as u16);
    push_u16(central, 0);
    push_u16(central, 0);
    push_u16(central, 0);
    push_u16(central, 0);
    push_u32(central, 0);
    push_u32(central, local_offset);
    central.extend_from_slice(name);
}

fn push_end_of_central_directory(
    image: &mut Vec<u8>,
    entry_count: u16,
    central_len: u32,
    central_offset: u32,
) {
    push_u32(image, END_OF_CENTRAL_DIRECTORY_SIGNATURE);
    push_u16(image, 0);
    push_u16(image, 0);
    push_u16(image, entry_count);
    push_u16(image, entry_count);
    push_u32(image, central_len);
    push_u32(image, central_offset);
    push_u16(image, 0);
}

fn push_stored_blocks(image: &mut Vec<u8>, content: &[u8]) {
    let mut blocks = content.chunks(MAX_STORED_BLOCK).peekable();
    if blocks.peek().is_none() {
        push_stored_block(image, &[], true);
        return;
    }
    while let Some(block) = blocks.next() {
        push_stored_block(image, block, blocks.peek().is_none());
    }
}

fn push_stored_block(image: &mut Vec<u8>, block: &[u8], final_block: bool) {
    image.push(u8::from(final_block));
    let length = block.len() as u16;
    push_u16(image, length);
    push_u16(image, !length);
    image.extend_from_slice(block);
}

fn push_u16(image: &mut Vec<u8>, value: u16) {
    image.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(image: &mut Vec<u8>, value: u32) {
    image.extend_from_slice(&value.to_le_bytes());
}

fn crc32(content: &[u8]) -> u32 {
    let mut checksum = !0_u32;
    for byte in content {
        checksum ^= u32::from(*byte);
        for _ in 0..8 {
            checksum = if checksum & 1 == 0 {
                checksum >> 1
            } else {
                (checksum >> 1) ^ 0xedb8_8320
            };
        }
    }
    !checksum
}
