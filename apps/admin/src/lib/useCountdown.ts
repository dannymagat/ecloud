import { useEffect, useState } from 'react';

/** Seconds remaining until `iso` (0 when past), re-rendering every second. */
export function useCountdown(iso: string | null | undefined): number {
  const target = iso ? new Date(iso).getTime() : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(target)) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  return Number.isFinite(target) ? Math.max(0, Math.round((target - now) / 1000)) : 0;
}

export function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
