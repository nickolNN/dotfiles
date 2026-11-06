import {
  ExecutionMode,
  stageLabel,
  type ExecutionPlan,
} from '@issue-resolver/shared';
import AgentMarkdown from '../AgentMarkdown';
import { SECTION_HEADER } from './meta';

interface ExecutionSectionProps {
  execution: ExecutionPlan;
}

export default function ExecutionSection({
  execution,
}: ExecutionSectionProps) {
  const isSingle = execution.mode === ExecutionMode.single;
  return (
    <section data-testid="step-report-execution">
      <h4 className={SECTION_HEADER}>execution</h4>
      <div className="space-y-1 border border-[#008F11] bg-[#000200] p-2 text-xs">
        <div className="text-[#00FF41]/85">
          режим:{' '}
          <span
            data-testid="step-report-execution-mode"
            className="text-[#00FF41]"
          >
            {execution.mode}
          </span>
        </div>
        {isSingle &&
          Number.isFinite(execution.executors) && (
            <div className="text-[#00FF41]/85">
              исполнителей:{' '}
              <span
                data-testid="step-report-execution-executors"
                className="text-[#00FF41]"
              >
                {execution.executors}
              </span>
            </div>
          )}
        {isSingle &&
          execution.decomposition &&
          execution.decomposition.length > 0 && (
            <div className="text-[#00FF41]/85">
              декомпозиция:
              <ul
                data-testid="step-report-execution-decomposition"
                className="mt-1 list-disc space-y-0.5 pl-5 text-[#00FF41]/80"
              >
                {execution.decomposition.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        {execution.rationale && execution.rationale.trim() !== '' && (
          <div
            data-testid="step-report-execution-rationale"
            className="text-[#00FF41]/80"
          >
            <AgentMarkdown>{execution.rationale}</AgentMarkdown>
          </div>
        )}
        {!isSingle &&
          execution.stages &&
          execution.stages.length > 0 && (
            <div className="text-[#00FF41]/85">
              этапы:
              <ol
                data-testid="step-report-execution-stages"
                className="mt-1 list-decimal space-y-0.5 pl-5 text-[#00FF41]/80"
              >
                {execution.stages.map((stage, i) => (
                  <li key={i}>
                    {stageLabel(stage.name, i + 1)}
                    {Number.isFinite(stage.executors)
                      ? ` — ${stage.executors} исп.`
                      : ''}
                    {stage.task ? `: ${stage.task}` : ''}
                  </li>
                ))}
              </ol>
            </div>
          )}
      </div>
    </section>
  );
}