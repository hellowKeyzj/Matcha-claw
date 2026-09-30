/** Each module augments this map with its own secret-safe summary. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Module augmentation defines the closed module map.
export interface CallDetailByModule {}

export type CallModule = keyof CallDetailByModule;
export type CallStatus =
  | 'received'
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'unknown';

export type CallRecord<M extends CallModule = CallModule> = {
  [K in M]: {
    callId: string;
    module: K;
    command: string;
    status: CallStatus;
    start: number;
    end: number | null;
    revision: number;
    detail: CallDetailByModule[K];
  };
}[M];

/** Admission to the concrete owner queue, not the associated task/run outcome. */
export interface CallReceipt {
  callId: string;
  accepted: true;
}

export interface CallChanged {
  callId: string;
  revision: number;
}

export interface CallQuery {
  module?: CallModule | null;
  status?: CallStatus | null;
  before?: string | null;
  limit: number;
}

export interface CallPage {
  items: CallRecord[];
  next: string | null;
}

export type CallTransition<M extends CallModule = CallModule> = {
  [K in M]: {
    revision: number;
    status: CallStatus;
    at: number;
    detail: CallDetailByModule[K];
  };
}[M];

export interface CallHistory<M extends CallModule = CallModule> {
  items: CallTransition<M>[];
  next: number | null;
}
