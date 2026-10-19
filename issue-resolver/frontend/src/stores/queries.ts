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

/**
 * Shared-хуки данных задачи. Ключи кэша держим рядом с хуками, чтобы
 * `queryClient.invalidateQueries` / `setQueryData` в компонентах не расходились
 * с тем, что здесь объявлено.
 *
 * `enabled`-гейты повторяют прежние условия ручных загрузок: итерация может
 * быть не выбрана (`null`) — тогда step-runs/control не запрашиваются вовсе.
 */

/** Задача по id (`GET /issues/:id`). */
export function useIssue(issueId: string | null | undefined) {
  return useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => getIssue(issueId as string),
    enabled: Boolean(issueId),
  });
}

/** Итерации задачи (`GET /issues/:id/iterations`). */
export function useIterations(issueId: string | null | undefined) {
  return useQuery({
    queryKey: ['iterations', issueId],
    queryFn: () => getIterations(issueId as string),
    enabled: Boolean(issueId),
  });
}

/** Прогоны шагов итерации (`GET /iterations/:id/step-runs`). */
export function useStepRuns(iterationId: string | null | undefined) {
  return useQuery({
    queryKey: ['step-runs', iterationId],
    queryFn: () => getStepRuns(iterationId as string),
    enabled: Boolean(iterationId),
  });
}

/**
 * Снимок управления живой pi-сессией (`GET /iterations/:id/control`).
 * Опрашивается каждые 4с, пока итерация выполняется; при 409/no-session
 * `getIterationControl` отдаёт `null` — панель управления просто скрыта.
 */
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

// ── Настройки ──────────────────────────────────────────────────────────

/** Hostname инстанса (`GET /settings/hostname`). */
export function useHostname() {
  return useQuery({
    queryKey: ['hostname'],
    queryFn: getHostname,
    staleTime: Infinity,
  });
}

/**
 * Сохраняет hostname (`PUT /settings/hostname`) и сразу кладёт значение в
 * кэш — повторный запрос при возврате на страницу не нужен.
 */
export function useSetHostname() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setHostname,
    onSuccess: (_void, hostname) => {
      qc.setQueryData(['hostname'], hostname);
    },
  });
}

/** Удаляет орфанед-задачи и убивает их процессы (`POST /admin/cleanup-orphans`). */
export function useCleanupOrphans() {
  return useMutation<CleanupResult, Error, void>({
    mutationFn: cleanupOrphans,
  });
}

// ── Репозитории ────────────────────────────────────────────────────────

/** Сохранённые репозитории (`GET /repositories`). */
export function useRepositories() {
  return useQuery({
    queryKey: ['repositories'],
    queryFn: getRepositories,
    staleTime: 60_000,
  });
}

/** Добавить репозиторий; возвращённая сущность добавляется в кэш списка. */
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

/** Обновить URL репозитория; заменяет сущность в кэше списка по id. */
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

/** Удалить репозиторий; убирает его из кэша списка. */
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

/**
 * Заменить сущность репозитория в кэше списка (используется live-валидацией
 * `POST /repositories/:id/validate`, которая не является мьютацией формы).
 */
export function writeRepositoryToCache(
  qc: ReturnType<typeof useQueryClient>,
  repo: SavedRepo,
) {
  qc.setQueryData<SavedRepo[]>(['repositories'], (old) =>
    (old ?? []).map((item) => (item.id === repo.id ? repo : item)),
  );
}

// ── Теги ───────────────────────────────────────────────────────────────

/** Создать тег; возвращённая сущность добавляется в кэш списка. */
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

/** Обновить тег; заменяет сущность в кэше списка по id. */
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

/** Удалить тег; убирает его из кэша списка. */
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

/** Сохранённые репозитории для селекторов формы (`GET /repositories`). */
export function useSavedRepos() {
  return useQuery({
    queryKey: ['savedRepos'],
    queryFn: () => getRepositories(),
    staleTime: 60_000,
    // Защита от нештатного ответа: форма ожидает массив.
    select: (data) => (Array.isArray(data) ? data : []),
  });
}

/** Теги для быстрого добавления их репозиториев (`GET /tags`). */
export function useTags() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: () => getTags(),
    staleTime: 60_000,
    select: (data) => (Array.isArray(data) ? data : []),
  });
}

/** Аргументы создания задачи: тело + опциональные вложения (multipart). */
export interface CreateIssueVariables {
  request: CreateIssueRequest;
  files?: File[];
}

/**
 * Создание задачи (`POST /issues`). С вложениями уходит multipart, иначе JSON.
 * После успеха инвалидирует список задач, чтобы новый черновик появился там.
 */
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