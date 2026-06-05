import { useEffect, useState } from 'react';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { MediaCapabilitiesPanel } from '@/components/settings/MediaCapabilitiesPanel';
import { resolveSingleCapabilityRuntimeAddress } from '@/lib/host-api';
import { isGatewayOperational } from '@/lib/gateway-status';
import { useGatewayStore } from '@/stores/gateway';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';

const MODEL_PROVIDER_CAPABILITY_ID = 'model.provider';

export function ProvidersPage() {
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayOperational = isGatewayOperational(gatewayStatus);
  const [runtimeAddress, setRuntimeAddress] = useState<RuntimeAddress | null>(null);

  useEffect(() => {
    if (!gatewayOperational) {
      setRuntimeAddress(null);
      return;
    }
    let active = true;
    void resolveSingleCapabilityRuntimeAddress(MODEL_PROVIDER_CAPABILITY_ID)
      .then((address) => {
        if (active) {
          setRuntimeAddress(address);
        }
      })
      .catch(() => {
        if (active) {
          setRuntimeAddress(null);
        }
      });
    return () => {
      active = false;
    };
  }, [gatewayOperational]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <MediaCapabilitiesPanel runtimeAddress={runtimeAddress} />
      <ProvidersSettings runtimeAddress={runtimeAddress} />
    </div>
  );
}
