import { app } from 'electron';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import type { LocalProcessLaunchPlan } from '../contracts';
import type { GatewayLaunchContext } from './config-sync';
import { logger } from '../../../utils/logger';
import { appendNodeRequireToNodeOptions } from '../../../utils/paths';

const GATEWAY_FETCH_PRELOAD_SOURCE = `'use strict';
(function () {
  var _f = globalThis.fetch;
  if (typeof _f !== 'function') return;
  if (globalThis.__matchaclawFetchPatched) return;
  globalThis.__matchaclawFetchPatched = true;

  globalThis.fetch = function matchaclawFetch(input, init) {
    var url =
      typeof input === 'string' ? input
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url : '';

    if (url.indexOf('openrouter.ai') !== -1) {
      init = init ? Object.assign({}, init) : {};
      var prev = init.headers;
      var flat = {};
      if (prev && typeof prev.forEach === 'function') {
        prev.forEach(function (v, k) { flat[k] = v; });
      } else if (prev && typeof prev === 'object') {
        Object.assign(flat, prev);
      }
      delete flat['http-referer'];
      delete flat['HTTP-Referer'];
      delete flat['x-title'];
      delete flat['X-Title'];
      delete flat['x-openrouter-title'];
      delete flat['X-OpenRouter-Title'];
      flat['HTTP-Referer'] = 'https://matchaclaw-x.com';
      flat['X-OpenRouter-Title'] = 'MatchaClaw';
      init.headers = flat;
    }
    return _f.call(globalThis, input, init);
  };

  if (process.platform === 'win32') {
    try {
      var cp = require('child_process');
      if (!cp.__matchaclawPatched) {
        cp.__matchaclawPatched = true;
        ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'].forEach(function(method) {
          var original = cp[method];
          if (typeof original !== 'function') return;
          cp[method] = function() {
            var args = Array.prototype.slice.call(arguments);
            var optIdx = -1;
            for (var i = 1; i < args.length; i++) {
              var a = args[i];
              if (a && typeof a === 'object' && !Array.isArray(a)) {
                optIdx = i;
                break;
              }
            }
            if (optIdx >= 0) {
              args[optIdx].windowsHide = true;
            } else {
              var opts = { windowsHide: true };
              if (typeof args[args.length - 1] === 'function') {
                args.splice(args.length - 1, 0, opts);
              } else {
                args.push(opts);
              }
            }
            return original.apply(this, args);
          };
        });
      }
    } catch (e) {
      // ignore
    }
  }
})();
`;

function ensureGatewayFetchPreload(): string {
  const dest = path.join(app.getPath('userData'), 'gateway-fetch-preload.cjs');
  try {
    writeFileSync(dest, GATEWAY_FETCH_PRELOAD_SOURCE, 'utf-8');
  } catch {
    // best-effort
  }
  return dest;
}

export function buildGatewayLaunchPlan(options: {
  readonly port: number;
  readonly launchContext: GatewayLaunchContext;
  readonly sanitizeSpawnArgs: (args: string[]) => string[];
}): { readonly plan: LocalProcessLaunchPlan; readonly lastSpawnSummary: string } {
  const {
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  } = options.launchContext;

  logger.info(
    `Starting Gateway process (mode=${mode}, port=${options.port}, entry="${entryScript}", args="${options.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}", bundledBin=${binPathExists ? 'yes' : 'no'}, providerKeys=${loadedProviderKeyCount}, channels=${channelStartupSummary}, proxy=${proxySummary})`,
  );
  const lastSpawnSummary = `mode=${mode}, entry="${entryScript}", args="${options.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}"`;

  const runtimeEnv = { ...forkEnv };
  // MatchaClaw does not provide LAN gateway discovery, so OpenClaw's Bonjour
  // broadcaster only adds noisy cross-device collisions on shared networks.
  runtimeEnv.OPENCLAW_DISABLE_BONJOUR = '1';
  if (!app.isPackaged) {
    try {
      const preloadPath = ensureGatewayFetchPreload();
      if (existsSync(preloadPath)) {
        runtimeEnv.NODE_OPTIONS = appendNodeRequireToNodeOptions(
          runtimeEnv.NODE_OPTIONS,
          preloadPath,
        );
      }
    } catch (err) {
      logger.warn('Failed to set up OpenRouter headers preload:', err);
    }
  }

  return {
    lastSpawnSummary,
    plan: {
      kind: 'utility',
      command: entryScript,
      args: gatewayArgs,
      cwd: openclawDir,
      stdio: 'pipe',
      env: runtimeEnv as NodeJS.ProcessEnv,
      serviceName: 'OpenClaw Gateway',
      terminateProcessTree: true,
      port: options.port,
      metadata: {
        lastSpawnSummary,
        sanitizedArgs: options.sanitizeSpawnArgs(gatewayArgs),
        mode,
        binPathExists,
        loadedProviderKeyCount,
        proxySummary,
        channelStartupSummary,
      },
    },
  };
}
