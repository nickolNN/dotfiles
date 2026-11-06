import { parseStepReport } from '@issue-resolver/shared';
import AgentMarkdown from './AgentMarkdown';
import ErrorAlert from './ErrorAlert';
import ExecutionSection from './step-report/ExecutionSection';
import FindingRow from './step-report/FindingRow';
import ScenarioRow from './step-report/ScenarioRow';
import { SECTION_HEADER, STATUS_META } from './step-report/meta';
import { prettyJsonText } from '../lib/json';

interface StepReportViewProps {
  raw: string;
}

export default function StepReportView({ raw }: StepReportViewProps) {
  const report = parseStepReport(raw);

  if (report === null) {
    return (
      <pre
        data-testid="step-report-raw"
        className="overflow-x-auto whitespace-pre-wrap break-words border border-[#008F11] bg-[#000200] p-2 font-mono text-xs text-[#00FF41]/80"
      >
        {prettyJsonText(raw)}
      </pre>
    );
  }

  const status = STATUS_META[report.status];

  return (
    <div data-testid="step-report" className="space-y-3">
      <div>
        <span
          data-testid="step-report-status"
          className={`inline-flex items-center border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${status.badgeClass} ${status.textClass}`}
        >
          {status.label}
        </span>
      </div>

      {report.pr_error && (
        <ErrorAlert testId="step-report-pr-error" className="font-medium">
          ⚠ MR/ветка не созданы: {report.pr_error}
        </ErrorAlert>
      )}

      {report.summary.trim() !== '' && (
        <div
          data-testid="step-report-summary"
          className="text-sm text-[#00FF41]/85"
        >
          <AgentMarkdown>{report.summary}</AgentMarkdown>
        </div>
      )}

      {report.execution && <ExecutionSection execution={report.execution} />}

      {report.executionMalformed && (
        <ErrorAlert
          testId="step-report-execution-unreadable"
          className="font-medium"
        >
          ⚠ План нечитаем: режим должен быть single или stages — исполнители не
          запускались.
        </ErrorAlert>
      )}

      {report.scenarios && report.scenarios.length > 0 && (
        <section data-testid="step-report-scenarios">
          <h4 className={SECTION_HEADER}>scenarios</h4>
          <ul className="space-y-1">
            {report.scenarios.map((scenario, index) => (
              <ScenarioRow key={index} scenario={scenario} />
            ))}
          </ul>
        </section>
      )}

      {report.findings && report.findings.length > 0 && (
        <section data-testid="step-report-findings">
          <h4 className={SECTION_HEADER}>findings</h4>
          <ul className="space-y-1">
            {report.findings.map((finding, index) => (
              <FindingRow key={index} finding={finding} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}