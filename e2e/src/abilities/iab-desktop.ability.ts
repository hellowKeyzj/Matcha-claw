import { Ability } from '@serenity-js/core';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { UseElectron } from './use-electron.ability.js';

type WindowBounds = { left: number; top: number; width: number; height: number; windowState: string };

async function beforeDeadline<T>(operation: Promise<T>, deadline: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`IAB desktop timed out at ${stage} (15s operation budget)`)), Math.max(0, deadline - Date.now()));
    })]);
    if (Date.now() >= deadline) throw new Error(`IAB desktop deadline expired at ${stage} (15s operation budget)`);
    return result;
  } finally { clearTimeout(timer); }
}

const nativeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadLine() | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class IabDesktopWindow {
  public struct Rect { public int Left, Top, Right, Bottom; }
  public struct Point { public int X, Y; public Point(int x, int y) { X = x; Y = y; } }
  delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  public struct LastInput { public uint Size, Tick; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
  public static void Activate(IntPtr window, uint pid) {
    if (!IsMain(window, pid) || !IsWindowEnabled(window) || IsIconic(window))
      throw new Exception("Activation requires the exact visible enabled owned window");
    if (GetForegroundWindow() == window) return;
    if (SetForegroundWindow(window) && GetForegroundWindow() == window) return;
    var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
    if (!GetLastInputInfo(ref input) || unchecked((uint)Environment.TickCount - input.Tick) < 1500)
      throw new Exception("Desktop is receiving recent input; owned foreground activation was refused and no mouse input was sent");
    if (!SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0x13))
      throw new Exception("Cannot expose the owned window caption without changing its geometry");
    if (DwmFlush() != 0) throw new Exception("Cannot flush owned caption composition before hit testing");
    var frame = Frame(window);
    int x = frame.Left + frame.Width / 2, y = frame.Top + 20;
    var pointRoot = GetAncestor(WindowFromPoint(new Point(x, y)), 2);
    UIntPtr hit;
    long position = (ushort)x | ((long)(ushort)y << 16);
    var queried = SendMessageTimeout(window, 0x84, UIntPtr.Zero, new IntPtr(position), 3, 250, out hit);
    if (pointRoot != window || queried == IntPtr.Zero || hit.ToUInt64() != 2)
      throw new Exception("Exact owned caption verification failed; no click was sent: owned=" + window +
        ", pointRoot=" + pointRoot + ", query=" + queried + ", hit=" + hit + ", frame=" + frame);
    Point previous;
    if (!GetCursorPos(out previous)) throw new Exception("Cannot read cursor before owned caption activation");
    try {
      if (!SetCursorPos(x, y) || !IsMain(window, pid) || GetAncestor(WindowFromPoint(new Point(x, y)), 2) != window)
        throw new Exception("Owned caption changed before activation; no click was sent");
      mouse_event(2, 0, 0, 0, UIntPtr.Zero);
      mouse_event(4, 0, 0, 0, UIntPtr.Zero);
      var until = DateTime.UtcNow.AddMilliseconds(400);
      while (GetForegroundWindow() != window && DateTime.UtcNow < until) Thread.Sleep(10);
      AssertForeground(window, pid);
    } finally { SetCursorPos(previous.X, previous.Y); }
  }
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter, IntPtr position, uint flags, uint timeout, out UIntPtr result);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect rectangle, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int ReadCloaked(IntPtr window, uint attribute, out int cloaked, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Arguments(string command) {
    int count;
    var memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new Exception("Cannot parse owned process command line");
    try {
      var arguments = new string[count];
      for (int i = 0; i < count; ++i) arguments[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return arguments;
    } finally { LocalFree(memory); }
  }
  public static bool IsMain(IntPtr window, uint expectedPid) {
    uint actual;
    GetWindowThreadProcessId(window, out actual);
    var name = new StringBuilder(256);
    GetClassName(window, name, name.Capacity);
    return actual == expectedPid && IsWindowVisible(window) && GetAncestor(window, 2) == window &&
      GetWindow(window, 4) == IntPtr.Zero && name.ToString() == "Chrome_WidgetWin_1";
  }
  public static IntPtr[] MainWindows(uint pid) {
    var matches = new List<IntPtr>();
    EnumWindows((window, parameter) => { if (IsMain(window, pid)) matches.Add(window); return true; }, IntPtr.Zero);
    return matches.ToArray();
  }
  public static Rect Bounds(IntPtr window) {
    Rect rectangle;
    if (!GetWindowRect(window, out rectangle)) throw new Exception("GetWindowRect failed");
    return rectangle;
  }
  public static Rectangle Frame(IntPtr window) {
    Rect rectangle;
    // DWM excludes invisible resize margins; GetWindowRect includes pixels from behind the window.
    if (DwmGetWindowAttribute(window, 9, out rectangle, Marshal.SizeOf(typeof(Rect))) != 0)
      throw new Exception("Cannot obtain the complete visible DWM window frame");
    return Rectangle.FromLTRB(rectangle.Left, rectangle.Top, rectangle.Right, rectangle.Bottom);
  }
  public static void AssertForeground(IntPtr window, uint pid) {
    var foreground = GetForegroundWindow();
    uint foregroundPid;
    GetWindowThreadProcessId(foreground, out foregroundPid);
    bool main = IsMain(window, pid), enabled = IsWindowEnabled(window), minimized = IsIconic(window);
    if (!main || !enabled || minimized || foreground != window)
      throw new Exception("Exact owned main HWND is not the enabled foreground window: owned=" + window +
        ", pid=" + pid + ", main=" + main + ", enabled=" + enabled + ", minimized=" + minimized +
        ", foreground=" + foreground + ", foregroundPid=" + foregroundPid);
  }
  public static void AssertUncovered(IntPtr window, Rectangle frame) {
    for (var above = GetWindow(window, 3); above != IntPtr.Zero; above = GetWindow(above, 3)) {
      if (!IsWindowVisible(above) || IsIconic(above)) continue;
      int cloaked;
      if (ReadCloaked(above, 14, out cloaked, sizeof(int)) != 0)
        throw new Exception("Cannot establish whether an overlapping window is cloaked");
      if (cloaked != 0) continue;
      if (Frame(above).IntersectsWith(frame)) throw new Exception("Another visible window overlaps the owned capture rectangle");
    }
  }
  public static void DragCorner(IntPtr window, uint pid, long started, int dx, int dy) {
    AssertForeground(window, pid);
    if (IsZoomed(window)) throw new Exception("Owned window is maximized; real border dragging requires a normal window");
    var rectangle = Bounds(window);
    int x = rectangle.Right - 3, y = rectangle.Bottom - 3;
    if (!SetCursorPos(x, y) || GetAncestor(WindowFromPoint(new Point(x, y)), 2) != window)
      throw new Exception("Owned lower-right resize border is not exposed");
    UIntPtr hit;
    long position = (ushort)x | ((long)(ushort)y << 16);
    if (SendMessageTimeout(window, 0x84, UIntPtr.Zero, new IntPtr(position), 3, 250, out hit) == IntPtr.Zero || hit.ToUInt64() != 17)
      throw new Exception("Owned lower-right border does not report HTBOTTOMRIGHT; no mouse button was pressed");
    try {
      AssertForeground(window, pid);
      mouse_event(2, 0, 0, 0, UIntPtr.Zero);
      for (int step = 1; step <= 8; ++step) {
        AssertForeground(window, pid);
        using (var process = Process.GetProcessById((int)pid)) {
          if (process.StartTime.ToUniversalTime().Ticks != started) throw new Exception("Owned process start time changed during drag");
        }
        if (!SetCursorPos(x + dx * step / 8, y + dy * step / 8)) throw new Exception("SetCursorPos failed during real border drag");
        Thread.Sleep(20);
      }
    } finally { mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
    Thread.Sleep(100);
  }
}
'@ -ReferencedAssemblies System.Drawing
$stage = 'process-identity'
$dpiContext = [IntPtr]::Zero
$inputDeadline = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.deadline).UtcDateTime.AddMilliseconds(-750)
function Assert-TimeRemaining([int]$milliseconds) {
  if ([DateTime]::UtcNow.AddMilliseconds($milliseconds) -ge $inputDeadline) { throw 'Native desktop deadline leaves insufficient time for safe OS input and restoration' }
}
try {
  $native = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$request.pid)
  $process = Get-Process -Id $request.pid
  $executable = [string]$native.ExecutablePath
  $started = $process.StartTime.ToUniversalTime().Ticks
  # CIM CreationDate has microsecond precision; Get-Process retains the final 100ns digit.
  $arguments = @([IabDesktopWindow]::Arguments([string]$native.CommandLine))
  $userDataArguments = @($arguments | Where-Object { $_ -like '--user-data-dir=*' })
  if ($null -eq $native -or [int]$native.ProcessId -ne [int]$request.pid -or
      [IO.Path]::GetFileName($executable) -ine 'electron.exe' -or $process.Path -ine $executable -or
      [Math]::Abs($native.CreationDate.ToUniversalTime().Ticks - $started) -gt 9 -or $arguments[0] -ine $executable -or
      $userDataArguments.Count -ne 1 -or $userDataArguments[0] -ine ('--user-data-dir=' + $request.userData) -or
      @($arguments | Where-Object { $_ -ieq $request.main }).Count -ne 1) {
    throw 'Win32_Process does not match this run PID, executable, start time, userData and main entry'
  }
  $stage = 'window-discovery'
  $windows = @([IabDesktopWindow]::MainWindows([uint32]$request.pid) | Where-Object { $_.ToInt64().ToString() -ceq [string]$request.handle })
  if ($windows.Count -ne 1) { throw 'Exact Electron BrowserWindow handle is not a visible owned root Chrome_WidgetWin_1 HWND' }
  $window = $windows[0]
  function Assert-Owned {
    $current = Get-Process -Id $request.pid
    if ($current.StartTime.ToUniversalTime().Ticks -ne $started -or $current.Path -ine $executable -or
        -not [IabDesktopWindow]::IsMain($window, [uint32]$request.pid)) { throw 'Owned HWND or process identity changed' }
  }
  function Enter-OwnedForeground {
    Assert-TimeRemaining 500
    Assert-Owned
    if ([IabDesktopWindow]::IsIconic($window)) { throw 'Owned main window is minimized; desktop capture/drag is unavailable' }
    [IabDesktopWindow]::Activate($window, [uint32]$request.pid)
    $until = [DateTime]::UtcNow.AddMilliseconds(400)
    while ([IabDesktopWindow]::GetForegroundWindow() -ne $window -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 25 }
    [IabDesktopWindow]::AssertForeground($window, [uint32]$request.pid)
  }
  $dpiContext = [IabDesktopWindow]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
  if ($dpiContext -eq [IntPtr]::Zero) { throw 'Cannot establish physical-pixel DPI coordinates' }
  function Save-OwnedFrame([string]$path) {
    Assert-TimeRemaining 750
    Assert-Owned
    [IabDesktopWindow]::AssertForeground($window, [uint32]$request.pid)
    if ([IabDesktopWindow]::DwmFlush() -ne 0) { throw 'DWM composition flush failed' }
    $frame = [IabDesktopWindow]::Frame($window)
    if ($frame.Width -le 0 -or $frame.Height -le 0 -or
        @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Contains($frame) }).Count -eq 0) {
      throw 'Complete owned window frame is not contained in one physical display; no screen pixels were read'
    }
    [IabDesktopWindow]::AssertUncovered($window, $frame)
    $bitmap = $null; $graphics = $null; $file = $null
    try {
      $bitmap = [System.Drawing.Bitmap]::new($frame.Width, $frame.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      Assert-Owned
      [IabDesktopWindow]::AssertForeground($window, [uint32]$request.pid)
      $graphics.CopyFromScreen($frame.Location, [System.Drawing.Point]::Empty, $frame.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
      [IabDesktopWindow]::AssertForeground($window, [uint32]$request.pid)
      if ([IabDesktopWindow]::Frame($window) -ne $frame) { throw 'Owned frame moved during composite capture' }
      [IabDesktopWindow]::AssertUncovered($window, $frame)
      $file = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      if ($null -ne $file) { $file.Dispose() }
      if ($null -ne $graphics) { $graphics.Dispose() }
      if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
  }
  $stage = 'foreground'
  Enter-OwnedForeground
  if ($request.operation -eq 'capture') {
    $stage = 'composite-capture'
    Save-OwnedFrame ([string]$request.capturePath)
  } else {
    if ([IabDesktopWindow]::IsZoomed($window)) { throw 'Owned window is maximized; real border dragging requires a normal window' }
    $original = [IabDesktopWindow]::Bounds($window)
    $frame = [IabDesktopWindow]::Frame($window)
    if (@([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Contains($frame) }).Count -eq 0) {
      throw 'Owned window must fit one physical display before border dragging'
    }
    $failures = [System.Collections.Generic.List[string]]::new()
    try {
      $stage = 'shrink-drag'
      Assert-TimeRemaining 5000
      Assert-Owned
      [IabDesktopWindow]::DragCorner($window, [uint32]$request.pid, $started, -80, -60)
      $shrunk = [IabDesktopWindow]::Bounds($window)
      if ($shrunk.Left -ne $original.Left -or $shrunk.Top -ne $original.Top -or
          [Math]::Abs(($original.Right - $shrunk.Right) - 80) -gt 4 -or
          [Math]::Abs(($original.Bottom - $shrunk.Bottom) - 60) -gt 4) {
        throw 'Real border drag did not shrink the owned window by approximately 80x60 physical pixels (minimum size or border limitation)'
      }
      $stage = 'resized-composite'
      Save-OwnedFrame ([string]$request.resizedPath)
      [Console]::Out.WriteLine('iab-desktop-resized')
      [Console]::Out.Flush()
      $stage = 'cdp-shrink-confirmation'
      $reply = [Console]::In.ReadLineAsync()
      if (-not $reply.Wait(2000) -or $reply.Result -cne 'restore') { throw 'CDP did not confirm the shrunken bounds within 2s; restoring owned window' }
    } catch { $failures.Add($stage + ': ' + $_.Exception.Message) }
    finally {
      try {
        $stage = 'restore-drag'
        Enter-OwnedForeground
        $current = [IabDesktopWindow]::Bounds($window)
        if ($current.Left -ne $original.Left -or $current.Top -ne $original.Top) { throw 'Owned window position changed; refusing an unrelated restoration drag' }
        if ($current.Right -ne $original.Right -or $current.Bottom -ne $original.Bottom) {
          Assert-TimeRemaining 750
          [IabDesktopWindow]::DragCorner($window, [uint32]$request.pid, $started, $original.Right - $current.Right, $original.Bottom - $current.Bottom)
        }
        $restored = [IabDesktopWindow]::Bounds($window)
        if ($restored.Left -ne $original.Left -or $restored.Top -ne $original.Top -or
            $restored.Right -ne $original.Right -or $restored.Bottom -ne $original.Bottom) { throw 'Reverse OS border drag did not restore the original physical window rectangle' }
        $stage = 'restored-composite'
        Save-OwnedFrame ([string]$request.restoredPath)
      } catch { $failures.Add($stage + ': ' + $_.Exception.Message) }
    }
    if ($failures.Count -gt 0) { throw ($failures -join '; ') }
  }
} catch {
  [Console]::Error.WriteLine('iab-desktop-stage:' + $stage + '; ' + $_.Exception.Message)
  exit 1
} finally {
  if ($dpiContext -ne [IntPtr]::Zero) { [void][IabDesktopWindow]::SetThreadDpiAwarenessContext($dpiContext) }
}
`;

export class IabDesktop extends Ability {
  constructor(private readonly electron: UseElectron) { super(); }

  async capture(name: string): Promise<void> {
    const capturePath = this.capturePath(name);
    await this.withOwnedWindow(async (_readBounds, _initial, request, deadline) => {
      await this.runNative({ ...request, operation: 'capture', capturePath }, deadline);
    });
  }

  async resizeAndRestore(): Promise<void> {
    const stamp = Date.now();
    const resizedPath = this.capturePath(`iab-window-${stamp}-resized`);
    const restoredPath = this.capturePath(`iab-window-${stamp}-restored`);
    await this.withOwnedWindow(async (readBounds, initial, request, deadline) => {
      if (initial.windowState !== 'normal') throw new Error(`Real OS border dragging requires a normal window; CDP windowState=${initial.windowState}`);
      const failures: unknown[] = [];
      try {
        await this.runNative({ ...request, operation: 'resize', resizedPath, restoredPath }, deadline, async () => {
          const shrunk = await readBounds();
          if (shrunk.windowState !== 'normal' || shrunk.width >= initial.width || shrunk.height >= initial.height
            || shrunk.left !== initial.left || shrunk.top !== initial.top) {
            throw new Error(`CDP did not confirm shrink after real OS border drag: initial=${JSON.stringify(initial)}, observed=${JSON.stringify(shrunk)}`);
          }
        });
      } catch (error) { failures.push(error); }
      try {
        const restored = await readBounds();
        if (Object.entries(initial).some(([key, value]) => restored[key as keyof WindowBounds] !== value)) {
          throw new Error(`CDP did not confirm original bounds after reverse OS drag: initial=${JSON.stringify(initial)}, observed=${JSON.stringify(restored)}`);
        }
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'IAB real window resize/restoration failed');
    });
  }

  private capturePath(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}(?:\.png)?$/.test(name)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.png)?$/i.test(name)
      || !isAbsolute(this.electron.outputDirectory)) {
      throw new Error('Composite capture requires a safe PNG basename and this run absolute outputDirectory');
    }
    return join(this.electron.outputDirectory, name.endsWith('.png') ? name : `${name}.png`);
  }

  private async withOwnedWindow(action: (
    readBounds: () => Promise<WindowBounds>, initial: WindowBounds, request: Record<string, unknown>, deadline: number,
  ) => Promise<void>): Promise<void> {
    if (process.platform !== 'win32') throw new Error('IAB composed desktop capture and real border dragging require Windows');
    const deadline = Date.now() + 15_000;
    const workDeadline = deadline - 750;
    const session = JSON.parse(await beforeDeadline(readFile(join(this.electron.outputDirectory, 'session.json'), 'utf8'), workDeadline, 'owned session receipt')) as {
      pid: number; userData: string; profileRoot: string; main: string;
    };
    if (!Number.isSafeInteger(session.pid) || session.pid <= 0 || typeof session.main !== 'string' || !isAbsolute(session.main)
      || typeof session.userData !== 'string' || typeof session.profileRoot !== 'string'
      || resolve(session.profileRoot) !== resolve(this.electron.profileRoot)
      || resolve(session.userData) !== resolve(this.electron.profileRoot, 'user-data')) {
      throw new Error('IAB desktop session receipt does not identify this Electron owned PID/profile/main');
    }
    const window = await beforeDeadline(this.electron.desktopWindow(), workDeadline, 'owned Electron BrowserWindow');
    const readBounds = async () => {
      const current = await beforeDeadline(this.electron.desktopWindow(), workDeadline, 'owned window bounds');
      if (current.handle !== window.handle) throw new Error('Owned native window handle changed');
      return current.bounds;
    };
    await beforeDeadline(action(readBounds, window.bounds, {
      pid: session.pid, userData: session.userData, main: session.main, handle: window.handle,
    }, workDeadline), deadline, 'owned window operation');
  }

  private async runNative(request: Record<string, unknown>, deadline: number, onResized?: () => Promise<void>): Promise<void> {
    const timeout = deadline - Date.now();
    if (timeout < 7_000) throw new Error('Less than 7s remains for native desktop operation and guaranteed reverse drag; no OS input was started');
    await new Promise<void>((accept, reject) => {
      const failures: unknown[] = [];
      let output = '';
      let verification: Promise<void> | undefined;
      const child = execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', nativeScript], { timeout, maxBuffer: 8_192, windowsHide: true }, (error, _stdout, stderr) => {
          if (error) failures.push(new Error(`Owned Windows desktop helper failed: ${stderr.trim() || error.message}`, { cause: error }));
          if (onResized && !verification && !error) failures.push(new Error('Native helper exited without a real resize observation'));
          void (verification ?? Promise.resolve()).then(() => {
            if (failures.length) reject(new AggregateError(failures, 'IAB native desktop operation failed'));
            else accept();
          });
        });
      child.stdin?.on('error', error => { failures.push(error); });
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (!verification && onResized && /(?:^|\r?\n)iab-desktop-resized\r?\n/.test(output)) {
          verification = onResized().then(
            () => { child.stdin?.end('restore\n'); },
            error => { failures.push(error); child.stdin?.end('abort\n'); },
          );
        }
      });
      const input = `${JSON.stringify({ ...request, deadline })}\n`;
      if (onResized) child.stdin?.write(input);
      else child.stdin?.end(input);
    });
  }
}
