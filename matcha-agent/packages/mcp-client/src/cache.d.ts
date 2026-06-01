type LRUMemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
    size: () => number
    delete: (key: string) => boolean
    get: (key: string) => Result | undefined
    has: (key: string) => boolean
  }
}
/**
 * Creates a memoized function with LRU eviction policy.
 * Prevents unbounded memory growth by evicting least recently used entries.
 *
 * @param f The function to memoize
 * @param cacheFn Key generation function
 * @param maxCacheSize Maximum cache entries (default 100)
 */
export declare function memoizeWithLRU<
  Args extends unknown[],
  Result extends NonNullable<unknown>,
>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize?: number,
): LRUMemoizedFunction<Args, Result>
export {}
