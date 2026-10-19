import { QueryClient } from '@tanstack/react-query';

/**
 * Единственный QueryClient приложения. Держим его здесь (а не в main.tsx),
 * чтобы конфиг кэша был виден рядом с остальными сторами и не пересоздавался
 * при HMR.
 *
 * defaultOptions:
 * - `staleTime: 30_000` — данные считаются свежими 30с, лишних рефетчей нет.
 * - `refetchOnWindowFocus: false` — фокус окна (частый при работе в iframe/
 *   переключении вкладок) не должен дёргать сеть на каждом переключении.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});