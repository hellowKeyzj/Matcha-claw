import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export function isNativeExecutable(file, platform, arch) {
  if (!['x64', 'arm64'].includes(arch)) return false;
  let fd;
  try {
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 64) return false;
    if (platform !== 'win32' && process.platform !== 'win32' && !(stat.mode & 0o111)) return false;
    const header = Buffer.alloc(64);
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    if (platform === 'win32') {
      if (header.readUInt16LE(0) !== 0x5a4d) return false;
      const offset = header.readUInt32LE(0x3c);
      const pe = Buffer.alloc(26);
      if (offset < 64 || readSync(fd, pe, 0, pe.length, offset) !== pe.length) return false;
      return pe.readUInt32LE(0) === 0x4550
        && pe.readUInt16LE(4) === (arch === 'x64' ? 0x8664 : 0xaa64)
        && (pe.readUInt16LE(22) & 0x2002) === 0x0002
        && pe.readUInt16LE(24) === 0x20b;
    }
    if (platform === 'linux') {
      return header.readUInt32BE(0) === 0x7f454c46 && header[4] === 2 && header[5] === 1
        && [2, 3].includes(header.readUInt16LE(16))
        && header.readUInt16LE(18) === (arch === 'x64' ? 62 : 183);
    }
    if (platform === 'darwin') {
      return header.readUInt32LE(0) === 0xfeedfacf
        && header.readUInt32LE(4) === (arch === 'x64' ? 0x01000007 : 0x0100000c)
        && header.readUInt32LE(12) === 2;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
