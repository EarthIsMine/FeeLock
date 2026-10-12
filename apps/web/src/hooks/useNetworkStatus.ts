import { useEffect, useState } from 'react';
import { networkStatus, type NetworkStatus } from '../lib/sdk';

/** Polls the RPC every 2s. `down` only after two failures in a row, so one dropped request does not flip the page. */
export function useNetworkStatus(): NetworkStatus & { down: boolean; checked: boolean } {
  const [status, setStatus] = useState<NetworkStatus>();
  const [failures, setFailures] = useState(0);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const s = await networkStatus();
      if (!live) return;
      setStatus(s);
      setFailures((f) => (s.ok ? 0 : f + 1));
    };
    void tick();
    const id = setInterval(tick, 2_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return { ok: status?.ok ?? false, blockNumber: status?.blockNumber, error: status?.error, down: failures >= 2, checked: !!status };
}
