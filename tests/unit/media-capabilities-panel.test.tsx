import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '@/i18n';
import { MediaCapabilitiesPanel } from '@/components/settings/MediaCapabilitiesPanel';
import type { CapabilityRouting } from '@/lib/capability-routing';
import type { ProviderModel } from '@/lib/provider-model-catalog';

const routingState = vi.hoisted(() => ({
  routing: {} as CapabilityRouting,
  ready: true,
  loading: false,
  saving: false,
  error: null as string | null,
  refresh: vi.fn().mockResolvedValue(undefined),
  setRoute: vi.fn().mockResolvedValue(undefined),
}));

const catalogState = vi.hoisted(() => ({
  models: [] as ProviderModel[],
  ready: true,
  loading: false,
  saving: false,
  error: null as string | null,
  refresh: vi.fn().mockResolvedValue(undefined),
  replaceCredentialModels: vi.fn().mockResolvedValue(undefined),
}));

const providerStoreState = vi.hoisted(() => ({
  providerSnapshot: {
    credentials: [
      { id: 'openai-main', vendorId: 'openai', label: 'OpenAI' },
      { id: 'ark-main', vendorId: 'ark', label: 'Ark' },
    ],
  },
}));

vi.mock('@/stores/capability-routing', () => ({
  useCapabilityRoutingStore: (selector: (state: typeof routingState) => unknown) => selector(routingState),
}));

vi.mock('@/stores/provider-model-catalog', () => ({
  useProviderModelCatalogStore: (selector: (state: typeof catalogState) => unknown) => selector(catalogState),
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: (selector: (state: typeof providerStoreState) => unknown) => selector(providerStoreState),
}));

describe('media capabilities panel', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    routingState.routing = {};
    routingState.ready = true;
    routingState.loading = false;
    routingState.saving = false;
    routingState.error = null;
    catalogState.models = [
      { credentialId: 'openai-main', modelId: 'gpt-5.5', capabilities: ['chat'] },
      { credentialId: 'ark-main', modelId: 'ark-code-latest', capabilities: ['chat'] },
      { credentialId: 'ark-main', modelId: 'seedream', capabilities: ['imageGenerate'] },
      { credentialId: 'openai-main', modelId: 'tts-1', capabilities: ['tts'] },
    ];
    catalogState.ready = true;
    catalogState.loading = false;
    vi.clearAllMocks();
    routingState.refresh.mockResolvedValue(undefined);
    routingState.setRoute.mockResolvedValue(undefined);
    catalogState.refresh.mockResolvedValue(undefined);
  });

  it('saves capability routes using credential-scoped model refs', async () => {
    render(<MediaCapabilitiesPanel />);

    expect(screen.getByRole('button', { name: 'Default Models' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Default Models' }));

    fireEvent.change(screen.getByLabelText('Primary model (credential/model)', { selector: '#capability-chat-primary' }), {
      target: { value: 'openai-main/gpt-5.5' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Advanced' })[0]!);
    fireEvent.change(screen.getByLabelText('Fallback models'), {
      target: { value: 'ark-main/ark-code-latest' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add fallback' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!);

    await waitFor(() => {
      expect(routingState.setRoute).toHaveBeenCalledWith('chat', {
        primary: { credentialId: 'openai-main', modelId: 'gpt-5.5' },
        fallbacks: [{ credentialId: 'ark-main', modelId: 'ark-code-latest' }],
      });
    });
  });

  it('saves TTS through the same model route contract', async () => {
    render(<MediaCapabilitiesPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Default Models' }));

    fireEvent.change(screen.getByLabelText('Primary model (credential/model)', { selector: '#capability-tts-primary' }), {
      target: { value: 'openai-main/tts-1' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);

    await waitFor(() => {
      expect(routingState.setRoute).toHaveBeenCalledWith('tts', {
        primary: { credentialId: 'openai-main', modelId: 'tts-1' },
        fallbacks: [],
      });
    });
  });
});
