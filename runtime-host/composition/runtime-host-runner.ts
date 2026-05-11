import type { Server } from 'node:http';
import type { RuntimeProcessControlPort } from '../application/common/runtime-ports';
import type { RuntimeHostLifecycle } from '../core/lifecycle';
import type { RuntimeHostLogger } from '../shared/logger';
import { closeRuntimeHostHttpServer } from './runtime-host-server';

export interface RuntimeHostServerRunnerDeps {
  readonly server: Server;
  readonly lifecycle: RuntimeHostLifecycle;
  readonly logger: RuntimeHostLogger;
  readonly processControl: RuntimeProcessControlPort;
  readonly port: number;
}

export class RuntimeHostServerRunner {
  private shutdownPromise: Promise<void> | null = null;
  private signalsBound = false;
  private serverCleanupRegistered = false;

  constructor(private readonly deps: RuntimeHostServerRunnerDeps) {}

  async start(): Promise<Server> {
    this.registerServerCleanup();
    this.bindProcessSignals();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.deps.server.off('listening', onListening);
        this.deps.lifecycle.markError(error);
        reject(error);
      };
      const onListening = () => {
        this.deps.server.off('error', onError);
        this.deps.lifecycle.markRunning();
        this.deps.lifecycle.startBackgroundServices();
        this.deps.logger.info(`listening on http://127.0.0.1:${this.deps.port}`);
        resolve();
      };
      this.deps.server.once('error', onError);
      this.deps.server.once('listening', onListening);
      this.deps.server.listen(this.deps.port, '127.0.0.1');
    });
    return this.deps.server;
  }

  async shutdown(exitCode?: number): Promise<void> {
    if (!this.shutdownPromise) {
      this.deps.lifecycle.markStopping();
      this.shutdownPromise = this.deps.lifecycle.stop();
    }
    await this.shutdownPromise;
    if (typeof exitCode === 'number') {
      this.deps.processControl.exit(exitCode);
    }
  }

  private bindProcessSignals(): void {
    if (this.signalsBound) {
      return;
    }
    this.signalsBound = true;
    this.deps.processControl.onSignal('SIGTERM', () => {
      void this.shutdown(0);
    });
    this.deps.processControl.onSignal('SIGINT', () => {
      void this.shutdown(0);
    });
  }

  private registerServerCleanup(): void {
    if (this.serverCleanupRegistered) {
      return;
    }
    this.serverCleanupRegistered = true;
    this.deps.lifecycle.registerCleanup({
      name: 'http.server',
      run: async () => {
        await closeRuntimeHostHttpServer(this.deps.server);
      },
    });
  }
}
