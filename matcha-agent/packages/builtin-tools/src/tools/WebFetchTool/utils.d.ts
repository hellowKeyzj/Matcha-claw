import { type AxiosResponse } from 'axios'
export declare function clearWebFetchCache(): void
export declare const MAX_MARKDOWN_LENGTH = 100000
export declare function isPreapprovedUrl(url: string): boolean
export declare function validateURL(url: string): boolean
type DomainCheckResult =
  | {
      status: 'allowed'
    }
  | {
      status: 'blocked'
    }
  | {
      status: 'check_failed'
      error: Error
    }
export declare function checkDomainBlocklist(
  domain: string,
): Promise<DomainCheckResult>
/**
 * Check if a redirect is safe to follow
 * Allows redirects that:
 * - Add or remove "www." in the hostname
 * - Keep the origin the same but change path/query params
 * - Or both of the above
 */
export declare function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean
/**
 * Helper function to handle fetching URLs with custom redirect handling
 * Recursively follows redirects if they pass the redirectChecker function
 *
 * Per PSR:
 * "Do not automatically follow redirects because following redirects could
 * allow for an attacker to exploit an open redirect vulnerability in a
 * trusted domain to force a user to make a request to a malicious domain
 * unknowingly"
 */
type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}
export declare function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth?: number,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo>
export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}
export declare function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo>
export declare function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string>
export {}
