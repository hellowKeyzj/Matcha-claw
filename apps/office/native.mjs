import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputRoot = join(dirname(fileURLToPath(import.meta.url)), '../../build/office-native');

export function officeNativeDirectory(platform, arch) {
  return join(outputRoot, `${platform}-${arch}`);
}

export function officeSidecarName(platform) {
  return platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar';
}

export function officeOcrHelperName(platform) {
  return platform === 'win32' ? 'win-ocr.exe' : platform === 'darwin' ? 'vision-ocr' : undefined;
}

function isPortableWindowsOcr(bytes, offset) {
  const optional = offset + 24;
  if (bytes.readUInt16LE(offset + 4) !== 0x14c || bytes.readUInt16LE(optional) !== 0x10b) return false;
  const optionalSize = bytes.readUInt16LE(offset + 20);
  if (optionalSize < 216 || optional + optionalSize > bytes.length) return false;
  const clrRva = bytes.readUInt32LE(optional + 208);
  const clrSize = bytes.readUInt32LE(optional + 212);
  if (!clrRva || clrSize < 20) return false;
  const sections = bytes.readUInt16LE(offset + 6);
  for (let index = 0; index < sections; index++) {
    const section = optional + optionalSize + index * 40;
    if (section + 40 > bytes.length) return false;
    const address = bytes.readUInt32LE(section + 12);
    const size = bytes.readUInt32LE(section + 16);
    if (clrRva < address || clrRva - address + 20 > size) continue;
    const header = bytes.readUInt32LE(section + 20) + clrRva - address;
    if (header + 20 > bytes.length) return false;
    const flags = bytes.readUInt32LE(header + 16);
    // The system OCR helper is AnyCPU IL, not an x86 native executable.
    return (flags & 0x20013) === 1;
  }
  return false;
}

function matchesMachO(bytes, cpu, library) {
  if (bytes.length < 64) return false;
  const magic = bytes.readUInt32LE(0);
  if (magic === 0xfeedfacf) {
    return bytes.readUInt32LE(4) === cpu
      && (library ? [6, 8] : [2]).includes(bytes.readUInt32LE(12));
  }
  const fatMagic = bytes.readUInt32BE(0);
  const fat64 = fatMagic === 0xcafebabf || fatMagic === 0xbfbafeca;
  const swapped = fatMagic === 0xbebafeca || fatMagic === 0xbfbafeca;
  if (!fat64 && fatMagic !== 0xcafebabe && fatMagic !== 0xbebafeca) return false;
  const uint32 = (offset) => swapped ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const uint64 = (offset) => Number(swapped ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset));
  const count = uint32(4);
  const stride = fat64 ? 32 : 20;
  if (!count || 8 + count * stride > bytes.length) return false;
  let found = false;
  for (let index = 0; index < count; index++) {
    const record = 8 + index * stride;
    const sliceCpu = uint32(record);
    const offset = fat64 ? uint64(record + 8) : uint32(record + 8);
    const size = fat64 ? uint64(record + 16) : uint32(record + 12);
    if (![0x01000007, 0x0100000c].includes(sliceCpu)
      || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
      || offset < 8 + count * stride || size < 64 || offset + size > bytes.length) return false;
    const slice = bytes.subarray(offset, offset + size);
    if (slice.readUInt32LE(0) !== 0xfeedfacf || !matchesMachO(slice, sliceCpu, library)) return false;
    if (sliceCpu === cpu) found = true;
  }
  return found;
}

export function assertOfficeNative(input, platform, arch, name) {
  const bytes = input && Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const library = /\.(?:node|dll|dylib)$|\.so(?:\.|$)/.test(name);
  let valid = false;
  if (bytes?.length >= 64 && ['x64', 'arm64'].includes(arch)) {
    if (platform === 'win32' && bytes.readUInt16LE(0) === 0x5a4d) {
      const offset = bytes.readUInt32LE(0x3c);
      if (offset >= 64 && offset + 26 <= bytes.length && bytes.readUInt32LE(offset) === 0x4550
        && (bytes.readUInt16LE(offset + 22) & 0x2002) === (library ? 0x2002 : 0x0002)) {
        valid = name === 'win-ocr.exe' && isPortableWindowsOcr(bytes, offset);
        valid ||= bytes.readUInt16LE(offset + 4) === (arch === 'x64' ? 0x8664 : 0xaa64)
          && bytes.readUInt16LE(offset + 24) === 0x20b;
      }
    } else if (platform === 'darwin') {
      valid = matchesMachO(bytes, arch === 'x64' ? 0x01000007 : 0x0100000c, library);
    } else if (platform === 'linux') {
      valid = bytes.readUInt32BE(0) === 0x7f454c46 && bytes[4] === 2 && bytes[5] === 1
        && (library ? [3] : [2, 3]).includes(bytes.readUInt16LE(16))
        && bytes.readUInt16LE(18) === (arch === 'x64' ? 62 : 183);
    }
  }
  if (!valid) throw new Error(`Invalid Office ${platform}-${arch} native binary: ${name}. Supply the actual target binary.`);
}
