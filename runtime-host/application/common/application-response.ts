export type ApplicationResponse = {
  status: number;
  data: unknown;
};

export type ApplicationResponseOf<T = unknown> = {
  status: number;
  data: T;
};

export function ok<T>(data: T): ApplicationResponseOf<T> {
  return {
    status: 200,
    data,
  };
}

export function accepted<T>(data: T): ApplicationResponseOf<T> {
  return {
    status: 202,
    data,
  };
}

export function applicationResponse<T>(status: number, data: T): ApplicationResponseOf<T> {
  return {
    status,
    data,
  };
}

export function failure(status: number, message: string): ApplicationResponseOf<{ success: false; error: string }> {
  return {
    status,
    data: {
      success: false,
      error: message,
    },
  };
}

export function badRequest(message: string): ApplicationResponseOf<{ success: false; error: string }> {
  return failure(400, message);
}

export function conflict<T extends { success: false; error: string }>(
  data: T,
): ApplicationResponseOf<T>;
export function conflict(message: string): ApplicationResponseOf<{ success: false; error: string }>;
export function conflict<T extends { success: false; error: string }>(
  input: string | T,
): ApplicationResponseOf<T | { success: false; error: string }> {
  return typeof input === 'string'
    ? failure(409, input)
    : applicationResponse(409, input);
}

export function notFound(message: string): ApplicationResponseOf<{ success: false; error: string }> {
  return failure(404, message);
}

export function unavailable<T extends { success: false }>(data: T): ApplicationResponseOf<T> {
  return applicationResponse(503, data);
}

export function serverError(message: string): ApplicationResponseOf<{ success: false; error: string }> {
  return failure(500, message);
}
