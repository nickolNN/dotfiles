import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateIssueRequest,
  CreateTagRequest,
  SavedRepo,
  Tag,
  UpdateTagRequest,
} from '@issue-resolver/shared';
import {
  cleanupOrphans,
  createIssue,
  createIssueWithFiles,
  createRepository,
  createTag,
  deleteRepository,
  deleteTag,
  getIssue,
  getIterationControl,
  getIterations,
  getRepositories,
  getStepRuns,
  getTags,
  setHostname,
  updateRepository,
  updateTag,
} from '../api/client';
import type { CleanupResult } from '../api/client';
import { queryKeys } from '../lib/query-keys';

function ensureArray<T>(data: T[] | undefined): T[] {
  return Array.isArray(data) ? data : [];
}

function upsertById<T extends { id: string }>(
  items: T[] | undefined,
  item: T,
): T[] {
  return [...(items ?? []).filter((current) => current.id !== item.id), item];
}

function replaceById<T extends { id: string }>(
  items: T[] | undefined,
  item: T,
): T[] {
  return (items ?? []).map((current) =>
    current.id === item.id ? item : current,
  );
}

function removeById<T extends { id: string }>(
  items: T[] | undefined,
  id: string,
): T[] {
  return (items ?? []).filter((current) => current.id !== id);
}

export function useIssue(issueId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.issue(issueId),
    queryFn: () => getIssue(issueId as string),
    enabled: Boolean(issueId),
  });
}

export function useIterations(issueId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.iterations(issueId),
    queryFn: () => getIterations(issueId as string),
    enabled: Boolean(issueId),
  });
}

export function useStepRuns(iterationId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.stepRuns(iterationId),
    queryFn: () => getStepRuns(iterationId as string),
    enabled: Boolean(iterationId),
  });
}

export function useIterationControl(
  iterationId: string | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.iterationControl(iterationId),
    queryFn: () => getIterationControl(iterationId as string),
    enabled: Boolean(iterationId) && enabled,
    refetchInterval: 4000,
  });
}

export { useModels } from '../hooks/useModels';

export function useSaveHostname() {
  return useMutation({
    mutationFn: setHostname,
  });
}

export function useCleanupOrphans() {
  return useMutation<CleanupResult, Error, void>({
    mutationFn: cleanupOrphans,
  });
}

export function useRepositories(enabled = true) {
  return useQuery({
    queryKey: queryKeys.repositories,
    queryFn: getRepositories,
    staleTime: 60_000,
    enabled,
    select: ensureArray,
  });
}

export function useCreateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createRepository,
    onSuccess: (repo) => {
      qc.setQueryData<SavedRepo[]>(queryKeys.repositories, (old) =>
        upsertById(old, repo),
      );
    },
  });
}

export function useUpdateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; url: string }) =>
      updateRepository(args.id, args.url),
    onSuccess: (repo) => {
      qc.setQueryData<SavedRepo[]>(queryKeys.repositories, (old) =>
        replaceById(old, repo),
      );
    },
  });
}

export function useDeleteRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteRepository,
    onSuccess: (_void, id) => {
      qc.setQueryData<SavedRepo[]>(queryKeys.repositories, (old) =>
        removeById(old, id),
      );
    },
  });
}

export function writeRepositoryToCache(
  qc: ReturnType<typeof useQueryClient>,
  repo: SavedRepo,
) {
  qc.setQueryData<SavedRepo[]>(queryKeys.repositories, (old) =>
    replaceById(old, repo),
  );
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateTagRequest) => createTag(request),
    onSuccess: (tag) => {
      qc.setQueryData<Tag[]>(queryKeys.tags, (old) => upsertById(old, tag));
    },
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; request: UpdateTagRequest }) =>
      updateTag(args.id, args.request),
    onSuccess: (tag) => {
      qc.setQueryData<Tag[]>(queryKeys.tags, (old) => replaceById(old, tag));
    },
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteTag,
    onSuccess: (_void, id) => {
      qc.setQueryData<Tag[]>(queryKeys.tags, (old) => removeById(old, id));
    },
  });
}

export function useSavedRepos() {
  return useRepositories();
}

export function useTags() {
  return useQuery({
    queryKey: queryKeys.tags,
    queryFn: () => getTags(),
    staleTime: 60_000,
    select: ensureArray,
  });
}

interface CreateIssueVariables {
  request: CreateIssueRequest;
  files?: File[];
}

export function useCreateIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ request, files }: CreateIssueVariables) =>
      files && files.length > 0
        ? createIssueWithFiles(request, files)
        : createIssue(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues });
    },
  });
}