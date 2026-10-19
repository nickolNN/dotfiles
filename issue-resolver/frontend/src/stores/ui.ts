import { create } from 'zustand';
import { getHostname } from '../api/client';
import type { ContainerStatsPayload } from '../api/sse';

/**
 * UI-состояние, общее для всего приложения (не привязано к одному view).
 *
 * - `hostname` — hostname инстанса, задаёт заголовок вкладки и поле в
 *   «Настройках». Грузится один раз при старте через `loadHostname()`.
 * - `containerStats` — последняя живая стата контейнера (CPU/память). Пока
 *   никем не пишется: SSE-поток будет писать сюда на следующем этапе.
 */
interface UIState {
  hostname: string;
  containerStats: ContainerStatsPayload | null;
  /** Загрузить hostname из бэкенда (при старте приложения). */
  loadHostname: () => Promise<void>;
  /** Установить hostname (используется страницей «Настройки» после сохранения). */
  setHostname: (value: string) => void;
  /** Записать последнюю стату контейнера (для будущего SSE-потока). */
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