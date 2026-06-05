import { useEffect, useState } from 'react';
import { teamsBackgroundOrchestrator } from '@/features/teams/runtime/orchestrator';
import { isGatewayOperational } from '@/lib/gateway-status';
import { resolveSingleCapabilityRuntimeAddress } from '@/lib/host-api';
import { useGatewayStore } from '@/stores/gateway';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';

const TEAM_COORDINATION_CAPABILITY_ID = 'team.coordination';

export function TeamsRuntimeDaemon() {
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [teamRuntimeAddress, setTeamRuntimeAddress] = useState<RuntimeAddress | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isGatewayOperational(gatewayStatus)) {
      setTeamRuntimeAddress(null);
      return;
    }
    resolveSingleCapabilityRuntimeAddress(TEAM_COORDINATION_CAPABILITY_ID)
      .then((runtimeAddress) => {
        if (!cancelled) {
          setTeamRuntimeAddress(runtimeAddress);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('Failed to resolve team coordination runtime address:', error);
          setTeamRuntimeAddress(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [gatewayStatus]);

  useEffect(() => {
    if (!teamRuntimeAddress) {
      teamsBackgroundOrchestrator.stop();
      return;
    }
    teamsBackgroundOrchestrator.start(teamRuntimeAddress);
    return () => {
      teamsBackgroundOrchestrator.stop();
    };
  }, [teamRuntimeAddress]);

  return null;
}

export default TeamsRuntimeDaemon;

