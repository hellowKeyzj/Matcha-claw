import { createContext, type Dispatch, type SetStateAction } from 'react';

export const TeamApprovalDraftsContext = createContext<{
  notes: Record<string, string>;
  setNotes: Dispatch<SetStateAction<Record<string, string>>>;
} | null>(null);
