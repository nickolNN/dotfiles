import { SESSION_STALE_MS } from "@issue-resolver/shared";
import { PipelineStep } from "@issue-resolver/shared";
import {
  StepRunStatus,
  WorkspaceProgressStatus,
  WorkspaceProgressStep,
} from "@issue-resolver/shared";

export { inputClass, labelClass } from "../../components/formStyles";

export const STEP_OPTIONS: ReadonlyArray<{ value: PipelineStep; label: string }> = [
  { value: PipelineStep.refine, label: "Планирование" },
  { value: PipelineStep.resolve, label: "Исполнение" },
  { value: PipelineStep.review, label: "Код-ревью" },
  { value: PipelineStep.test, label: "Тест" },
  { value: PipelineStep.pr, label: "PR" },
];

export const STEP_LABELS: Record<PipelineStep, string> = {
  [PipelineStep.refine]: "Планирование",
  [PipelineStep.resolve]: "Исполнение",
  [PipelineStep.review]: "Код-ревью",
  [PipelineStep.test]: "Тест",
  [PipelineStep.pr]: "PR",
  [PipelineStep.report]: "Отчёт",
  [PipelineStep.devops]: "DevOps",
};

export const WORKSPACE_STEP_LABELS: Record<string, string> = {
  [WorkspaceProgressStep.creating_dirs]: "Создание рабочей папки",
  [WorkspaceProgressStep.cloning]: "Клонирование",
  [WorkspaceProgressStep.installing]: "Установка зависимостей",
  [WorkspaceProgressStep.dev_server]: "Запуск dev-сервера",
  [WorkspaceProgressStep.checking_instructions]: "Проверка инструкции запуска",
  [WorkspaceProgressStep.devops]: "DevOps",
  [WorkspaceProgressStep.ready]: "Готово",
};

const WORKSPACE_STEP_STATUSES: ReadonlySet<string> = new Set(
  Object.values(WorkspaceProgressStatus),
);

export function isWorkspaceProgressStatus(
  value: string,
): value is WorkspaceProgressStatus {
  return WORKSPACE_STEP_STATUSES.has(value);
}

export const WORKSPACE_STEP_COLORS: Record<WorkspaceProgressStatus, string> = {
  [WorkspaceProgressStatus.running]: "#FFB000",
  [WorkspaceProgressStatus.done]: "#00FF41",
  [WorkspaceProgressStatus.warning]: "#FFB000",
  [WorkspaceProgressStatus.error]: "#FF0033",
};

export const TERMINATED_STATUSES: ReadonlySet<string> = new Set([
  StepRunStatus.failed,
  StepRunStatus.aborted,
  StepRunStatus.needs_input,
]);

export const STEP_RUN_STATUSES: ReadonlySet<string> = new Set(
  Object.values(StepRunStatus),
);

export const HARNESS_RESULT_FILE = ".issue-step-result.json";

export const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

export const RESULT_HTML_FILENAME = "report.html";

export const RESULT_MD_FILENAME = "report.md";

export const REPORT_STALE_MS = SESSION_STALE_MS;

export const REPORT_POLL_FAILURES = 3;

export const CYCLE_MODEL_ID = "__cycle__";