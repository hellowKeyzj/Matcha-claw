export function sessionStorageDirectoryName(sessionId: string): string {
  return `sid-${Buffer.from(sessionId, 'utf8').toString('base64url')}`
}
