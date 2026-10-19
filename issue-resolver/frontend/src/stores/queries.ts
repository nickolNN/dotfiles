import { useQuery } from '@tanstack/react-query';
import {
  getIssue,
  getIterationControl,
  getIterations,
  getStepRuns,
} from '../api/client';

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