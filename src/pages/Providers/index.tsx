import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { MediaCapabilitiesPanel } from '@/components/settings/MediaCapabilitiesPanel';

export function ProvidersPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <MediaCapabilitiesPanel />
      <ProvidersSettings />
    </div>
  );
}
