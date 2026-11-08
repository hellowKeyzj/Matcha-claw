// EasyTier v2.6.4, commit 8428a89d2dabc94c97d370ec607c6ca142473626.
// Exact pinned file hashes and edit contexts are checked by formal prepare.
export default [
  {
    path: 'proto/rpc_impl/packet.rs',
    inputSha256: 'e86f85597d3822da4dd4fe7d497fb36073aebf387b7a98a18a9930242fbf8940',
    outputSha256: 'b8516a42d0104039f98251b4ce1097a4e2f402e268938c1dc0557d2a44760575',
    replacement: 'packet.rs',
  },
  {
    path: 'proto/rpc_impl/server.rs',
    inputSha256: 'ed5e6d8fbf8239e4b158877248a818c85b25cff6d8669f912b71c3b19bd3b08d',
    outputSha256: 'af3ffaf18c059568c3da0f9f6d971d6e5f3b3ba631367514f2b95e434fcefeef',
    edits: [
      [
        '    packet::{PacketMerger, build_rpc_packet, compress_packet, decompress_packet},',
        '    packet::{MAX_RPC_PACKET_BYTES, PacketMerger, RpcReceiveBudget, build_rpc_packet, compress_packet, decompress_packet, message_limit, rpc_error},',
      ],
      [
        '                let packet = match common::RpcPacket::decode(packet.unwrap().payload()) {',
        `                let wire_packet = packet.unwrap();
                if wire_packet.payload().len() > MAX_RPC_PACKET_BYTES {
                    continue;
                }
                let packet = match common::RpcPacket::decode(wire_packet.payload()) {`,
      ],
      [
        '                let ret = packet_merges.entry(key.clone()).or_default().feed(packet);',
        `                // Complete packets and their budget leave the map under the
                // same entry guard; GC cannot release a completed task's lease.
                let ret = match packet_merges.entry(key.clone()) {
                    dashmap::mapref::entry::Entry::Occupied(mut entry) => {
                        match entry.get_mut().feed(packet) {
                            Ok(Some(packet)) => Ok(Some((packet, entry.remove().budget))),
                            Ok(None) => Ok(None),
                            Err(err) => {
                                entry.remove();
                                Err(err)
                            }
                        }
                    }
                    dashmap::mapref::entry::Entry::Vacant(entry) => {
                        let Ok(mut merger) = PacketMerger::new(packet.descriptor.as_ref(), true) else {
                            continue;
                        };
                        match merger.feed(packet) {
                            Ok(Some(packet)) => Ok(Some((packet, merger.budget))),
                            Ok(None) => {
                                entry.insert(merger);
                                Ok(None)
                            }
                            Err(err) => Err(err),
                        }
                    }
                };`,
      ],
      [
        '                    Ok(Some(packet)) => {\n                        packet_merges.remove(&key);',
        '                    Ok(Some((packet, budget))) => {',
      ],
      [
        '                            stats_manager.clone(),\n                        ));',
        '                            stats_manager.clone(),\n                            budget,\n                        ));',
      ],
      [
        '    ) -> Result<Bytes> {\n        let body = if let Some(compression_info) = packet.compression_info {',
        '    ) -> Result<Bytes> {\n        let limit = message_limit(packet.descriptor.as_ref().unwrap(), true);\n        let resource = packet.descriptor.as_ref().unwrap().domain_name == "matcha.resource.v1";\n        let body = if let Some(compression_info) = packet.compression_info {',
      ],
      ['                &packet.body,', '                packet.body,\n                limit,'],
      [
        '        let rpc_request = RpcRequest::decode(Bytes::from(body))?;',
        `        let rpc_request = RpcRequest::decode(Bytes::from(body))?;
        if resource && rpc_request.request.len() > 64 * 1024 {
            return Err(crate::proto::rpc_types::error::Error::MalformatRpcPacket("RPC request exceeds payload limit".into()));
        }`,
      ],
      [
        '        stats_manager: Option<Arc<StatsManager>>,\n    ) {',
        '        stats_manager: Option<Arc<StatsManager>>,\n        mut budget: RpcReceiveBudget,\n    ) {',
      ],
      [
        '        let desc = packet.descriptor.clone().unwrap();',
        `        let descriptor = packet.descriptor.as_ref().unwrap();
        let descriptor_bytes = descriptor.domain_name.capacity()
            + descriptor.proto_name.capacity() + descriptor.service_name.capacity();
        if budget.reserve(descriptor_bytes * 8 + 4096).is_err() {
            return;
        }
        let desc = descriptor.clone();`,
      ],
      [
        '        let compression_info = packet.compression_info;\n        let resp_bytes = Self::handle_rpc_request(packet, reg, tunnel_info).await;',
        `        let compression_info = packet.compression_info;
        let response_limit = message_limit(&desc, false);
        // Reserve the decode copy and one maximum handler response before
        // decoding; retain the lease through handler completion and response send.
        let resp_bytes = match budget.reserve(packet.body.len() + response_limit) {
            Ok(()) => Self::handle_rpc_request(packet, reg, tunnel_info).await,
            Err(err) => Err(err),
        };`,
      ],
      [
        '            Ok(r) => {\n                resp_msg.response = r.clone().into();',
        `            Ok(r) if r.len() <= response_limit => {
                if budget.reserve(r.len()).is_err() {
                    return;
                }
                resp_msg.response = r.clone().into();`,
      ],
      [
        '            Err(err) => {\n                resp_msg.error = Some(err.into());',
        `            Ok(_) => {
                let err = crate::proto::rpc_types::error::Error::MalformatRpcPacket("RPC response exceeds payload limit".into());
                let Ok(error) = rpc_error(&err, &mut budget) else { return; };
                resp_msg.error = Some(error);
            }
            Err(err) => {
                let Ok(error) = rpc_error(err, &mut budget) else { return; };
                resp_msg.error = Some(error);`,
      ],
      [
        '        let (compressed_resp, algo) = compress_packet(',
        `        // Both successful and error responses reserve protobuf encoding and
        // both temporary None-compression copies before encoding anything.
        if resp_msg.encoded_len() > response_limit
            || budget.reserve(resp_msg.encoded_len() * 3).is_err() {
            return;
        }
        let (compressed_resp, algo) = compress_packet(`,
      ],
      ['        let packets = build_rpc_packet(BuildRpcPacketArgs {', '        let Ok(packets) = build_rpc_packet(BuildRpcPacketArgs {'],
      [
        '        });\n        for packet in packets {',
        '        }, &mut budget) else { return; };\n        for packet in packets {',
      ],
    ],
  },
  {
    path: 'proto/rpc_impl/client.rs',
    inputSha256: '0a8fa1f24dba9af5e4bc8a13b570b0ae2ba53aef3c028f11220d11a1d759e8fb',
    outputSha256: '5883219c98b88dddb92a9810a85ec55f7bb4f089deb168d7a5bd2105d6e74934',
    edits: [
      ['use tokio::sync::mpsc;', 'use tokio::sync::oneshot;'],
      [
        '    BuildRpcPacketArgs, build_rpc_packet, compress_packet, decompress_packet,',
        '    BuildRpcPacketArgs, MAX_RPC_PACKET_BYTES, RpcReceiveBudget, build_rpc_packet, compress_packet, decompress_packet, message_limit,',
      ],
      [
        'type RpcPacketSender = mpsc::UnboundedSender<RpcPacket>;\ntype RpcPacketReceiver = mpsc::UnboundedReceiver<RpcPacket>;',
        'type RpcPacketSender = oneshot::Sender<(RpcPacket, RpcReceiveBudget)>;\ntype RpcPacketReceiver = oneshot::Receiver<(RpcPacket, RpcReceiveBudget)>;',
      ],
      [
        '    sender: RpcPacketSender,\n    merger: PacketMerger,',
        '    sender: Option<RpcPacketSender>,\n    merger: Option<PacketMerger>,',
      ],
      [
        '                let packet = match RpcPacket::decode(packet.unwrap().payload()) {',
        `                let wire_packet = packet.unwrap();
                if wire_packet.payload().len() > MAX_RPC_PACKET_BYTES {
                    continue;
                }
                let packet = match RpcPacket::decode(wire_packet.payload()) {`,
      ],
      [
        '                let ret = inflight_request.merger.feed(packet);',
        `                if inflight_request.sender.is_none() {
                    continue;
                }
                let Some(merger) = inflight_request.merger.as_mut() else {
                    continue;
                };
                let ret = merger.feed(packet);`,
      ],
      [
        '                        inflight_request.sender.send(rpc_packet).unwrap();',
        `                        let merger = inflight_request.merger.take().unwrap();
                        if let Some(sender) = inflight_request.sender.take() {
                            let _ = sender.send((rpc_packet, merger.budget));
                        }`,
      ],
      [
        '                        tracing::error!(?err, "Failed to feed packet to merger");',
        '                        inflight_request.sender.take();\n                        tracing::error!(?err, "Failed to feed packet to merger");',
      ],
      ['            ) -> Result<RpcPacket> {', '            ) -> Result<(RpcPacket, RpcReceiveBudget)> {'],
      ['                Ok(rx.recv().await.ok_or(TunnelError::Shutdown)?)', '                Ok(rx.await.map_err(|_| TunnelError::Shutdown)?)'],
      [
        '                let (tx, mut rx) = mpsc::unbounded_channel();',
        `                let desc = self.service_descriptor();
                let rpc_desc = RpcDescriptor {
                    domain_name: self.domain_name.clone(),
                    proto_name: desc.proto_name().to_string(),
                    service_name: desc.name().to_string(),
                    method_index: method.index() as u32,
                };
                let mut merger = PacketMerger::new(Some(&rpc_desc), false)?;
                let request_input = ctrl.get_raw_input().unwrap_or(input);
                let request_limit = message_limit(&rpc_desc, true);
                if request_input.len() > request_limit {
                    return Err(crate::proto::rpc_types::error::Error::MalformatRpcPacket("RPC request exceeds payload limit".into()));
                }
                // Input Vec conversion, protobuf encoding and both transient
                // None-compression copies share the response transaction lease.
                merger.budget.reserve((request_input.len() + 16) * 4)?;
                let (tx, mut rx) = oneshot::channel();`,
      ],
      ['                let desc = self.service_descriptor();\n                let labels = LabelSet::new()', '                let labels = LabelSet::new()'],
      [
        `                self.inflight_requests.insert(
                    key.clone(),
                    InflightRequest {
                        sender: tx,
                        merger: PacketMerger::new(),
                        start_time,
                    },
                );`,
        '',
      ],
      [
        `                    request: if let Some(raw_input) = ctrl.get_raw_input() {
                        raw_input.into()
                    } else {
                        input.into()
                    },`,
        '                    request: request_input.into(),',
      ],
      [
        `                let rpc_desc = RpcDescriptor {
                    domain_name: self.domain_name.clone(),
                    proto_name: desc.proto_name().to_string(),
                    service_name: desc.name().to_string(),
                    method_index: method.index() as u32,
                };

                let rpc_req`,
        '                let response_limit = message_limit(&rpc_desc, false);\n                let rpc_req',
      ],
      [
        '                });\n                let timeout_dur = std::time::Duration::from_millis(ctrl.timeout_ms() as u64);',
        `                }, &mut merger.budget)?;
                self.inflight_requests.insert(
                    key.clone(),
                    InflightRequest {
                        sender: Some(tx),
                        merger: Some(merger),
                        start_time,
                    },
                );
                let timeout_dur = std::time::Duration::from_millis(ctrl.timeout_ms() as u64);`,
      ],
      [
        '                let mut rpc_packet = timeout(timeout_dur, self.do_rpc(packets, &mut rx)).await??;',
        '                let (mut rpc_packet, mut budget) = timeout(timeout_dur, self.do_rpc(packets, &mut rx)).await??;\n                budget.reserve(rpc_packet.body.len())?;',
      ],
      [
        '                        decompress_packet(compression_info.algo(), &rpc_packet.body).await?;',
        '                        decompress_packet(compression_info.algo(), rpc_packet.body, response_limit).await?;',
      ],
      [
        '                let raw_output = Bytes::from(rpc_resp.response);',
        `                if self.domain_name == "matcha.resource.v1" && rpc_resp.response.len() > 2 * 1024 * 1024 {
                    return Err(crate::proto::rpc_types::error::Error::MalformatRpcPacket("RPC response exceeds payload limit".into()));
                }
                let raw_output = Bytes::from(rpc_resp.response);`,
      ],
    ],
  },
  {
    path: 'peers/peer_manager.rs',
    inputSha256: 'f4c0c808fea40f40e154636b05fdb479a7de68d6ff3d96975bdabd56cb3e6d2d',
    outputSha256: '2c4c1cd32207b5a84c035a3e1c3cbef66f3c21f09bbaea43ac82eb1053b1b8e2',
    edits: [
      ['mpsc::{self, UnboundedReceiver, UnboundedSender}', 'mpsc::{self, Receiver, Sender}'],
      [
        '    packet_recv: Mutex<UnboundedReceiver<ZCPacket>>,\n    peer_rpc_tspt_sender: UnboundedSender<ZCPacket>,',
        '    packet_recv: Mutex<Receiver<ZCPacket>>,\n    peer_rpc_tspt_sender: Sender<ZCPacket>,',
      ],
      ['let (peer_rpc_tspt_sender, peer_rpc_tspt_recv) = mpsc::unbounded_channel();', 'let (peer_rpc_tspt_sender, peer_rpc_tspt_recv) = mpsc::channel(128);'],
      ['            peer_rpc_tspt_sender: UnboundedSender<ZCPacket>,', '            peer_rpc_tspt_sender: Sender<ZCPacket>,'],
      [
        '                    self.peer_rpc_tspt_sender.send(packet).unwrap();',
        `                    // Never await under the pipeline read lock or stall other protocols.
                    if packet.payload().len() <= crate::proto::rpc_impl::packet::MAX_RPC_PACKET_BYTES {
                        let _ = self.peer_rpc_tspt_sender.try_send(packet);
                    }`,
      ],
    ],
  },
  {
    path: 'peers/foreign_network_manager.rs',
    inputSha256: '028ad2a23c77a781ce282d91fb6207a4366e24cf5a4e1f20677ce12c3ad9482a',
    outputSha256: 'e226ceb1c2c34dff8698e5bc5f5c13d953162469401d74dfc9f6ff2561a13d80',
    edits: [
      ['mpsc::{self, UnboundedReceiver, UnboundedSender}', 'mpsc::{self, Receiver, Sender}'],
      ['    rpc_sender: UnboundedSender<ZCPacket>,', '    rpc_sender: Sender<ZCPacket>,'],
      [') -> (Arc<PeerRpcManager>, UnboundedSender<ZCPacket>) {', ') -> (Arc<PeerRpcManager>, Sender<ZCPacket>) {'],
      ['            packet_recv: Mutex<UnboundedReceiver<ZCPacket>>,', '            packet_recv: Mutex<Receiver<ZCPacket>>,'],
      ['let (rpc_transport_sender, peer_rpc_tspt_recv) = mpsc::unbounded_channel();', 'let (rpc_transport_sender, peer_rpc_tspt_recv) = mpsc::channel(128);'],
      [
        '                        rpc_sender.send(zc_packet).unwrap();',
        `                        if zc_packet.payload().len() <= crate::proto::rpc_impl::packet::MAX_RPC_PACKET_BYTES {
                            let _ = rpc_sender.try_send(zc_packet);
                        }`,
      ],
    ],
  },
];
