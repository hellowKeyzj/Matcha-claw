import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import type { SessionDefaultModelResolverPort } from '../../../sessions/session-metadata-repository';
import { resolveAgentConfigDefaultModel } from '../../../sessions/session-metadata-repository';

export class OpenClawSessionMetadataResolver implements SessionDefaultModelResolverPort {
  constructor(private readonly configRepository: Pick<OpenClawConfigRepositoryPort, 'read'>) {}

  async resolveDefaultModel(sessionKey: string): Promise<string | null> {
    try {
      return resolveAgentConfigDefaultModel(await this.configRepository.read(), sessionKey);
    } catch {
      return null;
    }
  }
}
