import { useEffect, useRef, useState } from 'react';

/**
 * 保证 loading 至少展示一段时间，避免瞬时加载造成的闪烁。
 */
export function useMinLoading(active: boolean, minDurationMs = 450): boolean {
  const [visible, setVisible] = useState(active);
  const startedAtRef = useRef<number>(0);

  if (active && !visible) {
    setVisible(true);
  }

  useEffect(() => {
    if (active) {
      if (startedAtRef.current === 0) {
        startedAtRef.current = Date.now();
      }
      return;
    }

    if (!visible) {
      return;
    }

    const startedAt = startedAtRef.current > 0 ? startedAtRef.current : Date.now();
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, minDurationMs - elapsed);

    const timer = window.setTimeout(() => {
      setVisible(false);
      startedAtRef.current = 0;
    }, remaining);

    return () => {
      window.clearTimeout(timer);
    };
  }, [active, minDurationMs, visible]);

  return active || visible;
}
