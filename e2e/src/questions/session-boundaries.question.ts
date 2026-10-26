import { notes } from '@serenity-js/core';

type SessionBoundaryNotes = {
  malformedSessionCatalogRejection: {
    ipcOk: boolean;
    status: number | null;
    httpOk: boolean;
    body: unknown;
    reflectsInput: boolean;
  };
};

export const MalformedSessionCatalogRejection = () => notes<SessionBoundaryNotes>().get('malformedSessionCatalogRejection');
