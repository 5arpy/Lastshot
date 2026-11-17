import { useEffect, useState } from "react";
import { countdownShown } from "./recordOptions";

/**
 * The whole seconds a recording countdown shows, ticking locally between the
 * backend's updates. Null when there is no countdown.
 */
export function useCountdown(countdown: number | null | undefined): number | null {
  const value = countdown ?? null;
  // A new value from the backend restarts the local clock.
  const [base, setBase] = useState({ value, at: Date.now() });
  if (base.value !== value) setBase({ value, at: Date.now() });
  const [, tick] = useState(0);
  const running = value !== null;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 200);
    return () => window.clearInterval(t);
  }, [running]);
  if (value === null) return null;
  const at = base.value === value ? base.at : Date.now();
  return countdownShown(value, (Date.now() - at) / 1000);
}
