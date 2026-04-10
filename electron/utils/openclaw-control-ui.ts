/**
 * 构建 OpenClaw Control UI 地址。
 *
 * 使用 URL fragment 传递一次性 token，避免 query 参数在 UI 初始化流程中丢失。
 */
export function buildOpenClawControlUiUrl(port: number, token: string): string {
  const url = new URL(`http://127.0.0.1:${port}/`);
  const trimmedToken = token.trim();

  if (trimmedToken) {
    url.hash = new URLSearchParams({ token: trimmedToken }).toString();
  }

  return url.toString();
}
