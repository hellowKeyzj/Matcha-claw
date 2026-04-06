import type { AuditEvent, AuditSinkPort } from '../../shared/platform-runtime-contracts';

export class InMemoryAuditSink implements AuditSinkPort {
  private readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  snapshot(): AuditEvent[] {
    return [...this.events];
  }
}
