import { messageOf } from "../../lib/errors";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { Iteration, Issue } from "@issue-resolver/shared";
import type { LoadState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

type IssueQueryLike = {
  data: Issue | undefined;
  isError: boolean;
  error: unknown;
};

type IterationsQueryLike = {
  data: Iteration[] | undefined;
  isError: boolean;
  error: unknown;
};

interface UseIssueSyncInput {
  issueId: string | null | undefined;
  issueQuery: IssueQueryLike;
  iterationsQuery: IterationsQueryLike;
  setState: Dispatch<SetStateAction<LoadState>>;
  onIssueLoaded: (issue: Issue) => void;
  onIssueChange: () => void;
}

export function useIssueSync({
  issueId,
  issueQuery,
  iterationsQuery,
  setState,
  onIssueLoaded,
  onIssueChange,
}: UseIssueSyncInput) {
  useEffect(() => {
    if (!issueId) return;
    setState({ status: AsyncStateStatus.loading });
    onIssueChange();
  }, [issueId]);

  useEffect(() => {
    if (!issueId) return;
    const error = issueQuery.error ?? iterationsQuery.error;
    if (issueQuery.isError || iterationsQuery.isError) {
      setState({
        status: AsyncStateStatus.error,
        message: messageOf(error),
      });
      return;
    }
    if (!issueQuery.data || !iterationsQuery.data) return;
    const issue = issueQuery.data;
    setState({
      status: AsyncStateStatus.ready,
      data: {
        issue,
        iterations: [...iterationsQuery.data].sort(
          (a, b) => a.number - b.number,
        ),
      },
    });
    onIssueLoaded(issue);
  }, [
    issueId,
    issueQuery.data,
    issueQuery.isError,
    issueQuery.error,
    iterationsQuery.data,
    iterationsQuery.isError,
    iterationsQuery.error,
  ]);
}
