import { WorkspaceProgressStatus } from "@issue-resolver/shared";
import { WORKSPACE_STEP_COLORS } from "./constants";
import { workspaceStepLabel, workspaceStepMark } from "./format";
import type { WorkspaceProgressBoard } from "./types";

interface WorkspaceProgressPanelProps {
  progress: WorkspaceProgressBoard;
  onFinished: () => void;
}

export default function WorkspaceProgressPanel({
  progress,
  onFinished,
}: WorkspaceProgressPanelProps) {
  return (
    <div
      data-testid="workspace-progress"
      data-fading={progress.fading ? "true" : "false"}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onFinished();
      }}
      className={`mb-4 border border-[#008F11] bg-[#002B00]/40 px-3 py-2${
        progress.fading ? " workspace-progress--fade" : ""
      }`}
    >
      <h4 className="mb-2 text-xs uppercase tracking-wider text-[#00FF41]/60">
        Подготовка проектов
      </h4>
      <ul className="space-y-1">
        {progress.steps.map((step) => (
          <li
            key={step.key}
            data-testid="workspace-step"
            data-step={step.step}
            data-status={step.status}
            className="flex flex-wrap items-center gap-2 text-xs animate-fade-in-up"
            style={{ color: WORKSPACE_STEP_COLORS[step.status] }}
          >
            <span aria-hidden="true">{workspaceStepMark(step.status)}</span>
            <span>{workspaceStepLabel(step.step, step.repo)}</span>
            {step.message && (
              <span
                style={{
                  color:
                    step.status === WorkspaceProgressStatus.warning
                      ? "#FFB000"
                      : "#FF0033",
                }}
              >
                {step.message}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}