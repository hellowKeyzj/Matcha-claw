import { createOpenClawRuntimeSessionContext } from './session-runtime-context';
import type {
  RuntimeProtocolAdapter,
  RuntimeProtocolId,
  RuntimeProviderId,
  RuntimeProviderProfile,
  RuntimeProviderRegistration,
  RuntimeSessionContext,
} from './runtime-provider-types';

export class RuntimeProviderRegistry {
  private readonly protocols = new Map<RuntimeProtocolId, RuntimeProtocolAdapter>();
  private readonly profiles = new Map<RuntimeProviderId, RuntimeProviderProfile>();
  private readonly sessionContexts = new Map<string, RuntimeSessionContext>();

  registerProtocol(protocol: RuntimeProtocolAdapter): void {
    if (this.protocols.has(protocol.protocolId)) {
      throw new Error(`Runtime protocol already registered: ${protocol.protocolId}`);
    }
    this.protocols.set(protocol.protocolId, protocol);
  }

  registerProfile(profile: RuntimeProviderProfile): void {
    if (!this.protocols.has(profile.protocolId)) {
      throw new Error(`Runtime protocol not registered for profile ${profile.id}: ${profile.protocolId}`);
    }
    if (this.profiles.has(profile.id)) {
      throw new Error(`Runtime provider profile already registered: ${profile.id}`);
    }
    this.profiles.set(profile.id, profile);
  }

  register(registration: RuntimeProviderRegistration): void {
    this.registerProtocol(registration.protocol);
    for (const profile of registration.profiles) {
      this.registerProfile(profile);
    }
  }

  listProtocols(): RuntimeProtocolAdapter[] {
    return Array.from(this.protocols.values());
  }

  listProfiles(): RuntimeProviderProfile[] {
    return Array.from(this.profiles.values());
  }

  getProtocol(protocolId: RuntimeProtocolId): RuntimeProtocolAdapter {
    const protocol = this.protocols.get(protocolId);
    if (!protocol) {
      throw new Error(`Runtime protocol not registered: ${protocolId}`);
    }
    return protocol;
  }

  getProfile(runtimeProviderId: RuntimeProviderId): RuntimeProviderProfile {
    const profile = this.profiles.get(runtimeProviderId);
    if (!profile) {
      throw new Error(`Runtime provider profile not registered: ${runtimeProviderId}`);
    }
    return profile;
  }

  rememberSessionContext(context: RuntimeSessionContext): RuntimeSessionContext {
    this.sessionContexts.set(context.sessionKey, context);
    return context;
  }

  forgetSessionContext(sessionKey: string): void {
    this.sessionContexts.delete(sessionKey);
  }

  resolveSessionContext(sessionKey: string, metadata?: Partial<RuntimeSessionContext> | null): RuntimeSessionContext {
    const cached = this.sessionContexts.get(sessionKey);
    if (cached && !metadata) {
      return cached;
    }
    if (metadata?.runtimeProviderId && metadata.protocolId) {
      const context: RuntimeSessionContext = {
        sessionKey,
        protocolId: metadata.protocolId,
        runtimeProviderId: metadata.runtimeProviderId,
        ...(metadata.providerSessionId ? { providerSessionId: metadata.providerSessionId } : {}),
        ...(metadata.agentId ? { agentId: metadata.agentId } : {}),
      };
      return this.rememberSessionContext(context);
    }
    return this.rememberSessionContext(createOpenClawRuntimeSessionContext(sessionKey));
  }

  resolveProtocolForSession(sessionKey: string, metadata?: Partial<RuntimeSessionContext> | null): RuntimeProtocolAdapter {
    const context = this.resolveSessionContext(sessionKey, metadata);
    return this.getProtocol(context.protocolId);
  }

  resolveProfileForSession(sessionKey: string, metadata?: Partial<RuntimeSessionContext> | null): RuntimeProviderProfile {
    const context = this.resolveSessionContext(sessionKey, metadata);
    return this.getProfile(context.runtimeProviderId);
  }
}
