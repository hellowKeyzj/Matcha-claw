/**
 * Gateway Process Manager
 * Manages the OpenClaw Gateway process lifecycle
 */
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import WebSocket from 'ws';
import { PORTS } from '../utils/config';
import { 
  getOpenClawDir, 
  getOpenClawEntryPath, 
  isOpenClawBuilt, 
  isOpenClawSubmodulePresent,
  isOpenClawInstalled 
} from '../utils/paths';
import { getSetting } from '../utils/store';
import { GatewayEventType, JsonRpcNotification, isNotification, isResponse } from './protocol';

/**
 * Gateway connection status
 */
export interface GatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'error' | 'reconnecting';
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
}

/**
 * Gateway Manager Events
 */
export interface GatewayManagerEvents {
  status: (status: GatewayStatus) => void;
  message: (message: unknown) => void;
  notification: (notification: JsonRpcNotification) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
  'channel:status': (data: { channelId: string; status: string }) => void;
  'chat:message': (data: { message: unknown }) => void;
}

/**
 * Reconnection configuration
 */
interface ReconnectConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
};

/**
 * Gateway Manager
 * Handles starting, stopping, and communicating with the OpenClaw Gateway
 */
export class GatewayManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private status: GatewayStatus = { state: 'stopped', port: PORTS.OPENCLAW_GATEWAY };
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectConfig: ReconnectConfig;
  private shouldReconnect = true;
  private pendingRequests: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  
  constructor(config?: Partial<ReconnectConfig>) {
    super();
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...config };
  }
  
  /**
   * Get current Gateway status
   */
  getStatus(): GatewayStatus {
    return { ...this.status };
  }
  
  /**
   * Check if Gateway is connected and ready
   */
  isConnected(): boolean {
    return this.status.state === 'running' && this.ws?.readyState === WebSocket.OPEN;
  }
  
  /**
   * Start Gateway process
   */
  async start(): Promise<void> {
    if (this.status.state === 'running') {
      return;
    }
    
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.setStatus({ state: 'starting', reconnectAttempts: 0 });
    
    try {
      // Check if Gateway is already running
      const existing = await this.findExistingGateway();
      if (existing) {
        console.log('Found existing Gateway on port', existing.port);
        await this.connect(existing.port);
        this.startHealthCheck();
        return;
      }
      
      // Start new Gateway process
      await this.startProcess();
      
      // Wait for Gateway to be ready
      await this.waitForReady();
      
      // Connect WebSocket
      await this.connect(this.status.port);
      
      // Start health monitoring
      this.startHealthCheck();
      
    } catch (error) {
      this.setStatus({ state: 'error', error: String(error) });
      throw error;
    }
  }
  
  /**
   * Stop Gateway process
   */
  async stop(): Promise<void> {
    // Disable auto-reconnect
    this.shouldReconnect = false;
    
    // Clear all timers
    this.clearAllTimers();
    
    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, 'Gateway stopped by user');
      this.ws = null;
    }
    
    // Kill process
    if (this.process) {
      this.process.kill('SIGTERM');
      // Force kill after timeout
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
          this.process = null;
        }
      }, 5000);
      this.process = null;
    }
    
    // Reject all pending requests
    for (const [, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Gateway stopped'));
    }
    this.pendingRequests.clear();
    
    this.setStatus({ state: 'stopped', error: undefined });
  }
  
  /**
   * Restart Gateway process
   */
  async restart(): Promise<void> {
    console.log('Restarting Gateway...');
    await this.stop();
    // Brief delay before restart
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.start();
  }
  
  /**
   * Clear all active timers
   */
  private clearAllTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
  
  /**
   * Make an RPC call to the Gateway
   */
  async rpc<T>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }
      
      const id = crypto.randomUUID();
      
      // Set timeout for request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      
      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      
      // Send request
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };
      
      try {
        this.ws.send(JSON.stringify(request));
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(new Error(`Failed to send RPC request: ${error}`));
      }
    });
  }
  
  /**
   * Start health check monitoring
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(async () => {
      if (this.status.state !== 'running') {
        return;
      }
      
      try {
        const health = await this.checkHealth();
        if (!health.ok) {
          console.warn('Gateway health check failed:', health.error);
          this.emit('error', new Error(health.error || 'Health check failed'));
        }
      } catch (error) {
        console.error('Health check error:', error);
      }
    }, 30000); // Check every 30 seconds
  }
  
  /**
   * Check Gateway health via HTTP endpoint
   */
  async checkHealth(): Promise<{ ok: boolean; error?: string; uptime?: number }> {
    try {
      const response = await fetch(`http://localhost:${this.status.port}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      
      if (response.ok) {
        const data = await response.json() as { uptime?: number };
        return { ok: true, uptime: data.uptime };
      }
      
      return { ok: false, error: `Health check returned ${response.status}` };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  
  /**
   * Find existing Gateway process
   */
  private async findExistingGateway(): Promise<{ port: number } | null> {
    try {
      // Try to connect to default port
      const port = PORTS.OPENCLAW_GATEWAY;
      const response = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      
      if (response.ok) {
        return { port };
      }
    } catch {
      // Gateway not running
    }
    
    return null;
  }
  
  /**
   * Start Gateway process
   * Uses OpenClaw submodule - supports both production (dist) and development modes
   */
  private async startProcess(): Promise<void> {
    const openclawDir = getOpenClawDir();
    const entryScript = getOpenClawEntryPath();
    
    // Verify OpenClaw submodule exists
    if (!isOpenClawSubmodulePresent()) {
      throw new Error(
        'OpenClaw submodule not found. Please run: git submodule update --init'
      );
    }
    
    // Verify dependencies are installed
    if (!isOpenClawInstalled()) {
      throw new Error(
        'OpenClaw dependencies not installed. Please run: cd openclaw && pnpm install'
      );
    }
    
    // Get or generate gateway token
    const gatewayToken = await getSetting('gatewayToken');
    console.log('Using gateway token:', gatewayToken.substring(0, 10) + '...');
    
    let command: string;
    let args: string[];
    
    // Check if OpenClaw is built (production mode) or use pnpm dev mode
    if (isOpenClawBuilt() && existsSync(entryScript)) {
      // Production mode: use openclaw.mjs directly
      console.log('Starting Gateway in production mode (using dist)');
      command = 'node';
      args = [entryScript, 'gateway', 'run', '--port', String(this.status.port), '--token', gatewayToken, '--dev', '--allow-unconfigured'];
    } else {
      // Development mode: use pnpm gateway:dev which handles tsx compilation
      console.log('Starting Gateway in development mode (using pnpm)');
      command = 'pnpm';
      args = ['run', 'dev', 'gateway', 'run', '--port', String(this.status.port), '--token', gatewayToken, '--dev', '--allow-unconfigured'];
    }
    
    console.log(`Spawning Gateway: ${command} ${args.join(' ')}`);
    console.log(`Working directory: ${openclawDir}`);
    
    return new Promise((resolve, reject) => {
      this.process = spawn(command, args, {
        cwd: openclawDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        shell: process.platform === 'win32', // Use shell on Windows for pnpm
        env: {
          ...process.env,
          // Skip channel auto-connect during startup for faster boot
          OPENCLAW_SKIP_CHANNELS: '1',
          CLAWDBOT_SKIP_CHANNELS: '1',
          // Also set token via environment variable as fallback
          OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        },
      });
      
      this.process.on('error', (error) => {
        console.error('Gateway process error:', error);
        reject(error);
      });
      
      this.process.on('exit', (code) => {
        console.log('Gateway process exited with code:', code);
        this.emit('exit', code);
        
        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          // Attempt to reconnect
          this.scheduleReconnect();
        }
      });
      
      // Log stdout
      this.process.stdout?.on('data', (data) => {
        console.log('Gateway:', data.toString());
      });
      
      // Log stderr
      this.process.stderr?.on('data', (data) => {
        console.error('Gateway error:', data.toString());
      });
      
      // Store PID
      if (this.process.pid) {
        this.setStatus({ pid: this.process.pid });
      }
      
      resolve();
    });
  }
  
  /**
   * Wait for Gateway to be ready
   */
  private async waitForReady(retries = 30, interval = 1000): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(`http://localhost:${this.status.port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        
        if (response.ok) {
          return;
        }
      } catch {
        // Gateway not ready yet
      }
      
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    
    throw new Error('Gateway failed to start');
  }
  
  /**
   * Connect WebSocket to Gateway
   */
  private async connect(port: number): Promise<void> {
    // Get token for WebSocket authentication
    const gatewayToken = await getSetting('gatewayToken');
    
    return new Promise((resolve, reject) => {
      // Include token in WebSocket URL for authentication
      const wsUrl = `ws://localhost:${port}/ws?auth=${encodeURIComponent(gatewayToken)}`;
      
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => {
        console.log('WebSocket connected to Gateway');
        this.setStatus({
          state: 'running',
          port,
          connectedAt: Date.now(),
        });
        this.startPing();
        resolve();
      });
      
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      });
      
      this.ws.on('close', () => {
        console.log('WebSocket disconnected');
        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          this.scheduleReconnect();
        }
      });
      
      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });
    });
  }
  
  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: unknown): void {
    // Check if this is a JSON-RPC response
    if (isResponse(message) && message.id && this.pendingRequests.has(String(message.id))) {
      const request = this.pendingRequests.get(String(message.id))!;
      clearTimeout(request.timeout);
      this.pendingRequests.delete(String(message.id));
      
      if (message.error) {
        const errorMsg = typeof message.error === 'object' 
          ? (message.error as { message?: string }).message || JSON.stringify(message.error)
          : String(message.error);
        request.reject(new Error(errorMsg));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    
    // Check if this is a notification (server-initiated event)
    if (isNotification(message)) {
      this.handleNotification(message);
      return;
    }
    
    // Emit generic message for other handlers
    this.emit('message', message);
  }
  
  /**
   * Handle server-initiated notifications
   */
  private handleNotification(notification: JsonRpcNotification): void {
    this.emit('notification', notification);
    
    // Route specific events
    switch (notification.method) {
      case GatewayEventType.CHANNEL_STATUS_CHANGED:
        this.emit('channel:status', notification.params as { channelId: string; status: string });
        break;
        
      case GatewayEventType.MESSAGE_RECEIVED:
        this.emit('chat:message', notification.params as { message: unknown });
        break;
        
      case GatewayEventType.ERROR:
        const errorData = notification.params as { message?: string };
        this.emit('error', new Error(errorData.message || 'Gateway error'));
        break;
        
      default:
        // Unknown notification type, just log it
        console.log('Unknown Gateway notification:', notification.method);
    }
  }
  
  /**
   * Start ping interval to keep connection alive
   */
  private startPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }
  
  /**
   * Schedule reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      console.log('Auto-reconnect disabled, not scheduling reconnect');
      return;
    }
    
    if (this.reconnectTimer) {
      return;
    }
    
    if (this.reconnectAttempts >= this.reconnectConfig.maxAttempts) {
      console.error(`Max reconnection attempts (${this.reconnectConfig.maxAttempts}) reached`);
      this.setStatus({ 
        state: 'error', 
        error: 'Failed to reconnect after maximum attempts',
        reconnectAttempts: this.reconnectAttempts 
      });
      return;
    }
    
    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.reconnectConfig.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.reconnectConfig.maxDelay
    );
    
    this.reconnectAttempts++;
    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    this.setStatus({ 
      state: 'reconnecting', 
      reconnectAttempts: this.reconnectAttempts 
    });
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        // Try to find existing Gateway first
        const existing = await this.findExistingGateway();
        if (existing) {
          await this.connect(existing.port);
          this.reconnectAttempts = 0;
          this.startHealthCheck();
          return;
        }
        
        // Otherwise restart the process
        await this.startProcess();
        await this.waitForReady();
        await this.connect(this.status.port);
        this.reconnectAttempts = 0;
        this.startHealthCheck();
      } catch (error) {
        console.error('Reconnection failed:', error);
        this.scheduleReconnect();
      }
    }, delay);
  }
  
  /**
   * Update status and emit event
   */
  private setStatus(update: Partial<GatewayStatus>): void {
    const previousState = this.status.state;
    this.status = { ...this.status, ...update };
    
    // Calculate uptime if connected
    if (this.status.state === 'running' && this.status.connectedAt) {
      this.status.uptime = Date.now() - this.status.connectedAt;
    }
    
    this.emit('status', this.status);
    
    // Log state transitions
    if (previousState !== this.status.state) {
      console.log(`Gateway state: ${previousState} -> ${this.status.state}`);
    }
  }
}
