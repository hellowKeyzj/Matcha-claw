import { ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { expandPath } from '../../utils/paths';
import { logger } from '../../utils/logger';

const CHROME_EXTENSIONS_URL = 'chrome://extensions/';

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function getChromeLaunchCommands(): Array<{ command: string; args: string[] }> {
  const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? '';

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const candidates = [
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      `${localAppData}\\Google\\Chrome SxS\\Application\\chrome.exe`,
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${localAppData}\\Chromium\\Application\\chrome.exe`,
      `${programFiles}\\Chromium\\Application\\chrome.exe`,
      `${programFilesX86}\\Chromium\\Application\\chrome.exe`,
      'chrome.exe',
      'chrome',
      'chromium.exe',
      'chromium',
    ];

    return candidates.map((command) => ({
      command,
      args: [CHROME_EXTENSIONS_URL],
    }));
  }

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${homeDir}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      `${homeDir}/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`,
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      `${homeDir}/Applications/Chromium.app/Contents/MacOS/Chromium`,
      'google-chrome',
      'chromium',
    ];

    return candidates.map((command) => ({
      command,
      args: [CHROME_EXTENSIONS_URL],
    }));
  }

  const candidates = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ];

  return candidates.map((command) => ({
    command,
    args: [CHROME_EXTENSIONS_URL],
  }));
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

async function openChromeInternalPageOnWindows(chromePath: string, targetUrl: string): Promise<void> {
  const escapedChromePath = escapePowerShellSingleQuotedString(chromePath);
  const escapedTargetUrl = escapePowerShellSingleQuotedString(targetUrl);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$chromePath = '${escapedChromePath}'
$targetUrl = '${escapedTargetUrl}'
$shell = New-Object -ComObject WScript.Shell
$clipboardText = $null
$hasClipboardText = $false
try {
  $clipboardText = Get-Clipboard -Raw -Format Text -ErrorAction Stop
  $hasClipboardText = $true
} catch {
}
try {
  $null = Start-Process -FilePath $chromePath -ArgumentList '--new-window', 'about:blank' -PassThru
  Start-Sleep -Milliseconds 1200
  if (-not ($shell.AppActivate('Google Chrome') -or $shell.AppActivate('Chrome'))) {
    throw 'chrome_window_activate_failed'
  }
  Start-Sleep -Milliseconds 150
  Set-Clipboard -Value $targetUrl
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 120
} finally {
  if ($hasClipboardText) {
    Set-Clipboard -Value $clipboardText
  }
}
`.trim();

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      windowsHide: true,
      stdio: 'ignore',
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`powershell exited with code ${String(code)}`));
    });
  });
}

async function openChromeExtensionsPage(): Promise<void> {
  const launchCommands = getChromeLaunchCommands();
  let lastError: unknown = null;

  for (const { command, args } of launchCommands) {
    if ((command.includes('/') || command.includes('\\')) && !existsSync(command)) {
      continue;
    }

    try {
      if (process.platform === 'win32') {
        await openChromeInternalPageOnWindows(command, CHROME_EXTENSIONS_URL);
        return;
      }

      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });

      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });

      child.unref();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to open ${CHROME_EXTENSIONS_URL}. Chrome executable not found or failed to launch.${lastError instanceof Error ? ` ${lastError.message}` : ''}`,
  );
}

export function registerShellHandlers(): void {
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    if (!isAllowedExternalUrl(url)) {
      throw new Error(`Blocked openExternal for disallowed URL: ${url}`);
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('shell:openChromeExtensions', async () => {
    await openChromeExtensionsPage();
  });

  ipcMain.handle('shell:showItemInFolder', async (_, path: string) => {
    const rawPath = typeof path === 'string' ? path.trim() : '';
    if (!rawPath) {
      return { success: false, error: 'empty_path' };
    }

    const decodedPath = (() => {
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    })();
    const expandedPath = expandPath(decodedPath);
    if (!isAbsolute(expandedPath)) {
      logger.warn(`[shell:showItemInFolder] relative path rejected: "${rawPath}"`);
      return { success: false, error: 'relative_path_not_supported', rawPath };
    }
    const resolvedPath = resolvePath(expandedPath);
    if (!existsSync(resolvedPath)) {
      logger.warn(`[shell:showItemInFolder] target not found: raw="${rawPath}" resolved="${resolvedPath}"`);
      return { success: false, error: 'not_found', rawPath, resolvedPath };
    }
    shell.showItemInFolder(resolvedPath);
    return { success: true, resolvedPath, source: 'absolute' };
  });

  ipcMain.handle('shell:openPath', async (_, path: string) => {
    return await shell.openPath(path);
  });
}
