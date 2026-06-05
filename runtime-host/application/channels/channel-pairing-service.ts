import type { RuntimeProcessEnvironment } from '../common/runtime-ports';

export interface ChannelPairingRequest {
  readonly id: string;
  readonly code: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly meta?: Record<string, string>;
}

export interface ChannelPairingApproval {
  readonly id: string;
  readonly entry?: ChannelPairingRequest;
}

export interface ChannelPairingRuntimeEnvironmentPort {
  getConversationRuntimeEnv(): RuntimeProcessEnvironment;
  getConversationRuntimeModuleUrl(): string;
}

interface ChannelConversationRuntime {
  listChannelPairingRequests(
    channel: string,
    env?: RuntimeProcessEnvironment,
    accountId?: string,
  ): Promise<ChannelPairingRequest[]>;
  approveChannelPairingCode(params: {
    channel: string;
    code: string;
    accountId?: string;
    env?: RuntimeProcessEnvironment;
  }): Promise<ChannelPairingApproval | null>;
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<ChannelConversationRuntime>;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class ChannelPairingService {
  private runtimePromise: Promise<ChannelConversationRuntime> | null = null;

  constructor(private readonly environment: ChannelPairingRuntimeEnvironmentPort) {}

  async listRequests(input: {
    readonly channelType: string;
    readonly accountId?: string;
  }): Promise<{ success: true; requests: ChannelPairingRequest[] }> {
    const runtime = await this.loadConversationRuntime();
    const requests = await runtime.listChannelPairingRequests(
      input.channelType,
      this.environment.getConversationRuntimeEnv(),
      normalizeOptionalString(input.accountId),
    );
    return { success: true, requests };
  }

  async approveRequest(input: {
    readonly channelType: string;
    readonly code: string;
    readonly accountId?: string;
  }): Promise<{ success: true; approved: ChannelPairingApproval | null }> {
    const code = input.code.trim();
    if (!code) {
      return { success: true, approved: null };
    }
    const runtime = await this.loadConversationRuntime();
    const approved = await runtime.approveChannelPairingCode({
      channel: input.channelType,
      code,
      accountId: normalizeOptionalString(input.accountId),
      env: this.environment.getConversationRuntimeEnv(),
    });
    return { success: true, approved };
  }

  private async loadConversationRuntime(): Promise<ChannelConversationRuntime> {
    if (!this.runtimePromise) {
      this.runtimePromise = dynamicImport(this.environment.getConversationRuntimeModuleUrl());
    }
    return await this.runtimePromise;
  }
}
