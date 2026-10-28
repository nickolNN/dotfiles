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