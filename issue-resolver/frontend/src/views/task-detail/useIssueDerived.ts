import { useMemo } from "react";
import {
  TaskStatus,
  WorkspaceProgressStatus,
  extractRepoNameFromUrl,
} from "@issue-resolver/shared";
import { devServerPortOf } from "../../api/client";
import { repoDevPort, repoFullNameFromUrl, repoPrepStatus } from "../repoPrep";
import type { LoadState, WorkspaceProgressBoard } from "./types";
import type { ComponentProps } from "react";
import type RepositoryStatusPanel from "./RepositoryStatusPanel";
import { AsyncStateStatus } from '../../lib/async-state';

type RepositoryPanelProps = ComponentProps<typeof RepositoryStatusPanel>;

interface UseIssueDerivedInput {
  state: LoadState;
  liveMrUrls: string[];
  workspaceProgress: WorkspaceProgressBoard | null;
}

export function useIssueDerived({
  state,
  liveMrUrls,
  workspaceProgress,
}: UseIssueDerivedInput) {
  const orderedIterations =
    state.status === AsyncStateStatus.ready
      ? [...state.data.iterations].sort((a, b) => b.number - a.number)
      : [];

  const resultAvailable = state.status === AsyncStateStatus.ready;

  const mrItems: RepositoryPanelProps["mrItems"] = useMemo(() => {
    const byUrl = new Map<string, { url: string; repositoryUrl: string }>();
    const stored = state.status === AsyncStateStatus.ready ? state.data.issue.merge_requests : null;
    if (stored) {
      for (const mr of stored) {
        if (!byUrl.has(mr.url)) {
          byUrl.set(mr.url, { url: mr.url, repositoryUrl: mr.repository_url });
        }
      }
    }
    for (const url of liveMrUrls) {
      if (!byUrl.has(url)) byUrl.set(url, { url, repositoryUrl: "" });
    }
    return [...byUrl.values()];
  }, [state, liveMrUrls]);

  const resultReady =
    state.status === AsyncStateStatus.ready &&
    state.data.iterations.some(
      (iteration) => iteration.status === TaskStatus.completed,
    );

  const workspaceReady =
    workspaceProgress !== null
      ? workspaceProgress.steps.some(
          (step) =>
            step.step === "ready" &&
            step.status === WorkspaceProgressStatus.done,
        )
      : state.status === AsyncStateStatus.ready &&
        state.data.issue.status !== TaskStatus.pending &&
        state.data.issue.status !== TaskStatus.preparing;

  const repoRows: RepositoryPanelProps["rows"] =
    state.status === AsyncStateStatus.ready
      ? state.data.issue.repositories.map((repository) => ({
          repository,
          fullName: repoFullNameFromUrl(repository.repository_url),
          status: repoPrepStatus(
            extractRepoNameFromUrl(repository.repository_url),
            repository.bootstrap_enabled,
            workspaceProgress?.steps ?? [],
            workspaceReady,
          ),
          devPort:
            repoDevPort(
              extractRepoNameFromUrl(repository.repository_url),
              workspaceProgress?.steps ?? [],
            ) ??
            devServerPortOf(state.data.issue) ??
            undefined,
        }))
      : [];

  const reviewIteration: RepositoryPanelProps["reviewIteration"] =
    state.status === AsyncStateStatus.ready
      ? ([...state.data.iterations]
          .filter(
            (iteration) =>
              iteration.steps.includes("pr") &&
              iteration.status !== TaskStatus.running &&
              iteration.status !== TaskStatus.pending &&
              iteration.status !== TaskStatus.preparing,
          )
          .sort((a, b) => b.number - a.number)[0] ?? null)
      : null;

  return {
    orderedIterations,
    resultAvailable,
    mrItems,
    resultReady,
    repoRows,
    reviewIteration,
  };
}