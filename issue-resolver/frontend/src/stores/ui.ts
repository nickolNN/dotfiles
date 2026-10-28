import { create } from 'zustand';
import { getHostname } from '../api/client';
import type { ContainerStatsPayload } from '../api/sse';

interface UIState {
  hostname: string;
  containerStats: ContainerStatsPayload | null;
  loadHostname: () => Promise<void>;
  setHostname: (value: string) => void;
  setContainerStats: (stats: ContainerStatsPayload | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  hostname: '',
  containerStats: null,
  loadHostname: async () => {
    const value = await getHostname();
    set({ hostname: value });
  },
  setHostname: (hostname) => set({ hostname }),
  setContainerStats: (containerStats) => set({ containerStats }),
}));