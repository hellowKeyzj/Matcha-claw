import { _electron, chromium, type Browser, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { Ability } from '@serenity-js/core';
import { BrowseTheWebWithPlaywright } from '@serenity-js/playwright';
import { access, appendFile, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appProjectRoot, electronMain, electronPreload, licensedProfileRoot, profileMode, rendererIndex, UI_TIMEOUT_MS } from '../config/electron.js';

export type PublicHostApiReply =
  | { ok: false; error: { code: string; message?: string } }
  | { ok: true; data: { status: number; ok: boolean; json?: unknown; text?: string } };

const inheritedToolEnvironment = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'PROGRAMDATA',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS',
  'DISPLAY', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL', 'TZ',
]);

async function allocatePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    return await Promise.all(servers.map(async (server) => {
      await new Promise<void>((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', accept);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('E2E could not reserve a loopback TCP port');
      return address.port;
    }));
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server =>
      new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))));
  }
}

export class UseElectron extends Ability {
  private app?: ElectronApplication;
  private connectedBrowser?: Browser;
  private primaryWindow?: Page;
  private borrowedBrowsing?: BrowseTheWebWithPlaywright;
  private hasFailed = false;
  private logWrites: Promise<void> = Promise.resolve();
  private versions?: { electron: string; chromium: string; pid: number; userData: string; cwd: string };
  private profileLock?: FileHandle;
  private recording = false;
  private processExited = true;

  constructor(readonly profileRoot: string, private readonly evidenceRoot: string, private readonly activation: boolean) {
    super();
  }

  static async start(evidenceRoot: string, activation = false): Promise<UseElectron> {
    if (activation && profileMode !== 'licensed') throw new Error('License activation requires E2E_PROFILE=licensed');
    const profileRoot = profileMode === 'licensed' ? licensedProfileRoot : await mkdtemp(join(tmpdir(), 'matchaclaw-screenplay-'));
    const owner = new UseElectron(profileRoot, evidenceRoot, activation);
    if (profileMode === 'licensed') {
      await mkdir(profileRoot, { recursive: true });
      try {
        owner.profileLock = await open(join(profileRoot, '.owner.lock'), 'wx');
      } catch (error) {
        throw new Error(`Dedicated E2E profile is locked; do not reuse a live profile or automatically remove its lock: ${profileRoot}`, { cause: error });
      }
    }
    try {
      await owner.profileLock?.writeFile(JSON.stringify({ runnerPid: process.pid }));
      await owner.launch();
      if (!activation) {
        const receipt = await owner.licenseReceipt();
        if (profileMode === 'licensed' && (receipt.state !== 'granted' || !receipt.hasStoredKey || !receipt.hasUsableCache || !receipt.valid
          || (receipt.source !== 'server' && receipt.source !== 'cache'))) {
          throw new Error('Dedicated E2E profile needs a real license; run pnpm --dir e2e license:activate first');
        }
        await writeFile(join(evidenceRoot, 'license.json'), JSON.stringify(receipt, null, 2));
      }
      return owner;
    } catch (error) {
      owner.hasFailed = true;
      await owner.log(`startup failed: ${String(error)}`);
      try {
        await owner.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], `Electron startup and cleanup failed; profile retained at ${owner.profileRoot}`);
      }
      throw new Error(`Electron startup failed; profile retained at ${owner.profileRoot}; logs at ${owner.logPath}`, { cause: error });
    }
  }

  get page(): Page {
    if (!this.primaryWindow) throw new Error('E2E Electron window is not ready');
    return this.primaryWindow;
  }

  get browsing(): BrowseTheWebWithPlaywright {
    if (!this.borrowedBrowsing) throw new Error('E2E Electron browsing session is not ready');
    return this.borrowedBrowsing;
  }

  get outputDirectory(): string {
    return this.evidenceRoot;
  }

  private get logPath(): string {
    return join(this.evidenceRoot, 'electron.log');
  }

  private log(message: string): Promise<void> {
    this.logWrites = this.logWrites.then(() => appendFile(this.logPath, `${new Date().toISOString()} ${message.slice(0, 8_192)}\n`));
    return this.logWrites;
  }

  private async launch(): Promise<void> {
    await mkdir(this.evidenceRoot, { recursive: true });
    const runtimeHost = join(appProjectRoot, 'runtime-host', 'dist', `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'runtime-host.exe' : 'runtime-host');
    await Promise.all([electronMain, electronPreload, rendererIndex, runtimeHost].map(path => access(path)));
    const userData = join(this.profileRoot, 'user-data');
    const appData = join(this.profileRoot, 'AppData', 'Roaming');
    const localAppData = join(this.profileRoot, 'AppData', 'Local');
    const xdgConfig = join(this.profileRoot, '.config');
    const xdgCache = join(this.profileRoot, '.cache');
    const xdgData = join(this.profileRoot, '.local', 'share');
    const xdgState = join(this.profileRoot, '.local', 'state');
    const temporary = join(this.profileRoot, 'tmp');
    await Promise.all([userData, appData, localAppData, xdgConfig, xdgCache, xdgData, xdgState, temporary, join(this.profileRoot, 'Desktop')].map(path => mkdir(path, { recursive: true })));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && inheritedToolEnvironment.has(name.toUpperCase()))) as Record<string, string>;
    const [hostApiPort, runtimeHostPort, matchaPort, gatewayPort] = await allocatePorts(4);
    Object.assign(env, {
      MATCHACLAW_E2E: '1',
      MATCHACLAW_TRACE: this.activation ? '0' : '1',
      MATCHACLAW_E2E_USER_DATA_DIR: userData,
      MATCHACLAW_PORT_MATCHACLAW_HOST_API: String(hostApiPort),
      MATCHACLAW_RUNTIME_HOST_PORT: String(runtimeHostPort),
      MATCHACLAW_MATCHA_AGENT_APP_SERVER_PORT: String(matchaPort),
      MATCHACLAW_PORT_OPENCLAW_GATEWAY: String(gatewayPort),
      HOME: this.profileRoot,
      USERPROFILE: this.profileRoot,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      HOMEDRIVE: parse(this.profileRoot).root.replace(/[\\/]+$/, ''),
      HOMEPATH: this.profileRoot.slice(parse(this.profileRoot).root.length - 1),
      MATCHA_CLOUD_BASE_URL: 'http://127.0.0.1:1/api/v1',
    });
    const uv = join(appProjectRoot, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'uv.exe' : 'uv');
    await new Promise<void>((accept, reject) => {
      execFile(uv, ['--offline', 'python', 'find', '3.12'], { cwd: appProjectRoot, env, timeout: 10_000 }, error => {
        if (error) reject(new Error('E2E requires existing Python 3.12 on the isolated tool PATH; no installation was attempted', { cause: error }));
        else accept();
      });
    });
    const artifacts: Record<string, { path: string; sha256: string }> = {};
    for (const [name, path] of Object.entries({ main: electronMain, preload: electronPreload, renderer: rendererIndex, runtimeHost })) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      artifacts[name] = { path, sha256: hash.digest('hex') };
    }
    await writeFile(join(this.evidenceRoot, 'artifacts.json'), JSON.stringify({ appProjectRoot, artifacts }, null, 2));
    await this.log(`launch main=${electronMain} cwd=${appProjectRoot} profile=${this.profileRoot}`);
    this.processExited = false;
    this.app = await _electron.launch({
      args: [`--user-data-dir=${userData}`, electronMain],
      cwd: appProjectRoot,
      env,
      timeout: UI_TIMEOUT_MS,
    });
    const child = this.app.process();
    child.once('exit', () => { this.processExited = true; });
    if (!this.activation) {
      child.stdout?.on('data', (chunk: Buffer) => { void this.log(`stdout ${chunk.toString()}`); });
      child.stderr?.on('data', (chunk: Buffer) => { void this.log(`stderr ${chunk.toString()}`); });
      this.app.on('console', message => { void this.log(`main ${message.type()} ${message.text()}`); });
    }
    this.app.on('window', window => this.observeWindow(window));
    this.app.windows().forEach(window => this.observeWindow(window));
    this.versions = await this.app.evaluate(({ app }) => ({
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      pid: process.pid,
      userData: app.getPath('userData'),
      cwd: process.cwd(),
    }));
    if (resolve(this.versions.userData) !== userData) throw new Error('Electron did not adopt the owned E2E userData directory');
    if (resolve(this.versions.cwd) !== appProjectRoot) throw new Error('Electron did not adopt the selected application project root');
    this.primaryWindow = await this.waitForPrimaryWindow();
    await writeFile(join(this.evidenceRoot, 'session.json'), JSON.stringify({
      ...this.versions, profileRoot: this.profileRoot, userData, main: electronMain, renderer: this.primaryWindow.url(),
    }, null, 2));
    if (!this.activation) {
      await this.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      this.recording = true;
    }
    // Borrow one session for the worker; per-actor sessions would accumulate context listeners.
    this.borrowedBrowsing = BrowseTheWebWithPlaywright.usingElectronApp(this.app, {
      defaultTimeout: UI_TIMEOUT_MS, defaultNavigationTimeout: UI_TIMEOUT_MS, defaultNavigationWaitUntil: 'domcontentloaded',
    });
    const current = await this.borrowedBrowsing.currentPage();
    if ((await current.url()).href.split('#')[0] !== pathToFileURL(rendererIndex).href) {
      throw new Error(`Serenity selected a non-primary Electron window: ${(await current.url()).href}`);
    }
  }

  private observeWindow(window: Page): void {
    if (!this.activation) {
      window.on('console', message => { void this.log(`renderer ${message.type()} ${message.text()}`); });
      window.on('pageerror', error => { void this.log(`renderer error ${error.stack ?? error.message}`); });
    }
    window.on('crash', () => { this.hasFailed = true; void this.log('renderer crashed'); });
  }

  private async waitForPrimaryWindow(): Promise<Page> {
    if (!this.app) throw new Error('E2E Electron app was not launched');
    const deadline = Date.now() + UI_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const window = this.app.windows().find(candidate => {
        const url = candidate.url();
        return !candidate.isClosed() && url.startsWith('file:') && resolve(fileURLToPath(url.split('#')[0])) === rendererIndex;
      });
      if (window) {
        await window.waitForLoadState('domcontentloaded');
        return window;
      }
      const startup = await this.app.evaluate(() => {
        const state = process as typeof process & { __matchaclawE2EStartupOutcome?: { stage: string; outcome: string }; __matchaclawE2ELaunchDiagnostic?: unknown };
        return { outcome: state.__matchaclawE2EStartupOutcome, diagnostic: state.__matchaclawE2ELaunchDiagnostic };
      });
      if (startup.outcome && !(startup.outcome.stage === 'ready' && startup.outcome.outcome === 'started')) {
        throw new Error(`Electron bootstrap rejected startup: ${JSON.stringify(startup)}`);
      }
      await delay(200);
    }
    throw new Error(`No primary Electron renderer for ${rendererIndex} after ${UI_TIMEOUT_MS}ms`);
  }

  async startupOutcome(): Promise<{ stage: string; outcome: string } | null> {
    if (!this.app) throw new Error('E2E Electron app was not launched');
    return this.app.evaluate(() => {
      const state = process as typeof process & { __matchaclawE2EStartupOutcome?: { stage: string; outcome: string } };
      return state.__matchaclawE2EStartupOutcome ?? null;
    });
  }

  async completeNativeDirectoryPicker(absolutePath: string): Promise<void> {
    await this.completeNativePicker(absolutePath, 'directory', '选择目录');
  }

  async completeNativeFileImport(absolutePath: string, confirmation: {
    pickerTitle: string; title: string; button: string; expectedText: readonly string[];
  }): Promise<void> {
    await this.completeNativePicker(absolutePath, 'file', confirmation.pickerTitle, confirmation);
  }

  async completeNativeFilePicker(absolutePath: string, pickerTitle: string): Promise<void> {
    await this.completeNativePicker(absolutePath, 'file', pickerTitle);
  }

  private async completeNativePicker(absolutePath: string, kind: 'directory' | 'file', pickerTitle: string, confirmation?: {
    pickerTitle: string; title: string; button: string; expectedText: readonly string[];
  }): Promise<void> {
    if (process.platform !== 'win32' || !this.app || !this.versions || this.processExited
      || this.app.process().exitCode !== null || !isAbsolute(absolutePath)) {
      throw new Error('Native selection requires the live owned Windows Electron and an absolute path');
    }
    await access(absolutePath);
    const nativeWindow = await this.app.browserWindow(this.page);
    let mainHandle: string;
    try {
      mainHandle = await nativeWindow.evaluate(window => window.getNativeWindowHandle().readBigUInt64LE().toString());
    } finally { await nativeWindow.dispose(); }
    const executable = await this.app.evaluate(() => process.execPath);
    const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PickerWindow {
  delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter, string text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] public static extern IntPtr ReadText(IntPtr window, uint message, UIntPtr count, System.Text.StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr Notify(IntPtr window, uint message, UIntPtr command, IntPtr control, uint flags, uint timeout, out UIntPtr result);
  public static IntPtr[] Controls(IntPtr dialog, string className, int id) {
    var matches = new List<IntPtr>();
    EnumChildWindows(dialog, (window, parameter) => {
      if (!IsWindowVisible(window) || !IsWindowEnabled(window) || GetDlgCtrlID(window) != id) return true;
      var text = new StringBuilder(256);
      GetClassName(window, text, text.Capacity);
      if (text.ToString() == className) matches.Add(window);
      return true;
    }, IntPtr.Zero);
    return matches.ToArray();
  }
  public static bool Owned(IntPtr window, IntPtr main) {
    var seen = new HashSet<IntPtr>();
    for (var owner = GetWindow(window, 4); owner != IntPtr.Zero && seen.Count < 32 && seen.Add(owner); owner = GetWindow(owner, 4))
      if (owner == main) return true;
    return false;
  }
  public static IntPtr[] Dialogs(IntPtr main, string title) {
    var matches = new List<IntPtr>();
    EnumWindows((window, parameter) => {
      if (!IsWindowVisible(window) || !Owned(window, main)) return true;
      var text = new StringBuilder(512);
      GetClassName(window, text, text.Capacity);
      if (text.ToString() != "#32770") return true;
      text.Clear();
      GetWindowText(window, text, text.Capacity);
      if (text.ToString() == title) matches.Add(window);
      return true;
    }, IntPtr.Zero);
    return matches.ToArray();
  }
  public static IntPtr[] NamedButtons(IntPtr dialog, string expected) {
    var matches = new List<IntPtr>();
    EnumChildWindows(dialog, (window, parameter) => {
      if (!IsWindowVisible(window) || !IsWindowEnabled(window)) return true;
      var text = new StringBuilder(512);
      GetClassName(window, text, text.Capacity);
      if (text.ToString() != "Button") return true;
      text.Clear();
      GetWindowText(window, text, text.Capacity);
      if (text.ToString().Replace("&", "").Trim() == expected) matches.Add(window);
      return true;
    }, IntPtr.Zero);
    return matches.ToArray();
  }
  public static string[] ObserveButtons(IntPtr dialog, string expected) {
    var observations = new List<string>();
    EnumChildWindows(dialog, (window, parameter) => {
      var text = new StringBuilder(512);
      GetClassName(window, text, text.Capacity);
      if (text.ToString() != "Button") return true;
      text.Clear();
      GetWindowText(window, text, text.Capacity);
      var label = text.ToString().Replace("&", "").Trim();
      var kind = label == expected ? "expected" : label == "取消" || label == "Cancel" ? "cancel" : "other";
      observations.Add(GetDlgCtrlID(window) + ":" + kind + ":" + (IsWindowEnabled(window) ? "1" : "0"));
      return observations.Count < 16;
    }, IntPtr.Zero);
    return observations.ToArray();
  }
  public static string[] ObserveOwned(IntPtr main, string pickerTitle, string confirmationTitle) {
    var observations = new List<string>();
    EnumWindows((window, parameter) => {
      if (!IsWindowVisible(window) || !Owned(window, main)) return true;
      var text = new StringBuilder(512);
      GetClassName(window, text, text.Capacity);
      var classKind = text.ToString() == "#32770" ? "dialog" : "other";
      text.Clear();
      GetWindowText(window, text, text.Capacity);
      var title = text.ToString();
      var titleKind = title == pickerTitle ? "picker" : title == confirmationTitle ? "confirmation" : title == "位置不可用" ? "location-unavailable" : "other";
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      observations.Add(window.ToInt64() + ":" + pid + ":" + classKind + ":" + titleKind);
      return observations.Count < 16;
    }, IntPtr.Zero);
    return observations.ToArray();
  }
}
'@
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$expectedTitle = [string]$request.pickerTitle
$dialog = $null
$handle = [IntPtr]::Zero
$mainHandle = [IntPtr]::new([long]$request.mainHandle)
$stage = 'process-identity'
function Assert-OwnedMain {
  [uint32]$actual = 0
  [void][PickerWindow]::GetWindowThreadProcessId($mainHandle, [ref]$actual)
  $main = Get-Process -Id $request.pid
  if (-not [PickerWindow]::IsWindow($mainHandle) -or $actual -ne $request.pid -or
      $main.StartTime.ToUniversalTime().Ticks -ne $started -or $main.Path -ine $request.executable) {
    throw 'Picker ownership changed'
  }
}
function Find-OwnedDialog([int]$seconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    Assert-OwnedMain
    $matches = @([PickerWindow]::Dialogs($mainHandle, $expectedTitle))
    if ($matches.Count -gt 1) { throw 'Picker is ambiguous' }
    if ($matches.Count -eq 1) { return $matches[0] }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return [IntPtr]::Zero
}
function Assert-OwnedDialog {
  Assert-OwnedMain
  [uint32]$actual = 0
  if (-not [PickerWindow]::IsWindow($handle)) { throw 'Picker closed unexpectedly' }
  [void][PickerWindow]::GetWindowThreadProcessId($handle, [ref]$actual)
  $process = Get-Process -Id $dialogPid
  if ($actual -ne $dialogPid -or $process.StartTime.ToUniversalTime().Ticks -ne $dialogStarted -or
      $dialogStarted -lt $started -or $process.Path -ine $request.executable -or
      -not [PickerWindow]::Owned($handle, $mainHandle) -or $dialog.Current.ProcessId -ne $dialogPid -or
      $dialog.Current.ClassName -cne '#32770' -or $dialog.Current.Name -cne $expectedTitle) {
    throw 'Picker ownership changed'
  }
}
function Normalize-DirectoryPath([string]$path) {
  $path = $path.Replace('/', '\')
  $root = [System.IO.Path]::GetPathRoot($path)
  while ($path.Length -gt $root.Length -and $path.EndsWith('\')) { $path = $path.Substring(0, $path.Length - 1) }
  return $path
}
try {
  $started = (Get-Process -Id $request.pid).StartTime.ToUniversalTime().Ticks
  $stage = 'dialog-discovery'
  $handle = Find-OwnedDialog 20
  if ($handle -eq [IntPtr]::Zero) { throw 'Owned picker did not open' }
  $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $dialogPid = $dialog.Current.ProcessId
  $dialogStarted = (Get-Process -Id $dialogPid).StartTime.ToUniversalTime().Ticks
  Assert-OwnedDialog
  $stage = 'path-control'
  $inputId = if ($request.kind -eq 'directory') { 1152 } else { 1148 }
  $inputs = @([PickerWindow]::Controls($handle, 'Edit', $inputId))
  if ($inputs.Count -ne 1) { throw 'Picker path input is unavailable' }
  $inputHandle = $inputs[0]
  [uint32]$inputPid = 0
  [void][PickerWindow]::GetWindowThreadProcessId($inputHandle, [ref]$inputPid)
  if ($inputPid -ne $dialogPid) { throw 'Picker ownership changed' }
  $stage = 'path-value-pattern'
  Assert-OwnedDialog
  [UIntPtr]$sent = [UIntPtr]::Zero
  if ([PickerWindow]::SendMessageTimeout($inputHandle, 12, [UIntPtr]::Zero, [string]$request.path, 2, 3000, [ref]$sent) -eq [IntPtr]::Zero -or $sent -eq [UIntPtr]::Zero) { throw 'Picker path readback failed' }
  Assert-OwnedDialog
  $readback = [System.Text.StringBuilder]::new(32768)
  if ([PickerWindow]::ReadText($inputHandle, 13, [UIntPtr]::new([uint32]$readback.Capacity), $readback, 2, 3000, [ref]$sent) -eq [IntPtr]::Zero) { throw 'Picker path readback failed' }
  if ($readback.ToString() -cne $request.path) { throw 'Picker path readback failed' }
  $stage = 'confirmation-control'
  $buttons = @([PickerWindow]::Controls($handle, 'Button', 1))
  if ($buttons.Count -ne 1 -or [PickerWindow]::GetParent($buttons[0]) -ne $handle) { throw 'Picker confirmation is unavailable' }
  [uint32]$buttonPid = 0
  [void][PickerWindow]::GetWindowThreadProcessId($buttons[0], [ref]$buttonPid)
  if ($buttonPid -ne $dialogPid) { throw 'Picker ownership changed' }
  $buttonText = [System.Text.StringBuilder]::new(128)
  if ([PickerWindow]::ReadText($buttons[0], 13, [UIntPtr]::new([uint32]$buttonText.Capacity), $buttonText, 2, 3000, [ref]$sent) -eq [IntPtr]::Zero) { throw 'Picker confirmation is unavailable' }
  if ($request.kind -eq 'directory') {
    if ($buttonText.ToString() -cne '选择目录') { throw 'Picker confirmation is unavailable' }
  } elseif ($buttonText.ToString().Replace('&', '') -notmatch '^(打开|Open)(\(O\))?$') { throw 'Picker confirmation is unavailable' }
  Assert-OwnedDialog
  if ([PickerWindow]::Notify($handle, 273, [UIntPtr]::new(1), $buttons[0], 2, 3000, [ref]$sent) -eq [IntPtr]::Zero) { throw 'Picker did not close' }
  if ($request.kind -eq 'directory' -and [PickerWindow]::IsWindow($handle)) {
    $stage = 'path-value-pattern'
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    $target = Normalize-DirectoryPath ([string]$request.path)
    $navigated = $false
    try {
      while ([PickerWindow]::IsWindow($handle) -and [DateTime]::UtcNow -lt $deadline) {
        Assert-OwnedDialog
        $addresses = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.AndCondition]::new(
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'ToolbarWindow32'),
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')))
        if ($addresses.Count -ne 1) { throw 'Picker path readback failed' }
        $address = $addresses.Item(0)
        if ($address.Current.ProcessId -ne $dialogPid) { throw 'Picker ownership changed' }
        $texts = @($address.Current.Name); $pattern = $null; $same = $false
        if ($address.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $texts += $pattern.Current.Value }
        foreach ($text in $texts) {
          $location = $text -replace '^(地址|Address)\s*[:：]\s*', ''
          if (-not [System.IO.Path]::IsPathRooted($location)) { continue }
          if ((Normalize-DirectoryPath $location) -cne $target) { throw 'Picker path readback failed' }
          $same = $true
        }
        Assert-OwnedDialog
        $inputs = @([PickerWindow]::Controls($handle, 'Edit', 1152))
        if ($inputs.Count -ne 1 -or $inputs[0] -ne $inputHandle) { throw 'Picker path input is unavailable' }
        $inputPid = 0
        [void][PickerWindow]::GetWindowThreadProcessId($inputHandle, [ref]$inputPid)
        if ($inputPid -ne $dialogPid) { throw 'Picker ownership changed' }
        [void]$readback.Clear()
        if ([PickerWindow]::ReadText($inputHandle, 13, [UIntPtr]::new([uint32]$readback.Capacity), $readback, 2, 3000, [ref]$sent) -eq [IntPtr]::Zero) { throw 'Picker path readback failed' }
        if ($same -and (Normalize-DirectoryPath $readback.ToString()) -cne $target) { $navigated = $true; break }
        Start-Sleep -Milliseconds 100
      }
      if ([PickerWindow]::IsWindow($handle)) {
        if (-not $navigated) { throw 'Picker path readback failed' }
        $stage = 'confirmation-control'
        Assert-OwnedDialog
        $confirmed = @([PickerWindow]::Controls($handle, 'Button', 1))
        if ($confirmed.Count -ne 1 -or $confirmed[0] -ne $buttons[0] -or [PickerWindow]::GetParent($buttons[0]) -ne $handle) { throw 'Picker confirmation is unavailable' }
        $buttonPid = 0
        [void][PickerWindow]::GetWindowThreadProcessId($buttons[0], [ref]$buttonPid)
        if ($buttonPid -ne $dialogPid) { throw 'Picker ownership changed' }
        [void]$buttonText.Clear()
        if ([PickerWindow]::ReadText($buttons[0], 13, [UIntPtr]::new([uint32]$buttonText.Capacity), $buttonText, 2, 3000, [ref]$sent) -eq [IntPtr]::Zero -or $buttonText.ToString() -cne '选择目录') { throw 'Picker confirmation is unavailable' }
        Assert-OwnedDialog
        if ([PickerWindow]::Notify($handle, 273, [UIntPtr]::new(1), $buttons[0], 2, 3000, [ref]$sent) -eq [IntPtr]::Zero) { throw 'Picker did not close' }
      }
    } catch {
      $unavailable = $_.Exception -is [System.Windows.Automation.ElementNotAvailableException] -or $_.Exception.InnerException -is [System.Windows.Automation.ElementNotAvailableException]
      if ([PickerWindow]::IsWindow($handle) -or ($_.FullyQualifiedErrorId -cne 'Picker closed unexpectedly' -and -not $unavailable)) { throw }
      Assert-OwnedMain
    }
  }
  $stage = 'dialog-close'
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([PickerWindow]::IsWindow($handle) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if ([PickerWindow]::IsWindow($handle)) { throw 'Picker did not close' }
  if ($request.kind -eq 'file' -and $null -ne $request.confirmation) {
    $stage = 'import-confirmation'
    $expectedTitle = [string]$request.confirmation.title
    $handle = Find-OwnedDialog 30
    if ($handle -eq [IntPtr]::Zero) { throw 'Import confirmation is unavailable' }
    $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $dialogPid = $dialog.Current.ProcessId
    $dialogStarted = (Get-Process -Id $dialogPid).StartTime.ToUniversalTime().Ticks
    Assert-OwnedDialog
    $texts = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text))
    foreach ($expected in $request.confirmation.expectedText) {
      $found = $false
      foreach ($text in $texts) { if ($text.Current.Name.Contains([string]$expected)) { $found = $true; break } }
      if (-not $found) { throw 'Import confirmation differs' }
    }
    $buttons = @([PickerWindow]::NamedButtons($handle, [string]$request.confirmation.button))
    if ($buttons.Count -ne 1) {
      [Console]::Error.WriteLine('picker-native-buttons:' + ([PickerWindow]::ObserveButtons($handle, [string]$request.confirmation.button) -join ','))
      throw 'Import confirmation is unavailable'
    }
    [uint32]$buttonPid = 0
    [void][PickerWindow]::GetWindowThreadProcessId($buttons[0], [ref]$buttonPid)
    if ($buttonPid -ne $dialogPid) { throw 'Picker ownership changed' }
    Assert-OwnedDialog
    [UIntPtr]$sent = [UIntPtr]::Zero
    if ([PickerWindow]::Notify($buttons[0], 245, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 3000, [ref]$sent) -eq [IntPtr]::Zero) { throw 'Picker did not close' }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([PickerWindow]::IsWindow($handle) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ([PickerWindow]::IsWindow($handle)) { throw 'Picker did not close' }
  }
} catch {
  $failureId = $_.FullyQualifiedErrorId
  $knownFailureIds = @('Picker closed unexpectedly', 'Picker ownership changed', 'Picker is ambiguous',
    'Owned picker did not open', 'Picker path input is unavailable',
    'Picker path readback failed', 'Picker confirmation is unavailable', 'Picker did not close',
    'Import confirmation is unavailable', 'Import confirmation differs')
  $failure = if ($knownFailureIds -contains $failureId) { $failureId }
    elseif ($_.Exception -is [System.Management.Automation.MethodInvocationException]) { 'uia-method' }
    else { 'script-error' }
  if ($null -ne $dialog -and [PickerWindow]::IsWindow($handle)) {
    try {
      Assert-OwnedDialog
      $cancel = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.AndCondition]::new(
          [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '2'),
          [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
      if ($cancel.Count -eq 1 -and $cancel.Item(0).Current.ProcessId -eq $dialogPid) {
        Assert-OwnedDialog
        $cancel.Item(0).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      }
    } catch {}
  }
  try {
    Assert-OwnedMain
    $observations = [PickerWindow]::ObserveOwned($mainHandle, [string]$request.pickerTitle, [string]$request.confirmation.title)
    [Console]::Error.WriteLine('picker-owned:' + ($observations -join ','))
  } catch {}
  [Console]::Error.WriteLine('picker-stage:' + $stage + ';picker-reason:' + $failure +
    ';picker-error:' + $_.Exception.GetType().Name + ';picker-line:' + $_.InvocationInfo.ScriptLineNumber)
  exit 1
}
`;
    await new Promise<void>((accept, reject) => {
      const child = execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: kind === 'file' ? 75_000 : 30_000, maxBuffer: 4_096 }, (error, _stdout, stderr) => {
          if (error) {
            const stage = /picker-stage:(process-identity|dialog-discovery|path-control|path-value-pattern|confirmation-control|dialog-close|import-confirmation)\b/.exec(stderr)?.[1] ?? 'script-initialization';
            const reason = /picker-reason:(Picker closed unexpectedly|Picker ownership changed|Picker is ambiguous|Owned picker did not open|Picker path input is unavailable|Picker path readback failed|Picker confirmation is unavailable|Picker did not close|Import confirmation is unavailable|Import confirmation differs|uia-method|script-error)\b/.exec(stderr)?.[1] ?? 'unreported';
            const errorType = /picker-error:([A-Za-z]{1,80});picker-line:([0-9]{1,4})\b/.exec(stderr);
            const detail = errorType ? `, ${errorType[1]} at script line ${errorType[2]}` : '';
            const observed = /picker-owned:((?:[0-9]{1,20}:[0-9]{1,10}:(?:dialog|other):(?:picker|confirmation|location-unavailable|other),?){0,16})(?:\r?\n|$)/.exec(stderr);
            const windows = observed ? `, owned:${observed[1] || 'none'}` : '';
            const nativeButtons = /picker-native-buttons:((?:-?[0-9]{1,10}:(?:expected|cancel|other):[01],?){0,16})(?:\r?\n|$)/.exec(stderr);
            const candidates = nativeButtons ? `, nativeButtons:${nativeButtons[1] || 'none'}` : '';
            reject(new Error(`Owned native ${kind} selection failed at ${stage} (${reason}${detail}${windows}${candidates}); no global input or alternate target was used`));
          } else accept();
        });
      child.stdin?.end(JSON.stringify({ pid: this.versions!.pid, mainHandle, executable, path: absolutePath, kind, pickerTitle, confirmation }));
    });
  }

  async enterLocalApp(): Promise<void> {
    await this.page.getByRole('button', { name: /^(本地进入|离线进入|Continue locally|Continue with local features)$/i }).click({ timeout: UI_TIMEOUT_MS });
    await this.page.locator('main').waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
  }

  async activateLicense(key: string): Promise<void> {
    if (!this.activation || this.recording || !this.primaryWindow) throw new Error('License setup requires a non-recording activation session');
    const page = this.primaryWindow;
    try {
      const receipt = await this.licenseReceipt();
      if (receipt.state === 'granted' && receipt.hasStoredKey && receipt.hasUsableCache && receipt.valid) {
        await this.log('dedicated profile already licensed; no activation submitted');
        return;
      }
      await page.getByRole('button', { name: /^(本地进入|离线进入|Continue locally|Continue with local features)$/i }).click();
      const input = page.locator('#settings-license-key');
      await input.fill(key, { timeout: UI_TIMEOUT_MS });
      await page.getByRole('button', { name: /^(Activate|激活)$/ }).click();
      await page.locator('[data-testid="settings-page"] [role="status"]').filter({ hasText: /^(Granted|已授权)$/ }).waitFor({ timeout: 20_000 });
      const activated = await this.licenseReceipt();
      if (activated.state !== 'granted' || !activated.hasStoredKey || !activated.hasUsableCache || !activated.valid || activated.source !== 'server') {
        throw new Error('License server success and durable storage were not confirmed');
      }
      await writeFile(join(this.evidenceRoot, 'license.json'), JSON.stringify(activated, null, 2));
    } catch {
      this.hasFailed = true;
      // Playwright errors can include fill arguments; never retain their message or cause.
      throw new Error('Dedicated profile activation failed; no secret-bearing diagnostics were recorded');
    } finally {
      const input = page.locator('#settings-license-key');
      if (await input.isVisible().catch(() => false)) await input.fill('').catch(() => undefined);
    }
  }

  async licenseReceipt(): Promise<{ state: string; hasStoredKey: boolean; hasUsableCache: boolean; valid: boolean; source?: string }> {
    if (!this.primaryWindow) throw new Error('E2E Electron window is not ready');
    return this.primaryWindow.evaluate(async () => {
      const bridge = (window as unknown as {
        electron: { ipcRenderer: { invoke(channel: string, request: unknown): Promise<unknown> } };
      }).electron;
      const envelope = await bridge.ipcRenderer.invoke('hostapi:fetch', {
        requestId: crypto.randomUUID(), path: '/api/license/gate', method: 'GET',
      }) as { ok: boolean; data?: { status: number; json: {
        state: string; hasStoredKey: boolean; hasUsableCache: boolean;
        lastValidation: { valid: boolean; source?: string } | null;
      } } };
      if (!envelope.ok || envelope.data?.status !== 200) throw new Error('License receipt is unavailable');
      const gate = envelope.data.json;
      return { state: gate.state, hasStoredKey: gate.hasStoredKey, hasUsableCache: gate.hasUsableCache,
        valid: gate.lastValidation?.valid === true, source: gate.lastValidation?.source };
    });
  }

  async fetchHostApi(request: {
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    timeoutMs?: number;
  }): Promise<PublicHostApiReply> {
    if (!request.path.startsWith('/api/')) throw new Error('E2E Host API requests require a public /api/ path');
    return this.page.evaluate(async request => {
      const bridge = (window as unknown as {
        electron: { ipcRenderer: { invoke(channel: string, request: unknown): Promise<PublicHostApiReply> } };
      }).electron.ipcRenderer;
      return bridge.invoke('hostapi:fetch', { requestId: crypto.randomUUID(), timeoutMs: 30_000, ...request });
    }, request);
  }

  async connectBrowser(): Promise<Browser> {
    try {
      const activePortFile = join(this.profileRoot, 'user-data', 'DevToolsActivePort');
      const [portText, browserPath] = (await readFile(activePortFile, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portText);
      if (!/^\d+$/.test(portText ?? '') || !Number.isInteger(port) || port < 1 || port > 65_535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath ?? '')) {
        throw new Error(`Invalid owned Electron DevToolsActivePort at ${activePortFile}`);
      }
      this.connectedBrowser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${browserPath}`, { timeout: UI_TIMEOUT_MS, noDefaults: true });
      if (this.connectedBrowser.version() !== this.versions?.chromium) {
        throw new Error('CDP browser version does not match the owned Electron Chromium version');
      }
      return this.connectedBrowser;
    } catch (error) {
      this.hasFailed = true;
      throw error;
    }
  }

  async disconnectBrowser(): Promise<void> {
    // PW 1.64 CDP browserProcess.close closes this transport, not Browser.close.
    try {
      await this.connectedBrowser?.close();
      this.connectedBrowser = undefined;
    } catch (error) {
      this.hasFailed = true;
      throw error;
    }
  }

  async withPrivateInput(action: () => Promise<void>): Promise<void> {
    if (!this.app || !this.recording) throw new Error('Private UI input requires the owned recording session');
    await this.app.context().tracing.stop();
    this.recording = false;
    let failed = false;
    try { await action(); }
    catch { failed = true; }
    const fields = this.page.locator('input[type="password"]');
    try {
      if (await fields.evaluateAll(elements => elements.some(element => (element as HTMLInputElement).value !== ''))) {
        throw new Error('Private input was not cleared');
      }
    } catch { throw new Error('Private UI input cleanup was not confirmed; recording remains disabled'); }
    await this.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    await this.app.context().tracing.startChunk({ title: 'After private UI input' });
    this.recording = true;
    if (failed) throw new Error('Private UI input was not confirmed; secret-bearing diagnostics omitted, no resubmission');
  }

  async beginScenario(info: TestInfo): Promise<void> {
    if (!this.app) throw new Error('E2E Electron app is not ready');
    const observed = await this.app.evaluate(({ app }) => ({ pid: process.pid, userData: app.getPath('userData'), cwd: process.cwd() }));
    if (observed.pid !== this.versions?.pid || resolve(observed.userData) !== resolve(this.versions.userData)
      || resolve(observed.cwd) !== appProjectRoot) {
      this.hasFailed = true;
      throw new Error('Shared Electron identity changed between scenarios');
    }
    await this.app.context().tracing.startChunk({ title: info.title });
    await info.attach('shared-electron-session', {
      body: JSON.stringify({ ...this.versions, ...observed, profileRoot: this.profileRoot, main: electronMain }),
      contentType: 'application/json',
    });
  }

  async endScenario(info: TestInfo): Promise<void> {
    if (!this.app || !this.recording) return;
    if (info.status !== info.expectedStatus) {
      this.hasFailed = true;
      await this.log(`scenario ${info.title} status=${info.status}`);
      const failures: unknown[] = [];
      try {
        const screenshot = info.outputPath('electron-failure.png');
        await this.primaryWindow?.screenshot({ path: screenshot, fullPage: true, timeout: 5_000 });
        if (this.primaryWindow) await info.attach('electron-screenshot', { path: screenshot, contentType: 'image/png' });
      } catch (error) { failures.push(error); }
      try {
        const trace = info.outputPath('electron-trace.zip');
        await this.app.context().tracing.stopChunk({ path: trace });
        await info.attach('electron-trace', { path: trace, contentType: 'application/zip' });
      } catch (error) { failures.push(error); }
      await this.logWrites;
      const logs = info.outputPath('electron.log');
      await copyFile(this.logPath, logs);
      await info.attach('electron-logs', { path: logs, contentType: 'text/plain' });
      if (failures.length) await info.attach('electron-evidence-errors', { body: failures.map(String).join('\n'), contentType: 'text/plain' });
      return;
    }
    await this.app.context().tracing.stopChunk();
    const screenshot = info.outputPath('electron.png');
    await this.page.screenshot({ path: screenshot, timeout: 5_000 });
    await info.attach('electron-screenshot', { path: screenshot, contentType: 'image/png' });
  }

  async close(): Promise<void> {
    try {
      await this.disconnectBrowser();
    } finally {
      try {
        if (this.app) {
          const app = this.app;
          const child = app.process();
          const exited = child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>(accept => child.once('exit', () => accept()));
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (async () => { await app.close(); await exited; })(),
              new Promise<never>((_, reject) => {
                closeTimer = setTimeout(() => reject(new Error(`Owned Electron process did not exit; profile retained at ${this.profileRoot}`)), 35_000);
              }),
            ]);
            this.processExited = true;
            await writeFile(join(this.evidenceRoot, 'exit.json'), JSON.stringify({
              pid: this.versions?.pid, launcherPid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
            }, null, 2));
            if (child.exitCode !== 0 || child.signalCode !== null) {
              throw new Error(`Owned Electron exited abnormally: code=${child.exitCode} signal=${child.signalCode}`);
            }
          } catch (error) {
            this.hasFailed = true;
            await this.log(`close failed: ${String(error)}`);
            throw error;
          } finally {
            clearTimeout(closeTimer);
            this.app = undefined;
            await this.logWrites;
          }
        }
        if (profileMode === 'unlicensed' && !this.hasFailed) {
          await this.log('owned Electron exited; removing temporary profile');
          await rm(this.profileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        }
      } finally {
        if (this.profileLock && this.processExited) {
          await this.profileLock.close();
          await rm(join(this.profileRoot, '.owner.lock'));
          this.profileLock = undefined;
        }
      }
    }
  }
}
