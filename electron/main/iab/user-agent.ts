import { execFile } from 'node:child_process';
import { release } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
let windowsPlatformVersion = '0.0.0';
let ready: Promise<void> | undefined;

export function initializeIabUserAgent(): Promise<void> {
  return ready ??= (async () => {
    if (process.platform !== 'win32') return;
    try {
      const command = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'reg.exe');
      if (!isAbsolute(command)) throw new Error('Windows system reg.exe is unavailable');
      const { stdout } = await executeFile(command, [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\WindowsRuntime\\WellKnownContracts',
        '/v', 'Windows.Foundation.UniversalApiContract', '/reg:64',
      ], { timeout: 800, windowsHide: true, maxBuffer: 16_384 });
      const value = /^\s*Windows\.Foundation\.UniversalApiContract\s+REG_DWORD\s+(0x[0-9a-f]+)\s*$/im.exec(stdout)?.[1];
      const version = value === undefined ? 0 : Number(value);
      if (!Number.isInteger(version) || version <= 0 || version > 0xffff_ffff) throw new Error('Invalid Windows UniversalApiContract version');
      windowsPlatformVersion = `${version >>> 16}.${version & 0xffff}.0`;
    } catch {
      // Accio uses the OS build only when the native Windows contract version is unavailable.
      windowsPlatformVersion = Number(release().split('.')[2] ?? '0') >= 22_000 ? '15.0.0' : '13.0.0';
    }
  })();
}

function chromiumVersion(): string {
  return process.versions.chrome ?? process.versions.chromium ?? '0.0.0.0';
}

function brands(version: string, full = false): { brand: string; version: string }[] {
  const major = version.split('.')[0] ?? '0';
  const number = Number(major);
  const punctuation = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const grease = ['8', '99', '24'][number % 3];
  const result = [
    { brand: `Not${punctuation[number % punctuation.length]}A${punctuation[(number + 1) % punctuation.length]}Brand`, version: full ? `${grease}.0.0.0` : grease },
    { brand: 'Chromium', version: full ? version : major },
  ];
  return number % 2 === 0 ? result : result.reverse();
}

export function resolveIabUserAgentOverride() {
  const version = chromiumVersion();
  const mac = process.platform === 'darwin';
  let systemVersion: string | undefined;
  try { systemVersion = process.getSystemVersion?.(); } catch { /* OS version is optional. */ }
  const macVersion = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(systemVersion?.trim() ?? '');
  const platformVersion = mac
    ? macVersion ? `${macVersion[1]}.${macVersion[2] ?? '0'}.${macVersion[3] ?? '0'}` : '0.0.0'
    : process.platform === 'win32' ? windowsPlatformVersion : '0.0.0';
  return {
    userAgent: mac
      ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
      : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    platform: mac ? 'MacIntel' : 'Win32',
    userAgentMetadata: {
      brands: brands(version), fullVersionList: brands(version, true),
      platform: mac ? 'macOS' : 'Windows', platformVersion,
      architecture: mac && process.arch === 'arm64' ? 'arm' : 'x86',
      model: '', mobile: false, bitness: '64', wow64: false,
    },
  };
}

export function iabClientHintHeaders(): Record<string, string> {
  const metadata = resolveIabUserAgentOverride().userAgentMetadata;
  const serializeBrands = (entries: typeof metadata.brands) => entries.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', ');
  return {
    'sec-ch-ua': serializeBrands(metadata.brands),
    'sec-ch-ua-mobile': metadata.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': JSON.stringify(metadata.platform),
    'sec-ch-ua-full-version-list': serializeBrands(metadata.fullVersionList),
    'sec-ch-ua-full-version': JSON.stringify(chromiumVersion()),
    'sec-ch-ua-platform-version': JSON.stringify(metadata.platformVersion),
    'sec-ch-ua-arch': JSON.stringify(metadata.architecture),
    'sec-ch-ua-bitness': JSON.stringify(metadata.bitness),
    'sec-ch-ua-model': JSON.stringify(metadata.model),
    'sec-ch-ua-wow64': metadata.wow64 ? '?1' : '?0',
    'sec-ch-ua-form-factors': '"Desktop"',
  };
}
