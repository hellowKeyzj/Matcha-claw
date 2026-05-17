import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeProcessEnvironment } from '../common/runtime-ports';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';

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

interface OpenClawConversationRuntime {
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
) => Promise<OpenClawConversationRuntime>;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class ChannelPairingService {
  private runtimePromise: Promise<OpenClawConversationRuntime> | null = null;

  constructor(private readonly environment: OpenClawEnvironmentRepository) {}

  async listRequests(input: {
    readonly channelType: string;
    readonly accountId?: string;
  }): Promise<{ success: true; requests: ChannelPairingRequest[] }> {
    const runtime = await this.loadConversationRuntime();
    const requests = await runtime.listChannelPairingRequests(
      input.channelType,
      this.buildOpenClawEnv(),
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
      env: this.buildOpenClawEnv(),
    });
    return { success: true, approved };
  }

  private buildOpenClawEnv(): RuntimeProcessEnvironment {
    return {
      ...this.environment.getProcessEnv(),
      OPENCLAW_CONFIG_DIR: this.environment.getOpenClawConfigDir(),
    };
  }

  private async loadConversationRuntime(): Promise<OpenClawConversationRuntime> {
    if (!this.runtimePromise) {
      this.runtimePromise = dynamicImport(this.resolveConversationRuntimeSpecifier());
    }
    return await this.runtimePromise;
  }

  private resolveConversationRuntimeSpecifier(): string {
    const bases = [
      join(this.environment.getOpenClawDirPath(), 'package.json'),
      __filename,
    ];
    for (const base of bases) {
      try {
        const resolved = createRequire(base).resolve('openclaw/plugin-sdk/conversation-runtime');
        return pathToFileURL(resolved).href;
      } catch {
        // Try the next resolution base.
      }
    }
    throw new Error('Unable to resolve openclaw/plugin-sdk/conversation-runtime');
  }
}
