export type ChannelLoginSessionStartInput = {
  readonly channelType: string;
  readonly accountId?: string;
  readonly config?: Record<string, unknown>;
};

export type ChannelLoginSessionStartResult = {
  readonly queued: true;
  readonly sessionKey: string;
};

export interface ChannelLoginSessionHandlerPort {
  start(input: ChannelLoginSessionStartInput): Promise<ChannelLoginSessionStartResult>;
  cancel(channelType: string): Promise<void>;
}

export class ChannelLoginSessionService {
  constructor(private readonly handlers: readonly ChannelLoginSessionHandlerPort[]) {}

  async start(input: ChannelLoginSessionStartInput): Promise<ChannelLoginSessionStartResult> {
    for (const handler of this.handlers) {
      try {
        return await handler.start(input);
      } catch (error) {
        if (!isUnsupportedChannelLoginSessionError(error, input.channelType)) {
          throw error;
        }
      }
    }
    throw new Error(`Unsupported channel session start: ${input.channelType}`);
  }

  async cancel(channelType: string): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler.cancel(channelType);
        return;
      } catch (error) {
        if (!isUnsupportedChannelLoginSessionError(error, channelType)) {
          throw error;
        }
      }
    }
    throw new Error(`Unsupported channel session cancel: ${channelType}`);
  }
}

function isUnsupportedChannelLoginSessionError(error: unknown, channelType: string): boolean {
  return error instanceof Error
    && (
      error.message === `Unsupported channel session start: ${channelType}`
      || error.message === `Unsupported channel session cancel: ${channelType}`
    );
}
