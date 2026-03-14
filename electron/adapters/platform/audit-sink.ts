import type { AuditEvent, AuditSinkPort } from '../../core/contracts';
import { logger } from '../../utils/logger';

export class InMemoryAuditSink implements AuditSinkPort {
  private readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  snapshot(): AuditEvent[] {
    return [...this.events];
  }
}

export class LoggerAuditSink implements AuditSinkPort {
  async append(event: AuditEvent): Promise<void> {
    logger.info(`[Audit] ${event.type}`, event.payload ?? {});
  }
}
