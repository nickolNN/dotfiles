import {
  isBlockingFinding,
  type PipelineStep,
  type StepReport,
  type StepReportFinding,
} from '@issue-resolver/shared';

const MAX_FEEDBACK_FINDINGS = 20;

/** Blockers are never cut; the remaining room goes to non-blocking findings. */
function feedbackFindings(findings: readonly StepReportFinding[]): {
  shown: StepReportFinding[];
  omitted: number;
} {
  const blocking = findings.filter(isBlockingFinding);
  const nonBlocking = findings.filter((finding) => !isBlockingFinding(finding));
  const room = Math.max(0, MAX_FEEDBACK_FINDINGS - blocking.length);
  const shownNonBlocking = nonBlocking.slice(0, room);
  return {
    shown: [...blocking, ...shownNonBlocking],
    omitted: nonBlocking.length - shownNonBlocking.length,
  };
}

export function previousAttemptFeedback(
  step: PipelineStep,
  report: StepReport | null,
): string | null {
  if (report === null) return null;
  const lines = [`Previous ${step} attempt FAILED.`];
  const summary = report.summary.trim();
  if (summary.length > 0) lines.push(`Summary: ${summary}`);
  const findings = report.findings ?? [];
  if (findings.length > 0) {
    lines.push('', 'Findings from that attempt — close each of them first:');
    const { shown, omitted } = feedbackFindings(findings);
    for (const finding of shown) {
      const title = finding.title ?? finding.description ?? '(untitled)';
      const detail = finding.detail ? ` — ${finding.detail}` : '';
      lines.push(`- [${finding.severity}] ${title}${detail}`);
    }
    if (omitted > 0) {
      lines.push(
        `- … ${omitted} more non-blocking findings in that attempt's report`,
      );
    }
  }
  return lines.join('\n');
}