import { useEffect, useState } from 'react';

/**
 * Show a boolean flag only when it stays active for at least delayMs.
 * Useful for avoiding fast loading flicker.
 */
export function useDelayedFlag(active: boolean, delayMs = 160): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setVisible(true);
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [active, delayMs]);

  return visible;
}
