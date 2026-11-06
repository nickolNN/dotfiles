import type { StepReportFinding } from '@issue-resolver/shared';
import { SEVERITY_CLASS, UNKNOWN_SEVERITY_CLASS } from './meta';

export default function FindingRow({
  finding,
}: {
  finding: StepReportFinding;
}) {
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