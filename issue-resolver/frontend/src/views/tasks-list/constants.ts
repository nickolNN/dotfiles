import { IssueDeletingPhase, TaskStatus } from '@issue-resolver/shared';
import { RepoReadiness } from './types';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  [TaskStatus.draft]: 'Черновик',
  [TaskStatus.pending]: 'В очереди',
  [TaskStatus.running]: 'В работе',
  [TaskStatus.preparing]: 'Подготовка',
  [TaskStatus.completed]: 'Завершено',
  [TaskStatus.failed]: 'Ошибка',
  [TaskStatus.cancelled]: 'Отменено',
  [TaskStatus.question]: 'Вопрос',
};

export const TASK_STATUSES: ReadonlySet<string> = new Set(
  Object.values(TaskStatus),
);

export const DELETE_TIMEOUT_MESSAGE =
  'Таймаут удаления. Задача может быть удалена частично. Обновите страницу.';

export const DELETE_PHASE_LABELS: Record<IssueDeletingPhase, string> = {
  [IssueDeletingPhase.stopping_processes]: 'останавливаем процессы',
  [IssueDeletingPhase.removing_db_record]: 'Удаление записи...',
  [IssueDeletingPhase.removing_container]: 'удаляем контейнер',
  [IssueDeletingPhase.removing_workspace]: 'удаляем рабочую папку',
  [IssueDeletingPhase.error]: 'ошибка удаления',
};

export const PULSE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.running,
  TaskStatus.preparing,
  TaskStatus.question,
]);

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.completed,
  TaskStatus.cancelled,
]);

export const NO_DOT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.completed,
  TaskStatus.cancelled,
  TaskStatus.failed,
]);

export const REPO_READINESS_ORDER: readonly RepoReadiness[] = [
  RepoReadiness.ready,
  RepoReadiness.connected,
  RepoReadiness.waiting,
  RepoReadiness.error,
];

export const REPO_READINESS_ICONS: Record<RepoReadiness, string> = {
  [RepoReadiness.ready]: '✅',
  [RepoReadiness.connected]: '🔵',
  [RepoReadiness.waiting]: '🟡',
  [RepoReadiness.error]: '❌',
};

export const REPO_READINESS_COLORS: Record<RepoReadiness, string> = {
  [RepoReadiness.ready]: '#00FF41',
  [RepoReadiness.connected]: '#00B4FF',
  [RepoReadiness.waiting]: '#FFB000',
  [RepoReadiness.error]: '#FF0033',
};

export const REPO_READINESS_LABELS: Record<RepoReadiness, string> = {
  [RepoReadiness.ready]: 'готов',
  [RepoReadiness.connected]: 'подключён',
  [RepoReadiness.waiting]: 'ожидание',
  [RepoReadiness.error]: 'ошибка',
};