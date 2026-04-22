export type ResourceLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ResourceState<T> {
  data: T;
  status: ResourceLoadStatus;
  error: string | null;
  hasLoadedOnce: boolean;
  lastLoadedAt: number | null;
}

export type ResourceStateMeta<T = unknown> = ResourceState<T>;

export function createIdleResourceState<T>(data: T): ResourceState<T> {
  return {
    data,
    status: 'idle',
    error: null,
    hasLoadedOnce: false,
    lastLoadedAt: null,
  };
}

export function createLoadingResourceState<T>(previous: ResourceState<T>): ResourceState<T> {
  return {
    data: previous.data,
    status: 'loading',
    error: null,
    hasLoadedOnce: previous.hasLoadedOnce,
    lastLoadedAt: previous.lastLoadedAt,
  };
}

export function createReadyResourceState<T>(
  data: T,
  loadedAt = Date.now(),
): ResourceState<T> {
  return {
    data,
    status: 'ready',
    error: null,
    hasLoadedOnce: true,
    lastLoadedAt: loadedAt,
  };
}

export function createErrorResourceState<T>(
  previous: ResourceState<T>,
  error: string,
): ResourceState<T> {
  return {
    data: previous.data,
    status: 'error',
    error,
    hasLoadedOnce: previous.hasLoadedOnce,
    lastLoadedAt: previous.lastLoadedAt,
  };
}
