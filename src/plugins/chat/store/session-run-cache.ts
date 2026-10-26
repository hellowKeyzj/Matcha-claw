export interface StoreSessionRunCache {
  nextSendGeneration: (sessionKey: string) => number;
  getSendGeneration: (sessionKey: string) => number;
}

export function createStoreSessionRunCache(): StoreSessionRunCache {
  const sendGenerationBySession = new Map<string, number>();

  return {
    nextSendGeneration: (sessionKey) => {
      const nextGeneration = (sendGenerationBySession.get(sessionKey) ?? 0) + 1;
      sendGenerationBySession.set(sessionKey, nextGeneration);
      return nextGeneration;
    },
    getSendGeneration: (sessionKey) => sendGenerationBySession.get(sessionKey) ?? 0,
  };
}
