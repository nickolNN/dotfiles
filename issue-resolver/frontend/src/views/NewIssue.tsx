import type { Issue } from '@issue-resolver/shared';
import IssueForm from '../components/IssueForm';
import QueryBoundary from '../components/QueryBoundary';
import { messageOf } from '../lib/errors';
import { useCreateIssue } from '../stores/queries';

interface NewIssueProps {
  onCreated?: (issue: Issue) => void;
  onBack?: () => void;
}

export default function NewIssue(props: NewIssueProps) {
  return (
    <QueryBoundary>
      <NewIssueView {...props} />
    </QueryBoundary>
  );
}

function NewIssueView({ onCreated, onBack }: NewIssueProps) {
  const createMutation = useCreateIssue();

  const error = createMutation.error
    ? messageOf(createMutation.error)
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