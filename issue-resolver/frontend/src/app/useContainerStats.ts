import { useEffect } from 'react';
import { openContainerStatsStream, subscribeToGlobalStream } from '../api/sse';
import { useUIStore } from '../stores/ui';

export function useContainerStats() {
  const containerStats = useUIStore((state) => state.containerStats);
  const setContainerStats = useUIStore((state) => state.setContainerStats);

  useEffect(() => {
    return subscribeToGlobalStream({
      onContainerStats: (payload) => setContainerStats(payload),
    });
  }, [setContainerStats]);

  useEffect(() => openContainerStatsStream(), []);

  return containerStats;
}