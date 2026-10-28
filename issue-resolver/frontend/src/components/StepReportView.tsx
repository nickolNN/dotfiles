import type { StepReportStatus } from '@issue-resolver/shared';
import { parseStepReport } from '@issue-resolver/shared';
import AgentMarkdown from './AgentMarkdown';

interface StepReportViewProps {
  raw: string;
}

const SECTION_HEADER =
  'mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50';

const STATUS_META: Record<
  StepReportStatus,
  { label: string; className: string }
> = {
  pass: {
    label: 'PASS',
    className: 'border-[#00FF41]/60 bg-[#003B00] text-[#00FF41]',
  },
  fail: {
    label: 'FAIL',
    className: 'border-[#FF0033]/60 bg-[#2A0008] text-[#FF0033]',
  },
  blocked: {
    label: 'BLOCKED',
    className: 'border-[#FFB000]/60 bg-[#1A1000] text-[#FFB000]',
  },
};

interface FindingInput {
  severity: string;
  title?: string;
  description?: string;
  detail?: string;
}

interface ScenarioInput {
  name: string;
  status?: string | null;
  details?: string;
  expected?: string;
  actual?: string;
}

const SEVERITY_CLASS: Partial<Record<string, string>> = {
  info: 'text-[#8A8A8A]',
  low: 'text-[#00FF41]',
  minor: 'text-[#00B4FF]',
  major: 'text-[#FFB000]',
  critical: 'text-[#FF0033]',
};
const UNKNOWN_SEVERITY_CLASS = 'text-[#8A8A8A]';

function prettyRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function ScenarioRow({ scenario }: { scenario: ScenarioInput }) {
  const hasStatus = scenario.status === 'pass' || scenario.status === 'fail';
  const pass = scenario.status === 'pass';
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

function FindingRow({ finding }: { finding: FindingInput }) {
  const severityClass =
    SEVERITY_CLASS[finding.severity] ?? UNKNOWN_SEVERITY_CLASS;
  const body =
    finding.detail && finding.detail.trim() !== ''
      ? finding.detail
      : finding.description;
  return (
    <li
      data-testid="step-report-finding"
      className="border border-[#008F11]/50 bg-[#000200] p-2 text-xs"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span
          data-testid="step-report-finding-severity"
          className={`font-bold uppercase ${severityClass}`}
        >
          {finding.severity}
        </span>
        {finding.title && finding.title.trim() !== '' && (
          <span
            data-testid="step-report-finding-title"
            className="font-bold text-[#00FF41]/90"
          >
            {finding.title}
          </span>
        )}
      </div>
      {body && body.trim() !== '' && (
        <div
          data-testid="step-report-finding-body"
          className="mt-1 whitespace-pre-wrap break-words text-[#00FF41]/85"
        >
          {body}
        </div>
      )}
    </li>
  );
}

export default function StepReportView({ raw }: StepReportViewProps) {
  const report = parseStepReport(raw);

  if (report === null) {
    return (
      <pre
        data-testid="step-report-raw"
        className="overflow-x-auto whitespace-pre-wrap break-words border border-[#008F11] bg-[#000200] p-2 font-mono text-xs text-[#00FF41]/80"
      >
        {prettyRaw(raw)}
      </pre>
    );
  }

  const status = STATUS_META[report.status];
  const execution = report.execution;

  return (
    <div data-testid="step-report" className="space-y-3">
      <div>
        <span
          data-testid="step-report-status"
          className={`inline-flex items-center border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${status.className}`}
        >
          {status.label}
        </span>
      </div>

      {report.pr_error && (
        <div
          role="alert"
          data-testid="step-report-pr-error"
          className="border border-[#FF0033] bg-[#2A0008] px-2 py-1 text-xs font-medium text-[#FF0033]"
        >
          ⚠ MR/ветка не созданы: {report.pr_error}
        </div>
      )}

      {report.summary.trim() !== '' && (
        <div
          data-testid="step-report-summary"
          className="text-sm text-[#00FF41]/85"
        >
          <AgentMarkdown>{report.summary}</AgentMarkdown>
        </div>
      )}

      {execution && (
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
            {typeof execution.executors === 'number' && (
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
            {execution.decomposition && execution.decomposition.length > 0 && (
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
            {execution.mode === 'stages' &&
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
                        {stage.name ?? `Этап ${i + 1}`}
                        {typeof stage.executors === 'number'
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