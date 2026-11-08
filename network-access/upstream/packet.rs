use prost::{Message as _, length_delimiter_len};
use std::sync::{Arc, LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{
    common::{PeerId, compressor::DefaultCompressor},
    proto::{
        common::{CompressionAlgoPb, RpcCompressionInfo, RpcDescriptor, RpcPacket},
        rpc_types::error::Error,
    },
    tunnel::packet_def::{CompressorAlgo, PacketType, TAIL_RESERVED_SIZE, ZCPacket, ZCPacketType},
};

use super::RpcTransactId;

// Budget the final UDP payload size on the wire for peer RPC over `udp://`.
// This includes EasyTier's UDP tunnel header, peer header, and reserved tail
// space for encryption/compression metadata, but excludes the outer IP header.
const RPC_PACKET_UDP_PAYLOAD_BUDGET: usize = 1300;

pub async fn compress_packet(
    accepted_compression_algo: CompressionAlgoPb,
    content: &[u8],
) -> Result<(Vec<u8>, CompressionAlgoPb), Error> {
    let compressor = DefaultCompressor::new();
    let algo = accepted_compression_algo
        .try_into()
        .unwrap_or(CompressorAlgo::None);
    let compressed = compressor.compress_raw(content, algo).await?;
    if compressed.len() >= content.len() {
        Ok((content.to_vec(), CompressionAlgoPb::None))
    } else {
        Ok((compressed, algo.try_into().unwrap()))
    }
}

// Matcha's pinned native build has no zstd feature. Preserve that contract:
// reject unsupported codecs before allocation and move uncompressed content.
pub async fn decompress_packet(
    compression_algo: CompressionAlgoPb,
    content: Vec<u8>,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    if compression_algo != CompressionAlgoPb::None || content.len() > limit {
        return Err(invalid_packet());
    }
    Ok(content)
}

// OSPF sends full route/connection bitmap/foreign-network snapshots, not 64 KiB
// resource JSON. Retain upstream's 32768 fragments and its 1300-byte send budget.
const MAX_PIECES: usize = 32 * 1024;
pub const MAX_RPC_PACKET_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = MAX_PIECES * RPC_PACKET_UDP_PAYLOAD_BUDGET;
const RESOURCE_REQUEST_BYTES: usize = 64 * 1024;
const RESOURCE_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const ENVELOPE_BYTES: usize = 16;
const RECEIVE_MEMORY_BYTES: usize = 512 * 1024 * 1024;
// Resource/built-in, request/response each keep 64 slots. The shared byte budget
// covers all four lanes, including retained metadata and decode/response copies.
static SLOTS: LazyLock<[Arc<Semaphore>; 4]> =
    LazyLock::new(|| std::array::from_fn(|_| Arc::new(Semaphore::new(64))));
static MEMORY: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(RECEIVE_MEMORY_BYTES)));

fn invalid_packet() -> Error {
    Error::MalformatRpcPacket("RPC receive budget or packet invariant exceeded".to_owned())
}

fn is_resource(desc: &RpcDescriptor) -> bool {
    desc.domain_name == "matcha.resource.v1"
}

fn descriptor_wire_len(desc: &RpcDescriptor) -> usize {
    let len = desc.encoded_len();
    1 + length_delimiter_len(len) + len
}

fn validate_descriptor(desc: &RpcDescriptor) -> Result<(), Error> {
    // Even a one-byte body must fit beside the descriptor, before any clones.
    if descriptor_wire_len(desc) + 3 > max_rpc_packet_encoded_len_for_udp() {
        return Err(invalid_packet());
    }
    Ok(())
}

pub fn message_limit(desc: &RpcDescriptor, is_request: bool) -> usize {
    if is_resource(desc) {
        (if is_request {
            RESOURCE_REQUEST_BYTES
        } else {
            RESOURCE_RESPONSE_BYTES
        }) + ENVELOPE_BYTES
    } else {
        MAX_MESSAGE_BYTES
    }
}

#[derive(Debug)]
pub struct RpcReceiveBudget {
    slot: OwnedSemaphorePermit,
    memory: OwnedSemaphorePermit,
    resource: bool,
    is_request: bool,
}

impl RpcReceiveBudget {
    fn new(desc: Option<&RpcDescriptor>, is_request: bool) -> Result<Self, Error> {
        if let Some(desc) = desc {
            validate_descriptor(desc)?;
        }
        let resource = desc.is_some_and(is_resource);
        let slot = SLOTS[usize::from(resource) * 2 + usize::from(is_request)]
            .clone()
            .try_acquire_owned()
            .map_err(|_| invalid_packet())?;
        // Fixed task/map/channel bookkeeping; fragment and header heaps are
        // charged separately before retention/cloning below.
        let memory = MEMORY
            .clone()
            .try_acquire_many_owned(4096)
            .map_err(|_| invalid_packet())?;
        Ok(Self {
            slot,
            memory,
            resource,
            is_request,
        })
    }

    pub fn reserve(&mut self, bytes: usize) -> Result<(), Error> {
        let amount = u32::try_from(bytes).map_err(|_| invalid_packet())?;
        self.memory.merge(
            MEMORY
                .clone()
                .try_acquire_many_owned(amount)
                .map_err(|_| invalid_packet())?,
        );
        Ok(())
    }

    fn identify(&mut self, desc: &RpcDescriptor) -> Result<(), Error> {
        if is_resource(desc) && !self.resource {
            let slot = SLOTS[2 + usize::from(self.is_request)]
                .clone()
                .try_acquire_owned()
                .map_err(|_| invalid_packet())?;
            self.slot = slot;
            self.resource = true;
        }
        Ok(())
    }
}

// Keep each existing error kind and ordinary diagnostic text, but bound debug
// formatting itself: formatting first and truncating afterwards is too late.
pub fn rpc_error(
    err: &Error,
    budget: &mut RpcReceiveBudget,
) -> Result<crate::proto::error::Error, Error> {
    use crate::proto::error::{self, error::ErrorKind};
    use std::fmt::{self, Write as _};

    const TEXT_BYTES: usize = 4096;
    struct Text(String);
    impl fmt::Write for Text {
        fn write_str(&mut self, value: &str) -> fmt::Result {
            let remaining = TEXT_BYTES - self.0.len();
            let mut end = value.len().min(remaining);
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            self.0.push_str(&value[..end]);
            if end != value.len() {
                Err(fmt::Error)
            } else {
                Ok(())
            }
        }
    }
    budget.reserve(TEXT_BYTES)?;
    let mut text = Text(String::with_capacity(TEXT_BYTES));
    let kind = match err {
        Error::ExecutionError(value) => {
            let _ = write!(text, "{value:?}");
            ErrorKind::ExecuteError(error::ExecuteError {
                error_message: text.0,
            })
        }
        Error::DecodeError(_) => ErrorKind::ProstDecodeError(error::ProstDecodeError {}),
        Error::EncodeError(_) => ErrorKind::ProstEncodeError(error::ProstEncodeError {}),
        Error::InvalidMethodIndex(index, value) => {
            let _ = write!(text, "{value:?}");
            ErrorKind::InvalidMethodIndex(error::InvalidMethodIndex {
                method_index: *index as u32,
                service_name: text.0,
            })
        }
        Error::InvalidServiceKey(value, _) => {
            let _ = write!(text, "{value:?}");
            ErrorKind::InvalidService(error::InvalidService {
                service_name: text.0,
            })
        }
        Error::MalformatRpcPacket(value) => {
            let _ = write!(text, "{value:?}");
            ErrorKind::MalformatRpcPacket(error::MalformatRpcPacket {
                error_message: text.0,
            })
        }
        Error::Timeout(value) => {
            let _ = write!(text, "{value:?}");
            ErrorKind::Timeout(error::Timeout {
                error_message: text.0,
            })
        }
        value => {
            let _ = write!(text, "{value:?}");
            ErrorKind::OtherError(error::OtherError {
                error_message: text.0,
            })
        }
    };
    Ok(error::Error {
        error_kind: Some(kind),
    })
}

pub struct PacketMerger {
    header: Option<RpcPacket>,
    pieces: Vec<RpcPacket>,
    received: usize,
    body_bytes: usize,
    limit: usize,
    complete: bool,
    pub budget: RpcReceiveBudget,
    last_updated: std::time::Instant,
}

impl PacketMerger {
    pub fn new(desc: Option<&RpcDescriptor>, is_request: bool) -> Result<Self, Error> {
        Ok(Self {
            header: None,
            pieces: Vec::new(),
            received: 0,
            body_bytes: 0,
            limit: desc.map_or(MAX_MESSAGE_BYTES, |desc| message_limit(desc, is_request)),
            complete: false,
            budget: RpcReceiveBudget::new(desc, is_request)?,
            last_updated: std::time::Instant::now(),
        })
    }

    pub fn feed(&mut self, mut packet: RpcPacket) -> Result<Option<RpcPacket>, Error> {
        // Legacy unfragmented (0,0) uses the same validation and reservation.
        let total = if packet.total_pieces == 0 && packet.piece_idx == 0 {
            1
        } else {
            packet.total_pieces as usize
        };
        let index = packet.piece_idx as usize;
        if self.complete
            || total == 0
            || total > MAX_PIECES
            || index >= total
            || packet.is_request != self.budget.is_request
            || (index == 0 && packet.descriptor.is_none())
            || packet.encoded_len() > MAX_RPC_PACKET_BYTES
            || (index != 0 && packet.compression_info.is_some())
            || packet
                .compression_info
                .is_some_and(|info| info.algo != CompressionAlgoPb::None as i32)
        {
            return Err(invalid_packet());
        }
        if let Some(header) = &self.header {
            if header.from_peer != packet.from_peer
                || header.to_peer != packet.to_peer
                || header.transaction_id != packet.transaction_id
                || header.trace_id != packet.trace_id
                || self.pieces.len() != total
                || (header.descriptor.is_some()
                    && packet.descriptor.is_some()
                    && header.descriptor != packet.descriptor)
            {
                return Err(invalid_packet());
            }
        }
        if let Some(desc) = &packet.descriptor {
            validate_descriptor(desc)?;
            self.budget.identify(desc)?;
            self.limit = self.limit.min(message_limit(desc, packet.is_request));
        }
        // Canonical sender emits nonempty fragments except for an empty single
        // message; metadata-only fragmentation cannot bypass message limits.
        if total > self.limit.max(1) || (total > 1 && packet.body.is_empty()) {
            return Err(invalid_packet());
        }
        if !self.pieces.is_empty() && self.pieces[index].total_pieces != 0 {
            return Err(invalid_packet());
        }
        let body_bytes = self
            .body_bytes
            .checked_add(packet.body.len())
            .ok_or_else(invalid_packet)?;
        if body_bytes > self.limit {
            return Err(invalid_packet());
        }
        let descriptor_bytes = packet.descriptor.as_ref().map_or(0, |desc| {
            desc.domain_name.capacity() + desc.proto_name.capacity() + desc.service_name.capacity()
        });
        let slots = if self.pieces.is_empty() {
            total * std::mem::size_of::<RpcPacket>()
        } else {
            0
        };
        // Charge actual fragment heap capacity and slot metadata before resize or
        // retention, then charge the contiguous output before allocating it.
        let header_bytes = if self
            .header
            .as_ref()
            .is_none_or(|header| header.descriptor.is_none())
        {
            descriptor_bytes
        } else {
            0
        };
        self.budget
            .reserve(slots + packet.body.capacity() + descriptor_bytes + header_bytes)?;
        if self.header.is_none() {
            let body = std::mem::take(&mut packet.body);
            self.header = Some(packet.clone());
            packet.body = body;
            self.pieces = Vec::with_capacity(total);
            self.pieces.resize_with(total, Default::default);
        } else if self.header.as_ref().unwrap().descriptor.is_none() {
            self.header.as_mut().unwrap().descriptor = packet.descriptor.clone();
        }
        packet.total_pieces = total as u32;
        self.pieces[index] = packet;
        self.received += 1;
        self.body_bytes = body_bytes;
        self.last_updated = std::time::Instant::now();
        if self.received != total {
            return Ok(None);
        }
        self.budget.reserve(body_bytes)?;
        let mut body = Vec::with_capacity(body_bytes);
        let mut header = self.header.take().unwrap();
        // Fragment zero owns the complete descriptor/compression negotiation.
        header.descriptor = self.pieces[0].descriptor.take();
        header.compression_info = self.pieces[0].compression_info;
        for piece in std::mem::take(&mut self.pieces) {
            body.extend_from_slice(&piece.body);
        }
        header.body = body;
        header.total_pieces = 1;
        header.piece_idx = 0;
        self.complete = true;
        Ok(Some(header))
    }

    pub fn last_updated(&self) -> std::time::Instant {
        self.last_updated
    }
}

pub struct BuildRpcPacketArgs<'a> {
    pub from_peer: PeerId,
    pub to_peer: PeerId,
    pub rpc_desc: RpcDescriptor,
    pub transaction_id: RpcTransactId,
    pub is_req: bool,
    pub content: &'a [u8],
    pub trace_id: i32,
    pub compression_info: RpcCompressionInfo,
}

// Fixed transport overhead for peer RPC carried by EasyTier's UDP tunnel:
//
//   UDP payload budget
//   +-------------------------------------------------------------------------+
//   | EasyTier UDP tunnel hdr | PeerManager hdr | RpcPacket bytes | tail room |
//   +-------------------------------------------------------------------------+
//   |<------ ZCPacketType::UDP payload_offset ------>|<-- TAIL_RESERVED_SIZE -->|
//
// `udp_rpc_tunnel_overhead()` is everything except `RpcPacket bytes`.
fn udp_rpc_tunnel_overhead() -> usize {
    ZCPacketType::UDP.get_packet_offsets().payload_offset + TAIL_RESERVED_SIZE
}

// Maximum encoded RpcPacket size we can admit before adding it to a UDP tunnel.
// This budget excludes the outer UDP/IP headers because the caller only controls
// the EasyTier payload carried inside the UDP datagram.
fn max_rpc_packet_encoded_len_for_udp() -> usize {
    RPC_PACKET_UDP_PAYLOAD_BUDGET.saturating_sub(udp_rpc_tunnel_overhead())
}

// Build one logical RpcPacket piece. This is reused both for the actual output
// packets and for sizing templates that estimate worst-case protobuf overhead.
fn build_rpc_piece(
    args: &BuildRpcPacketArgs<'_>,
    total_pieces: u32,
    piece_idx: u32,
    body: &[u8],
) -> RpcPacket {
    RpcPacket {
        from_peer: args.from_peer,
        to_peer: args.to_peer,
        descriptor: if piece_idx == 0
            || args.compression_info.algo == CompressionAlgoPb::None as i32
        {
            // old version must have descriptor on every piece
            Some(args.rpc_desc.clone())
        } else {
            None
        },
        is_request: args.is_req,
        total_pieces,
        piece_idx,
        transaction_id: args.transaction_id,
        body: body.to_vec(),
        trace_id: args.trace_id,
        compression_info: if piece_idx == 0 {
            Some(args.compression_info)
        } else {
            None
        },
    }
}

// Size metadata without cloning any remotely supplied descriptor strings.
fn rpc_piece_base_len(args: &BuildRpcPacketArgs<'_>, total: u32, index: u32) -> usize {
    let packet = RpcPacket {
        from_peer: args.from_peer,
        to_peer: args.to_peer,
        transaction_id: args.transaction_id,
        is_request: args.is_req,
        total_pieces: total,
        piece_idx: index,
        trace_id: args.trace_id,
        compression_info: (index == 0).then_some(args.compression_info),
        ..Default::default()
    };
    packet.encoded_len()
        + if index == 0 || args.compression_info.algo == CompressionAlgoPb::None as i32 {
            descriptor_wire_len(&args.rpc_desc)
        } else {
            0
        }
}

fn pick_piece_len_for_budget(base: usize, remaining: usize, max: usize) -> Result<usize, Error> {
    if base > max || (remaining != 0 && base + 3 > max) {
        return Err(invalid_packet());
    }
    if remaining == 0 {
        return Ok(0);
    }
    let available = max - base;
    Ok(remaining
        .min(available.saturating_sub(1 + length_delimiter_len(available)))
        .max(1))
}

// No slicing-plan allocation. Reject impossible metadata and excessive piece
// counts, then reserve all retained wire buffers and construction temporaries.
pub fn build_rpc_packet(
    args: BuildRpcPacketArgs<'_>,
    budget: &mut RpcReceiveBudget,
) -> Result<Vec<ZCPacket>, Error> {
    validate_descriptor(&args.rpc_desc)?;
    if args.content.len() > message_limit(&args.rpc_desc, args.is_req) {
        return Err(invalid_packet());
    }
    let max = max_rpc_packet_encoded_len_for_udp();
    let empty = args.content.is_empty();
    let first = pick_piece_len_for_budget(
        rpc_piece_base_len(&args, if empty { 1 } else { u32::MAX }, 0),
        args.content.len(),
        max,
    )?;
    let remaining = args.content.len() - first;
    let other = if remaining == 0 {
        1
    } else {
        pick_piece_len_for_budget(
            rpc_piece_base_len(&args, u32::MAX, u32::MAX),
            remaining,
            max,
        )?
    };
    let count = 1 + remaining.div_ceil(other);
    if count > MAX_PIECES {
        return Err(invalid_packet());
    }
    let per_packet = std::mem::size_of::<ZCPacket>()
        + ZCPacketType::NIC.get_packet_offsets().payload_offset
        + max
        + TAIL_RESERVED_SIZE;
    // Retained ZCPacket buffers + Vec slots, one descriptor/body clone and its
    // protobuf encoding. All are bounded before constructing the first packet.
    budget.reserve(count * per_packet + max * 3)?;
    let mut ret = Vec::with_capacity(count);
    let mut offset = 0;
    for index in 0..count {
        let len = (if index == 0 { first } else { other }).min(args.content.len() - offset);
        let cur_packet = build_rpc_piece(
            &args,
            count as u32,
            index as u32,
            &args.content[offset..offset + len],
        );
        offset += len;
        let mut buf = Vec::with_capacity(cur_packet.encoded_len());
        cur_packet.encode(&mut buf)?;
        let mut packet = ZCPacket::new_with_payload(&buf);
        let packet_type = if args.is_req {
            PacketType::RpcReq
        } else {
            PacketType::RpcResp
        };
        packet.fill_peer_manager_hdr(args.from_peer, args.to_peer, packet_type as u8);
        ret.push(packet);
    }
    Ok(ret)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_test_args<'a>(
        content: &'a [u8],
        compression_algo: CompressionAlgoPb,
    ) -> BuildRpcPacketArgs<'a> {
        BuildRpcPacketArgs {
            from_peer: 11,
            to_peer: 22,
            rpc_desc: RpcDescriptor {
                domain_name: "very-long-domain-name-for-rpc-packet-budget-check".repeat(2),
                proto_name: "extremely.verbose.proto.name.for.rpc.packet.tests".repeat(2),
                service_name: "LargeMetadataServiceForRpcPacketBudget".repeat(2),
                method_index: 7,
            },
            transaction_id: 33,
            is_req: true,
            content,
            trace_id: 44,
            compression_info: RpcCompressionInfo {
                algo: compression_algo.into(),
                accepted_algo: CompressionAlgoPb::Zstd.into(),
            },
        }
    }

    fn udp_packet_size_after_tail(packet: &ZCPacket) -> usize {
        ZCPacketType::UDP.get_packet_offsets().payload_offset
            + packet.payload_len()
            + TAIL_RESERVED_SIZE
    }

    #[test]
    fn build_rpc_packet_respects_udp_budget_with_large_metadata() {
        let content = vec![0x5a; 4096];
        let args = build_test_args(&content, CompressionAlgoPb::None);
        let mut budget = RpcReceiveBudget::new(Some(&args.rpc_desc), true).unwrap();
        let packets = build_rpc_packet(args, &mut budget).unwrap();

        assert!(packets.len() > 1);
        for packet in packets {
            assert!(
                udp_packet_size_after_tail(&packet) <= RPC_PACKET_UDP_PAYLOAD_BUDGET,
                "packet size {} exceeded budget {}",
                udp_packet_size_after_tail(&packet),
                RPC_PACKET_UDP_PAYLOAD_BUDGET
            );
        }
    }

    #[test]
    fn build_rpc_packet_respects_udp_budget_for_empty_payload() {
        let args = build_test_args(&[], CompressionAlgoPb::Zstd);
        let mut budget = RpcReceiveBudget::new(Some(&args.rpc_desc), true).unwrap();
        let packets = build_rpc_packet(args, &mut budget).unwrap();

        assert_eq!(1, packets.len());
        assert!(udp_packet_size_after_tail(&packets[0]) <= RPC_PACKET_UDP_PAYLOAD_BUDGET);
    }
}
