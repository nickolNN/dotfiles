import { useContext, useState, type ReactNode } from 'react';
import {
  QueryClient,
  QueryClientContext,
  QueryClientProvider,
} from '@tanstack/react-query';

/**
 * Гарантирует наличие QueryClient. В приложении провайдер ставит `main.tsx`,
 * но view-компоненты в тестах монтируются напрямую — без провайдера любой
 * `useQuery` бросил бы «No QueryClient set».
 *
 * Если провайдер уже есть — просто пробрасываем детей в общий клиент
 * приложения. Иначе создаём локальный клиент на время жизни поддерева, чтобы
 * тесты не делили кэш между собой. `retry: false` — тесты падают быстро, а не
 * ждут ретраев.
 */
export default function QueryBoundary({ children }: { children: ReactNode }) {
  const existing = useContext(QueryClientContext);
  const [fallbackClient] = useState(() =>
    existing === undefined
      ? new QueryClient({
          defaultOptions: {
            queries: {
              staleTime: 30_000,
              refetchOnWindowFocus: false,
              retry: false,
            },
          },
        })
      : null,
  );

  if (existing !== undefined || fallbackClient === null) {
    return <>{children}</>;
  }
  return (
    <QueryClientProvider client={fallbackClient}>
      {children}
    </QueryClientProvider>
  );
}