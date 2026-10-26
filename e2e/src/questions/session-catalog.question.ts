import { notes, Question } from '@serenity-js/core';

type CatalogNotes = {
  sessionCatalogDraftUnchanged: boolean;
  sessionCatalogReceipt: {
    independent: boolean;
    listedIdentityMatches: boolean;
    loadedIdentityMatches: boolean;
    itemsAreDeliveredAndEmpty: boolean;
    windowIsCompleteAndEmpty: boolean;
    completenessAccuratelyReportsGaps: boolean;
    hasNoPrivateFields: boolean;
  };
};

export const DraftDidNotChangeNativeCatalog = () => notes<CatalogNotes>().get('sessionCatalogDraftUnchanged');
export const IndependentCatalogSessionReceipt = () => notes<CatalogNotes>().get('sessionCatalogReceipt');
export const ExpectedCatalogReceipt = () => Question.about('the expected catalog receipt', () => ({
  independent: true,
  listedIdentityMatches: true,
  loadedIdentityMatches: true,
  itemsAreDeliveredAndEmpty: true,
  windowIsCompleteAndEmpty: true,
  completenessAccuratelyReportsGaps: true,
  hasNoPrivateFields: true,
}));
