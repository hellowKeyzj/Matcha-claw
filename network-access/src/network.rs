use crate::{
    protocol::{MAX_FRAME, Peer, Runtime},
    rpc::{Bridge, DOMAIN, Factory, ResourceHandler},
};
use async_trait::async_trait;
use easytier::{
    common::config::{ConfigLoader, TomlConfigLoader},
    instance::instance::Instance,
    peers::{PeerPacketFilter, peer_manager::PeerManager, rpc_service::PeerManagerRpcService},
    proto::{rpc_impl::RpcController, rpc_types::controller::Controller},
    tunnel::packet_def::{PacketType, ZCPacket},
};
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc, time::Duration};

pub struct Network {
    pub instance: Instance,
}

fn configuration(text: &str) -> Result<TomlConfigLoader, ()> {
    let source = TomlConfigLoader::new_from_str(text).map_err(|_| ())?;
    let config = TomlConfigLoader::default();
    config.set_id(source.get_id());
    config.set_hostname(Some(source.get_hostname()));
    config.set_inst_name(source.get_inst_name());
    config.set_network_identity(source.get_network_identity());
    config.set_listeners(source.get_listener_uris());
    config.set_peers(source.get_peers());
    config.set_stun_servers(source.get_stun_servers());
    config.set_stun_servers_v6(source.get_stun_servers_v6());

    let supplied = source.get_flags();
    let mut flags = config.get_flags();
    flags.default_protocol = supplied.default_protocol;
    flags.disable_p2p = supplied.disable_p2p;
    flags.disable_tcp_hole_punching = supplied.disable_tcp_hole_punching;
    flags.disable_udp_hole_punching = supplied.disable_udp_hole_punching;
    flags.disable_upnp = supplied.disable_upnp;
    flags.latency_first = supplied.latency_first;
    flags.private_mode = supplied.private_mode;
    flags.relay_network_whitelist = supplied.relay_network_whitelist;
    flags.instance_recv_bps_limit = supplied.instance_recv_bps_limit;
    flags.foreign_relay_bps_limit = supplied.foreign_relay_bps_limit;
    flags.bind_device = false;
    flags.no_tun = false;
    flags.enable_encryption = true;
    flags.encryption_algorithm = "aes-gcm".into();
    flags.disable_kcp_input = true;
    flags.disable_quic_input = true;
    flags.disable_relay_data = true;
    config.set_flags(flags);
    Ok(config)
}

struct DropNativeData;

#[async_trait]
impl PeerPacketFilter for DropNativeData {
    async fn try_process_packet_from_peer(&self, packet: ZCPacket) -> Option<ZCPacket> {
        let kind = packet.peer_manager_header()?.packet_type;
        let blocked = [
            PacketType::Data,
            PacketType::KcpSrc,
            PacketType::KcpDst,
            PacketType::QuicSrc,
            PacketType::QuicDst,
            PacketType::DataWithKcpSrcModified,
            PacketType::DataWithQuicSrcModified,
        ]
        .into_iter()
        .any(|value| value as u8 == kind);
        if blocked { None } else { Some(packet) }
    }
}

impl Network {
    pub async fn start(text: &str, bridge: Arc<Bridge>) -> Result<Self, ()> {
        let config = configuration(text)?;
        let expected = config.get_listener_uris();
        let mut instance = Instance::new(config);
        instance
            .get_peer_manager()
            .get_peer_rpc_mgr()
            .rpc_server()
            .registry()
            .register(ResourceHandler(bridge), DOMAIN);
        instance.run().await.map_err(|_| ())?;
        instance
            .get_peer_manager()
            .add_packet_process_pipeline(Box::new(DropNativeData))
            .await;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let actual = instance.get_global_ctx().get_running_listeners();
                if expected.iter().all(|listener| {
                    actual.iter().any(|running| {
                        listener.scheme() == running.scheme()
                            && listener.host_str() == running.host_str()
                            && (listener.port() == Some(0) || listener.port() == running.port())
                    })
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| ())?;
        Ok(Self { instance })
    }

    pub async fn runtime(&self) -> Runtime {
        let manager = self.instance.get_peer_manager();
        let own = self.instance.peer_id();
        let connected: BTreeSet<u32> = PeerManagerRpcService::list_peers(&manager)
            .await
            .into_iter()
            .filter(|peer| peer.peer_id != own && peer.conns.iter().any(|conn| !conn.is_closed))
            .map(|peer| peer.peer_id)
            .collect();
        let mut peers: Vec<Peer> = manager
            .list_routes()
            .await
            .into_iter()
            .filter(|route| route.peer_id != own)
            .map(|route| Peer {
                node_id: route.peer_id.to_string(),
                name: route.hostname,
            })
            .collect();
        peers.sort_by(|left, right| left.node_id.cmp(&right.node_id));
        peers.dedup_by(|left, right| left.node_id == right.node_id);
        Runtime {
            node_id: own.to_string(),
            listeners: self
                .instance
                .get_global_ctx()
                .get_running_listeners()
                .into_iter()
                .filter(|listener| listener.scheme() != "ring")
                .map(|listener| listener.to_string())
                .collect(),
            peer_count: connected.len(),
            peers,
        }
    }
}

pub async fn invoke(
    manager: Arc<PeerManager>,
    node_id: String,
    input: Vec<u8>,
) -> Result<Value, &'static str> {
    let remote = node_id
        .parse::<u32>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == node_id)
        .ok_or("invalid-request")?;
    if !manager
        .list_routes()
        .await
        .iter()
        .any(|route| route.peer_id == remote)
    {
        return Err("unavailable");
    }
    let rpc = manager.get_peer_rpc_mgr();
    let client = rpc
        .rpc_client()
        .scoped_client::<Factory>(rpc.my_peer_id(), remote, DOMAIN.into());
    let mut controller = RpcController::default();
    controller.set_timeout_ms(10_000);
    let bytes = tokio::time::timeout(
        Duration::from_secs(10),
        client.call_method(controller, 0, input.into()),
    )
    .await
    .map_err(|_| "outcome-unknown")?
    .map_err(|_| "outcome-unknown")?;
    if bytes.len() > MAX_FRAME {
        return Err("outcome-unknown");
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or("outcome-unknown")
}
