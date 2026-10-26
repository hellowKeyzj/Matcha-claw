import { notes } from '@serenity-js/core';

type Policy = { revision: string; trustedNativeDigests: string[]; trustedProcessDigests: string[]; trustedPublishers: { publisher: string; keyId: string; publicKey: number[]; allowProcess: boolean; allowNative: boolean }[]; unsignedWasm: string };
type Draft = { roots: number; ownRoots: number; flags: boolean[]; previewCount: number; canSubmit: boolean; fullPreview: boolean };
type TrustNotes = {
  worldTrustBaseline: { policy: Policy; publisher: string; keyId: string; publicKey: string };
  worldTrustInvalid: { invalidHex: boolean; short: boolean; long: boolean; noDraft: boolean };
  worldTrustDraft: Draft;
  worldTrustDuplicate: Draft;
  worldTrustRemoved: Draft;
  worldTrustConfirmation: { risks: boolean[]; draft: Draft };
  worldTrustAfterCancel: { policy: Policy; draft: Draft };
  worldTrustAfterRefresh: { policy: Policy; draft: Draft };
};
export const WorldTrustBaseline = () => notes<TrustNotes>().get('worldTrustBaseline');
export const WorldTrustInvalid = () => notes<TrustNotes>().get('worldTrustInvalid');
export const WorldTrustDraft = () => notes<TrustNotes>().get('worldTrustDraft');
export const WorldTrustDuplicate = () => notes<TrustNotes>().get('worldTrustDuplicate');
export const WorldTrustRemoved = () => notes<TrustNotes>().get('worldTrustRemoved');
export const WorldTrustConfirmation = () => notes<TrustNotes>().get('worldTrustConfirmation');
export const WorldTrustAfterCancel = () => notes<TrustNotes>().get('worldTrustAfterCancel');
export const WorldTrustAfterRefresh = () => notes<TrustNotes>().get('worldTrustAfterRefresh');
