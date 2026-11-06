import { ScenarioStatus, type StepReportScenario } from '@issue-resolver/shared';
import AgentMarkdown from '../AgentMarkdown';

export default function ScenarioRow({
  scenario,
}: {
  scenario: StepReportScenario;
}) {
  const hasStatus =
    scenario.status === ScenarioStatus.pass ||
    scenario.status === ScenarioStatus.fail;
  const pass = scenario.status === ScenarioStatus.pass;
  return (
    <li
      data-testid="step-report-scenario"
      className="border border-[#008F11]/50 bg-[#000200] p-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-2">
        <span
          data-testid="step-report-scenario-name"
          className="text-[#00FF41]/90"
        >
          {scenario.name}
        </span>
        {hasStatus && (
          <span
            data-testid="step-report-scenario-status"
            className={pass ? 'text-[#00FF41]' : 'text-[#FF0033]'}
          >
            {pass ? '✓ PASS' : '✕ FAIL'}
          </span>
        )}
      </div>
      {scenario.details && scenario.details.trim() !== '' && (
        <div
          data-testid="step-report-scenario-details"
          className="mt-1 text-[#00FF41]/60"
        >
          <AgentMarkdown>{scenario.details}</AgentMarkdown>
        </div>
      )}
      {scenario.expected && scenario.expected.trim() !== '' && (
        <div
          data-testid="step-report-scenario-expected"
          className="mt-1 text-[#00FF41]/70"
        >
          expected:{' '}
          <span className="text-[#00FF41]/90">{scenario.expected}</span>
        </div>
      )}
      {scenario.actual && scenario.actual.trim() !== '' && (
        <div
          data-testid="step-report-scenario-actual"
          className="mt-1 text-[#FFB000]/80"
        >
          actual: <span className="text-[#FFB000]">{scenario.actual}</span>
        </div>
      )}
    </li>
  );
}