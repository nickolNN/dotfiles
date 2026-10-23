import {
  useContext,
  useState,
  type ReactNode,
} from 'react';
import {
  QueryClient,
  QueryClientContext,
  QueryClientProvider,
} from '@tanstack/react-query';
import type { Issue } from '@issue-resolver/shared';
import IssueForm from '../components/IssueForm';
import { useCreateIssue } from '../stores/queries';

interface NewIssueProps {
  onCreated?: (issue: Issue) => void;
  onBack?: () => void;
}

export default function NewIssue(props: NewIssueProps) {
  return (
    <NewIssueQueryBoundary>
      <NewIssueView {...props} />
    </NewIssueQueryBoundary>
  );
}

/**
 * Гарантирует наличие QueryClient. В приложении провайдер ставит `main.tsx`,
 * но форма в тестах монтируется напрямую — без провайдера любой `useQuery`
 * бросил бы «No QueryClient set». Если провайдер уже есть — пробрасываем
 * детей в общий клиент приложения; иначе создаём локальный клиент на время
 * жизни формы, чтобы тесты не делили кэш между собой.
 */
function NewIssueQueryBoundary({ children }: { children: ReactNode }) {
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

/**
 * Тонкая обёртка создания задачи: вся форма и логика живут в общем
 * `IssueForm`, здесь остаётся только мутация `useCreateIssue` и проброс
 * результата наружу.
 */
function NewIssueView({ onCreated, onBack }: NewIssueProps) {
  const createMutation = useCreateIssue();

  const error =
    createMutation.error instanceof Error
      ? createMutation.error.message
      : createMutation.error
        ? String(createMutation.error)
        : null;

  return (
    <IssueForm
      onSubmit={async (payload, files) => {
        // `mutateAsync` возвращает промис и естественно реджектится при
        // ошибке — `IssueForm.submitForm` ловит этот reject (файлы при этом
        // сохраняются), а текст ошибки приходит через проп `error`. Ручная
        // обёртка `new Promise` + `mutate` могла утекать необработанным
        // реджектом при размонтировании формы.
        const issue = await createMutation.mutateAsync({
          request: payload,
          files,
        });
        onCreated?.(issue);
      }}
      showRunButton
      showSaveButton
      showFiles
      error={error}
      submitting={createMutation.isPending}
      onBack={onBack}
    />
  );
}