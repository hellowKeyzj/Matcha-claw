import { notes } from '@serenity-js/core';

type SendReceipt = { admitted: boolean; hasRunId: boolean; completed: boolean; persisted: boolean };
type SessionNotes = {
  publicSessionCatalogReady: boolean;
  publicSessionCreation: { created: boolean; sessionKey: string };
  fixedPngStaged: boolean;
  publicTextReceipt: SendReceipt;
  publicPngReceipt: {
    receipt: SendReceipt;
    custody: { stagingPath: boolean; mediaReference: boolean; fullPng: boolean; pngPrefix: boolean };
  };
  publicPngReplay: { ok: boolean; status: number | null; httpOk: boolean; successIsFalse: boolean; fixedPublicError: boolean };
};

export const PublicSessionCatalogIsReady = () => notes<SessionNotes>().get('publicSessionCatalogReady');
export const PublicSessionWasCreated = () => notes<SessionNotes>().get('publicSessionCreation').created;
export const CreatedSessionKey = () => notes<SessionNotes>().get('publicSessionCreation').sessionKey;
export const FixedPngWasStaged = () => notes<SessionNotes>().get('fixedPngStaged');
export const PublicTextSendReceipt = () => notes<SessionNotes>().get('publicTextReceipt');
export const PublicPngSendReceipt = () => notes<SessionNotes>().get('publicPngReceipt').receipt;
export const PublicPngCustodyExposure = () => notes<SessionNotes>().get('publicPngReceipt').custody;
export const PublicPngReplayReceipt = () => notes<SessionNotes>().get('publicPngReplay');

