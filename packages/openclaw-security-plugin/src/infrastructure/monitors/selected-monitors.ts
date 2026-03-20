import path from "node:path";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";

type MonitorSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

type MonitorAlert = {
  timestamp: string;
  severity: MonitorSeverity;
  monitor: string;
  message: string;
  details?: string;
};

type MonitorStatus = {
  running: boolean;
  lastCheck?: string;
  alerts: MonitorAlert[];
};

type AlertCallback = (alert: MonitorAlert) => void;

type MonitorLike = {
  start: (stateDir: string) => Promise<void>;
  stop: () => Promise<void>;
  status: () => MonitorStatus;
  onAlert: (callback: AlertCallback) => void;
};

function createBaseMonitor(name: string): {
  emitAlert: (alert: Omit<MonitorAlert, "monitor" | "timestamp">) => void;
  setRunning: (next: boolean) => void;
  setLastCheck: (iso: string) => void;
  status: () => MonitorStatus;
  onAlert: (callback: AlertCallback) => void;
} {
  let running = false;
  let lastCheck: string | undefined;
  const alerts: MonitorAlert[] = [];
  const callbacks: AlertCallback[] = [];

  const emitAlert = (alert: Omit<MonitorAlert, "monitor" | "timestamp">): void => {
    const normalized: MonitorAlert = {
      timestamp: new Date().toISOString(),
      monitor: name,
      ...alert,
    };
    alerts.push(normalized);
    callbacks.forEach((callback) => callback(normalized));
  };

  return {
    emitAlert,
    setRunning(next: boolean) {
      running = next;
    },
    setLastCheck(iso: string) {
      lastCheck = iso;
    },
    status() {
      return {
        running,
        lastCheck,
        alerts: [...alerts],
      };
    },
    onAlert(callback: AlertCallback) {
      callbacks.push(callback);
    },
  };
}

async function listCredentialFiles(stateDir: string): Promise<string[]> {
  const files: string[] = [];
  const envPath = path.join(stateDir, ".env");
  try {
    await stat(envPath);
    files.push(envPath);
  } catch {
    // ignore
  }
  const credentialDir = path.join(stateDir, "credentials");
  try {
    const entries = await readdir(credentialDir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (entry.isFile()) {
        files.push(path.join(credentialDir, entry.name));
      }
    });
  } catch {
    // ignore
  }
  return files;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+previous\s+instructions/i,
  /you\s+are\s+now/i,
  /new\s+system\s+prompt/i,
  /forward\s+to/i,
  /send\s+to/i,
  /exfiltrate/i,
];

async function listMemoryFiles(stateDir: string): Promise<string[]> {
  const files: string[] = [];
  const agentsDir = path.join(stateDir, "agents");
  let agents: string[] = [];
  try {
    agents = await readdir(agentsDir);
  } catch {
    return files;
  }

  for (const agent of agents) {
    const agentDir = path.join(agentsDir, agent);
    ["SOUL.md", "soul.md", "MEMORY.md"].forEach((name) => {
      files.push(path.join(agentDir, name));
    });

    const memoryDir = path.join(agentDir, "memory");
    try {
      const entries = await readdir(memoryDir, { withFileTypes: true });
      entries.forEach((entry) => {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          files.push(path.join(memoryDir, entry.name));
        }
      });
    } catch {
      // ignore
    }
  }

  return files;
}

function createCredentialMonitor(): MonitorLike {
  const base = createBaseMonitor("credential-monitor");
  let timer: NodeJS.Timeout | null = null;
  const tracked = new Map<string, number>();

  const scan = async (): Promise<void> => {
    const now = new Date().toISOString();
    base.setLastCheck(now);
    const currentFiles = await listCredentialFiles(stateDirRef);
    const currentSet = new Set(currentFiles);

    for (const filePath of currentFiles) {
      try {
        const fileStat = await stat(filePath);
        const mtime = fileStat.mtimeMs;
        const existing = tracked.get(filePath);
        if (existing == null) {
          base.emitAlert({
            severity: "HIGH",
            message: `New credential file detected: ${path.basename(filePath)}`,
            details: `Path: ${filePath}`,
          });
        } else if (existing !== mtime) {
          base.emitAlert({
            severity: "MEDIUM",
            message: `Credential file changed: ${path.basename(filePath)}`,
            details: `Path: ${filePath}`,
          });
        }

        const mode = fileStat.mode & 0o777;
        if ((mode & 0o077) !== 0) {
          base.emitAlert({
            severity: "CRITICAL",
            message: `Credential file permissions are too open: ${path.basename(filePath)} (${mode.toString(8)})`,
            details: `Path: ${filePath}`,
          });
        }
        tracked.set(filePath, mtime);
      } catch {
        // ignore missing file
      }
    }

    [...tracked.keys()].forEach((knownPath) => {
      if (!currentSet.has(knownPath)) {
        tracked.delete(knownPath);
        base.emitAlert({
          severity: "MEDIUM",
          message: `Credential file deleted: ${path.basename(knownPath)}`,
          details: `Path: ${knownPath}`,
        });
      }
    });
  };

  let stateDirRef = "";

  return {
    async start(stateDir: string) {
      if (base.status().running) {
        return;
      }
      stateDirRef = stateDir;
      base.setRunning(true);
      await scan();
      timer = setInterval(() => {
        void scan();
      }, 30000);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      base.setRunning(false);
    },
    status() {
      return base.status();
    },
    onAlert(callback: AlertCallback) {
      base.onAlert(callback);
    },
  };
}

function createMemoryIntegrityMonitor(): MonitorLike {
  const base = createBaseMonitor("memory-integrity");
  let timer: NodeJS.Timeout | null = null;
  let stateDirRef = "";
  const baseline = new Map<string, string>();
  let initialized = false;

  const scan = async (): Promise<void> => {
    const now = new Date().toISOString();
    base.setLastCheck(now);
    const files = await listMemoryFiles(stateDirRef);
    const current = new Map<string, string>();

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const hash = hashContent(content);
        current.set(filePath, hash);

        const oldHash = baseline.get(filePath);
        if (initialized && oldHash == null) {
          base.emitAlert({
            severity: "MEDIUM",
            message: `New memory file created: ${path.basename(filePath)}`,
            details: `Path: ${filePath}`,
          });
        }
        if (initialized && oldHash && oldHash !== hash) {
          base.emitAlert({
            severity: "HIGH",
            message: `Memory file modified: ${path.basename(filePath)}`,
            details: `Path: ${filePath}`,
          });
        }

        for (const pattern of PROMPT_INJECTION_PATTERNS) {
          if (pattern.test(content)) {
            base.emitAlert({
              severity: "CRITICAL",
              message: `Prompt injection patterns detected in ${path.basename(filePath)}`,
              details: `Pattern: ${pattern.source}`,
            });
          }
        }
      } catch {
        // ignore read errors
      }
    }

    if (initialized) {
      [...baseline.keys()].forEach((oldPath) => {
        if (!current.has(oldPath)) {
          base.emitAlert({
            severity: "MEDIUM",
            message: `Memory file deleted: ${path.basename(oldPath)}`,
            details: `Path: ${oldPath}`,
          });
        }
      });
    }

    baseline.clear();
    current.forEach((value, key) => baseline.set(key, value));
    initialized = true;
  };

  return {
    async start(stateDir: string) {
      if (base.status().running) {
        return;
      }
      stateDirRef = stateDir;
      base.setRunning(true);
      await scan();
      timer = setInterval(() => {
        void scan();
      }, 30000);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      base.setRunning(false);
    },
    status() {
      return base.status();
    },
    onAlert(callback: AlertCallback) {
      base.onAlert(callback);
    },
  };
}

function createDisabledCostMonitor(): MonitorLike {
  const base = createBaseMonitor("cost-monitor");
  return {
    async start() {
      base.setRunning(true);
      base.setLastCheck(new Date().toISOString());
    },
    async stop() {
      base.setRunning(false);
    },
    status() {
      return base.status();
    },
    onAlert(callback: AlertCallback) {
      base.onAlert(callback);
    },
  };
}

export const credentialMonitor = createCredentialMonitor();
export const memoryIntegrityMonitor = createMemoryIntegrityMonitor();
export const costMonitor = createDisabledCostMonitor();
