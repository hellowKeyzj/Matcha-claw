import { EventEmitter } from 'node:events';
import type { EventBusPort, StandardEvent } from '../../core/contracts';

type EventListener = (event: StandardEvent) => void;

export class LocalEventBus implements EventBusPort {
  private readonly emitter = new EventEmitter();

  async publish(event: StandardEvent): Promise<void> {
    this.emitter.emit('event', event);
  }

  subscribe(listener: EventListener): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}
