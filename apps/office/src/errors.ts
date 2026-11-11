export class OfficeError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
