import type { RefObject } from "react";
import type { IssueFile, Iteration } from "@issue-resolver/shared";
import IterationCard, {
  type IterationActions,
  type IterationFiles,
  type StepLive,
} from "./IterationCard";
import type { StepRunsState } from "./types";

interface IterationListProps {
  iterations: Iteration[];
  activeIterationId: string | null;
  onSelect: (iterationId: string) => void;
  actions: IterationActions;
  files: IterationFiles;
  stepRuns: StepRunsState;
  live: StepLive;
  iterationErrors: Record<string, string>;
  agentsIteration: boolean;
  repeatError: string | null;
  listRef: RefObject<HTMLDivElement | null>;
  onExpandStep: (runId: string) => void;
}

export default function IterationList({
  iterations,
  activeIterationId,
  onSelect,
  actions,
  files,
  stepRuns,
  live,
  iterationErrors,
  agentsIteration,
  repeatError,
  listRef,
  onExpandStep,
}: IterationListProps) {
  return (
    <div ref={listRef} className="space-y-3">
      {repeatError && (
        <p role="alert" className="mb-3 text-xs font-medium text-[#FF0033]">
          {repeatError}
        </p>
      )}
      {iterations.length === 0 ? (
        <div className="rounded-none border border-dashed border-[#008F11] p-6 text-center text-sm text-[#00FF41]/60">
          Итераций пока нет.
        </div>
      ) : (
        <ul className="space-y-3">
          {iterations.map((iteration) => (
            <IterationCard
              key={iteration.id}
              iteration={iteration}
              isSelected={iteration.id === activeIterationId}
              onSelect={onSelect}
              actions={actions}
              files={files}
              stepRuns={stepRuns}
              live={live}
              iterationError={iterationErrors[iteration.id]}
              agentsIteration={agentsIteration}
              onExpandStep={onExpandStep}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export type { IssueFile };