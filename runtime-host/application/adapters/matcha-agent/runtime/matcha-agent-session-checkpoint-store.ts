export interface MatchaAgentSessionCheckpointStore {
  readLastSeq(sessionId: string): Promise<number | null>;
  writeLastSeq(sessionId: string, seq: number): Promise<void>;
}

export class InMemoryMatchaAgentSessionCheckpointStore implements MatchaAgentSessionCheckpointStore {
  private readonly lastSeqBySessionId = new Map<string, number>();

  async readLastSeq(sessionId: string): Promise<number | null> {
    return this.lastSeqBySessionId.get(sessionId) ?? null;
  }

  async writeLastSeq(sessionId: string, seq: number): Promise<void> {
    const currentSeq = this.lastSeqBySessionId.get(sessionId);
    if (currentSeq !== undefined && currentSeq >= seq) return;
    this.lastSeqBySessionId.set(sessionId, seq);
  }
}
