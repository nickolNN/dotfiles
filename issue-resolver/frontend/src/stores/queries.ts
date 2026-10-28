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
  getHostname,
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

export function useIssue(issueId: string | null | undefined) {
  return useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => getIssue(issueId as string),
    enabled: Boolean(issueId),
  });
}

export function useIterations(issueId: string | null | undefined) {
  return useQuery({
    queryKey: ['iterations', issueId],
    queryFn: () => getIterations(issueId as string),
    enabled: Boolean(issueId),
  });
}

export function useStepRuns(iterationId: string | null | undefined) {
  return useQuery({
    queryKey: ['step-runs', iterationId],
    queryFn: () => getStepRuns(iterationId as string),
    enabled: Boolean(iterationId),
  });
}

export function useIterationControl(
  iterationId: string | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['iteration-control', iterationId],
    queryFn: () => getIterationControl(iterationId as string),
    enabled: Boolean(iterationId) && enabled,
    refetchInterval: 4000,
  });
}

export function useHostname() {
  return useQuery({
    queryKey: ['hostname'],
    queryFn: getHostname,
    staleTime: Infinity,
  });
}

export function useSetHostname() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setHostname,
    onSuccess: (_void, hostname) => {
      qc.setQueryData(['hostname'], hostname);
    },
  });
}

export function useCleanupOrphans() {
  return useMutation<CleanupResult, Error, void>({
    mutationFn: cleanupOrphans,
  });
}

export function useRepositories() {
  return useQuery({
    queryKey: ['repositories'],
    queryFn: getRepositories,
    staleTime: 60_000,
  });
}

export function useCreateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createRepository,
    onSuccess: (repo) => {
      qc.setQueryData<SavedRepo[]>(['repositories'], (old) => [
        ...(old ?? []).filter((item) => item.id !== repo.id),
        repo,
      ]);
    },
  });
}

export function useUpdateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; url: string }) =>
      updateRepository(args.id, args.url),
    onSuccess: (repo) => {
      qc.setQueryData<SavedRepo[]>(['repositories'], (old) =>
        (old ?? []).map((item) => (item.id === repo.id ? repo : item)),
      );
    },
  });
}

export function useDeleteRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteRepository,
    onSuccess: (_void, id) => {
      qc.setQueryData<SavedRepo[]>(['repositories'], (old) =>
        (old ?? []).filter((item) => item.id !== id),
      );
    },
  });
}

export function writeRepositoryToCache(
  qc: ReturnType<typeof useQueryClient>,
  repo: SavedRepo,
) {
  qc.setQueryData<SavedRepo[]>(['repositories'], (old) =>
    (old ?? []).map((item) => (item.id === repo.id ? repo : item)),
  );
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateTagRequest) => createTag(request),
    onSuccess: (tag) => {
      qc.setQueryData<Tag[]>(['tags'], (old) => [
        ...(old ?? []).filter((item) => item.id !== tag.id),
        tag,
      ]);
    },
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; request: UpdateTagRequest }) =>
      updateTag(args.id, args.request),
    onSuccess: (tag) => {
      qc.setQueryData<Tag[]>(['tags'], (old) =>
        (old ?? []).map((item) => (item.id === tag.id ? tag : item)),
      );
    },
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteTag,
    onSuccess: (_void, id) => {
      qc.setQueryData<Tag[]>(['tags'], (old) =>
        (old ?? []).filter((item) => item.id !== id),
      );
    },
  });
}

export function useSavedRepos() {
  return useQuery({
    queryKey: ['savedRepos'],
    queryFn: () => getRepositories(),
    staleTime: 60_000,
    select: (data) => (Array.isArray(data) ? data : []),
  });
}

export function useTags() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: () => getTags(),
    staleTime: 60_000,
    select: (data) => (Array.isArray(data) ? data : []),
  });
}

export interface CreateIssueVariables {
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
      queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });
}