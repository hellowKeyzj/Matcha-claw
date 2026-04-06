import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';

const nativeAddonExternal = ['node-llama-cpp', /^@node-llama-cpp\//];
const qrTerminalExternal = ['qrcode-terminal', /^qrcode-terminal\//];

function clearElectronRunAsNodeForDev(): void {
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    // 防止同一终端执行过 `$env:ELECTRON_RUN_AS_NODE=1` 后污染 Electron 主进程启动。
    // 该变量会让 Electron 以 Node 模式运行，`electron.app` 为空并导致主进程崩溃。
    delete process.env.ELECTRON_RUN_AS_NODE;
  }
}

clearElectronRunAsNodeForDev();

function getNodeModulePackageName(id: string): string | null {
  const normalizedId = id.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const markerIndex = normalizedId.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  let request = normalizedId.slice(markerIndex + marker.length);
  if (request.startsWith('.pnpm/')) {
    const segments = request.split('/');
    const nestedNodeModulesIndex = segments.lastIndexOf('node_modules');
    if (nestedNodeModulesIndex >= 0 && nestedNodeModulesIndex < segments.length - 1) {
      request = segments.slice(nestedNodeModulesIndex + 1).join('/');
    }
  }

  const parts = request.split('/');
  if (parts.length === 0) {
    return null;
  }
  if (parts[0].startsWith('@') && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

function resolveManualChunk(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, '/');

  // App page chunks: prefer page-level split to avoid forcing shared stores
  // into multiple chunks (which can introduce circular chunk warnings).
  if (
    normalizedId.includes('/src/pages/Chat/')
  ) {
    return 'page-chat';
  }
  if (
    normalizedId.includes('/src/pages/Tasks/')
  ) {
    return 'page-tasks';
  }
  if (
    normalizedId.includes('/src/pages/Channels/')
  ) {
    return 'page-channels';
  }
  if (
    normalizedId.includes('/src/pages/Settings/')
    || normalizedId.includes('/src/components/settings/')
  ) {
    return 'page-settings';
  }
  if (
    normalizedId.includes('/src/pages/SubAgents/')
  ) {
    return 'page-subagents';
  }

  const packageName = getNodeModulePackageName(id);
  if (!packageName) {
    return undefined;
  }

  if (
    packageName === 'react'
    || packageName === 'react-dom'
    || packageName === 'react-router-dom'
    || packageName === 'zustand'
    || packageName === 'scheduler'
  ) {
    return 'vendor-react-core';
  }

  if (
    packageName.startsWith('@radix-ui/')
    || packageName === 'lucide-react'
    || packageName === 'framer-motion'
  ) {
    return 'vendor-ui';
  }

  if (packageName === 'i18next' || packageName === 'react-i18next') {
    return 'vendor-i18n';
  }

  if (packageName === 'react-markdown' || packageName === 'remark-gfm') {
    return 'vendor-markdown';
  }
  if (packageName === 'sonner') {
    return 'vendor-ui-toast';
  }

  return undefined;
}

// https://vitejs.dev/config/
export default defineConfig({
  // Required for Electron: all asset URLs must be relative because the renderer
  // loads via file:// in production. vite-plugin-electron-renderer sets this
  // automatically, but we declare it explicitly so the intent is clear and the
  // build remains correct even if plugin order ever changes.
  base: './',
  plugins: [
    react(),
    electron([
      {
        // Main process entry file
        entry: 'electron/main/index.ts',
        onstart(options) {
          options.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: [
                'electron-store',
                'electron-updater',
                'ws',
                ...nativeAddonExternal,
                ...qrTerminalExternal,
              ],
            },
          },
        },
      },
      {
        // Preload scripts entry file
        entry: 'electron/preload/index.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: resolveManualChunk,
      },
      external: [
        ...nativeAddonExternal,
        ...qrTerminalExternal,
      ],
    },
  },
});
