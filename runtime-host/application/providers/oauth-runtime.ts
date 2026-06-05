import type {
  BrowserOAuthInput,
  DeviceOAuthInput,
  ProviderOAuthCompletionWorkflow,
  ProviderOAuthTokenProjectionPort,
} from '../workflows/provider-oauth/provider-oauth-completion-workflow';

export type { ProviderOAuthTokenProjectionPort };

export interface ProviderOAuthCompletionPort {
  completeBrowser(input: BrowserOAuthInput): Promise<unknown>;
  completeDevice(input: DeviceOAuthInput): Promise<unknown>;
}

export class ProviderOAuthCompletionService implements ProviderOAuthCompletionPort {
  constructor(
    private readonly completionWorkflow: Pick<ProviderOAuthCompletionWorkflow, 'completeBrowser' | 'completeDevice'>,
  ) {}

  async completeBrowser(input: BrowserOAuthInput) {
    return await this.completionWorkflow.completeBrowser(input);
  }

  async completeDevice(input: DeviceOAuthInput) {
    return await this.completionWorkflow.completeDevice(input);
  }
}
