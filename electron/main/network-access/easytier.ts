import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { NetworkConfiguration } from '../../../src/types/desktop/network-access';
import { EasyTierProcess } from './easytier-process';
import { NativeNetworkControl } from './native-control';
import type { NetworkConnection, NetworkProvider } from './provider';
import { ensurePrivateDirectory } from '../../utils/private-file';

function executable(): string {
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'easytier')
    : join(process.cwd(), 'resources', 'bin', `${process.platform}-${process.arch}`, 'easytier');
  return join(directory, process.platform === 'win32' ? 'matcha-network.exe' : 'matcha-network');
}

async function available(): Promise<boolean> {
  try {
    const path = executable();
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('ET_') || key.toUpperCase() === 'RUST_LOG') delete env[key];
  }
  env.RUST_LOG = 'warn';
  return env;
}

function configuration(identity: string, config: NetworkConfiguration, secret: string, host: string): string {
  const text = JSON.stringify;
  return [
    `instance_id = ${text(identity)}`,
    'instance_name = "matcha-access"',
    `hostname = ${text(host)}`,
    'dhcp = false',
    `listeners = ${text(config.listeners)}`,
    'proxy_network = []',
    'port_forward = []',
    'ipv6_public_addr_provider = false',
    'ipv6_public_addr_auto = false',
    ...(config.stunServers === null ? [] : [`stun_servers = ${text(config.stunServers)}`]),
    ...(config.stunServersV6 === null ? [] : [`stun_servers_v6 = ${text(config.stunServersV6)}`]),
    ...config.peers.flatMap((peer) => ['[[peer]]', `uri = ${text(peer)}`]),
    '[network_identity]',
    `network_name = ${text(config.networkName)}`,
    `network_secret = ${text(secret)}`,
    '[flags]',
    `default_protocol = ${text(config.defaultProtocol)}`,
    `disable_p2p = ${!config.p2p}`,
    `disable_tcp_hole_punching = ${!config.tcpHolePunching}`,
    `disable_udp_hole_punching = ${!config.udpHolePunching}`,
    `disable_upnp = ${!config.upnp}`,
    `latency_first = ${config.latencyFirst}`,
    `private_mode = ${!config.foreignNetworkRelay}`,
    `relay_network_whitelist = ${text(config.relayNetworkWhitelist)}`,
    // Omit unlimited rates to retain the native u64::MAX default without JS rounding.
    ...(config.receiveLimitMbps > 0 ? [`instance_recv_bps_limit = ${config.receiveLimitMbps * 125000}`] : []),
    ...(config.foreignRelayLimitMbps > 0 ? [`foreign_relay_bps_limit = ${config.foreignRelayLimitMbps * 125000}`] : []),
    'bind_device = false',
    'no_tun = false',
    'enable_encryption = true',
    'encryption_algorithm = "aes-gcm"',
    'enable_exit_node = false',
    'enable_kcp_proxy = false',
    'disable_kcp_input = true',
    'enable_quic_proxy = false',
    'disable_quic_input = true',
    'disable_relay_data = true',
    '',
  ].join('\n');
}

export function createEasyTierProvider(): NetworkProvider {
  // Retain failed cleanup handles across starts; throwing must not orphan a child.
  const owned = new Set<EasyTierProcess>();
  let active: NetworkConnection | undefined;
  const closeProcess = async (child: EasyTierProcess) => { await child.close(); owned.delete(child); };
  const closeProcesses = async () => {
    const results = await Promise.allSettled([...owned].map(closeProcess));
    if (results.some((result) => result.status === 'rejected')) throw new Error('stop-failed');
  };
  return {
    id: 'easytier', name: 'EasyTier', available,
    async close() {
      if (active) await active.close();
      await closeProcesses();
    },
    async start(input): Promise<NetworkConnection> {
      if (active) throw new Error('conflict');
      await closeProcesses();
      if (!await available()) throw new Error('component-missing');
      await ensurePrivateDirectory(input.root);
      const child = new EasyTierProcess(executable(), input.root, environment());
      owned.add(child);
      const control = new NativeNetworkControl(child, input.receive);
      let closing: Promise<void> | undefined;
      let stopped = false;
      const closeChild = async () => {
        control.stop();
        try { await child.waitForExit(2000); } catch { /* Escalate only this owned process tree. */ }
        await closeProcess(child);
        control.dispose();
      };
      try {
        await child.started;
        await control.start(configuration(input.identity, input.config, input.secret, input.hostName));
        let resolveClosed!: () => void;
        let rejectClosed!: (error: Error) => void;
        const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
        void closed.catch(() => undefined);
        const connection: NetworkConnection = {
          closed,
          read: () => control.read(),
          exchange: (nodeId, request, signal) => control.exchange(nodeId, request, signal),
          close() {
            if (stopped) return Promise.resolve();
            closing ??= closeChild().then(() => {
              stopped = true; active = undefined; resolveClosed();
            }).catch(() => { closing = undefined; throw new Error('stop-failed'); });
            return closing;
          },
        };
        active = connection;
        void control.closed.then(() => connection.close()).catch(() => rejectClosed(new Error('stop-failed')));
        return connection;
      } catch (error) {
        await closeChild();
        throw error;
      }
    },
  };
}
