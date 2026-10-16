export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'openaiResponses'
  | 'gemini'
  | 'grok'

export function isThirdPartyAPIProvider(provider: APIProvider): boolean {
  return provider !== 'firstParty'
}
