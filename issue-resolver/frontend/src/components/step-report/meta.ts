import { FindingSeverity, StepReportStatus } from '@issue-resolver/shared';

export const SECTION_HEADER =
  'mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50';

export const STATUS_META: Record<
  StepReportStatus,
  { label: string; textClass: string; badgeClass: string }
> = {
  [StepReportStatus.pass]: {
    label: 'PASS',
    textClass: 'text-[#00FF41]',
    badgeClass: 'border-[#00FF41]/60 bg-[#003B00]',
  },
  [StepReportStatus.fail]: {
    label: 'FAIL',
    textClass: 'text-[#FF0033]',
    badgeClass: 'border-[#FF0033]/60 bg-[#2A0008]',
  },
  [StepReportStatus.blocked]: {
    label: 'BLOCKED',
    textClass: 'text-[#FFB000]',
    badgeClass: 'border-[#FFB000]/60 bg-[#1A1000]',
  },
};

export const SEVERITY_CLASS: Partial<Record<string, string>> = {
  [FindingSeverity.info]: 'text-[#8A8A8A]',
  [FindingSeverity.low]: 'text-[#00FF41]',
  [FindingSeverity.minor]: 'text-[#00B4FF]',
  [FindingSeverity.major]: 'text-[#FFB000]',
  [FindingSeverity.critical]: 'text-[#FF0033]',
};

export const UNKNOWN_SEVERITY_CLASS = 'text-[#8A8A8A]';

