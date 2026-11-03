export function assertDesignNative(input, platform, arch, name) {
  const bytes = input && Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const library = name === 'skia.node' || name.endsWith('.dll');
  let valid = false;
  if (bytes?.length >= 64 && ['x64', 'arm64'].includes(arch)) {
    if (platform === 'win32' && bytes.readUInt16LE(0) === 0x5a4d) {
      const offset = bytes.readUInt32LE(0x3c);
      valid = offset >= 64 && offset + 26 <= bytes.length
        && bytes.readUInt32LE(offset) === 0x4550
        && bytes.readUInt16LE(offset + 4) === (arch === 'x64' ? 0x8664 : 0xaa64)
        && (bytes.readUInt16LE(offset + 22) & 0x2002) === (library ? 0x2002 : 0x0002)
        && bytes.readUInt16LE(offset + 24) === 0x20b;
    } else if (platform === 'darwin') {
      valid = bytes.readUInt32LE(0) === 0xfeedfacf
        && bytes.readUInt32LE(4) === (arch === 'x64' ? 0x01000007 : 0x0100000c)
        && (library ? [6, 8] : [2]).includes(bytes.readUInt32LE(12));
    } else if (platform === 'linux') {
      valid = bytes.readUInt32BE(0) === 0x7f454c46 && bytes[4] === 2 && bytes[5] === 1
        && (library ? [3] : [2, 3]).includes(bytes.readUInt16LE(16))
        && bytes.readUInt16LE(18) === (arch === 'x64' ? 62 : 183);
    }
  }
  if (!valid) throw new Error(`Invalid Design ${platform}-${arch} native dependency: ${name}. Supply the actual target binary; host binaries are not interchangeable.`);
}
